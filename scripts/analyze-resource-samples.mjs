/**
 * 按进程拆分资源采样，定位慢速增长到底来自哪个进程。
 *
 * 只读打开数据库，可以在应用运行时跑，不会干扰正在进行的采样。
 * 需要 0.3.16 及以上（schema v10 起才有 resource_process_samples 表）。
 *
 * 关键点：这类进程的内存形态通常是"平台 + 阶跃"——某次操作让缓存一次性涨上去，
 * 然后长期持平。对这样的序列直接回归会得出没有意义的斜率，所以脚本先把
 * 超过阈值的阶跃剥离，剩下的残余趋势（漂移）才是判断泄漏要看的量。
 *
 * 用法：
 *   node scripts/analyze-resource-samples.mjs
 *   node scripts/analyze-resource-samples.mjs --quiet
 *   node scripts/analyze-resource-samples.mjs --from "2026-10-12 12:00" --to "2026-10-13 09:00"
 *   node scripts/analyze-resource-samples.mjs --json
 *
 * 时间参数按北京时间解释；工作集低于 quiet-below 视为窗口不活跃。
 */
import path from 'node:path';
import Database from 'better-sqlite3';

const MB = 1024 * 1024;
/** 工作集低于这个值视为窗口不活跃，沿用之前分析里的经验阈值。 */
const QUIET_WORKING_SET_MB = 200;
/** 相邻采样间超过这个幅度才算阶跃，低于它按噪声处理。实测平稳期波动小于 1MB。 */
const STEP_THRESHOLD_MB = 5;
/** 少于这么多次采样的角色不做趋势判断。 */
const MIN_SAMPLES = 5;
/** 漂移要同时满足斜率和拟合度才写进结论。 */
const CONCLUSIVE_DRIFT_MB_PER_HOUR = 0.5;
const CONCLUSIVE_R2 = 0.5;
/** 太短的窗口得出的斜率会剧烈波动，不放进结论。 */
const CONCLUSIVE_HOURS = 2;
/** 前后半段对比至少要这么长的窗口才有意义。 */
const HALVES_MIN_HOURS = 1;

function parseArgs(argv) {
  const options = {
    dbPath: null, from: null, to: null, quiet: false, json: false, help: false,
    skipWarmupMinutes: 15, quietBelowMB: QUIET_WORKING_SET_MB,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.dbPath = argv[(index += 1)];
    else if (arg === '--from') options.from = argv[(index += 1)];
    else if (arg === '--to') options.to = argv[(index += 1)];
    else if (arg === '--skip-warmup') options.skipWarmupMinutes = Number(argv[(index += 1)]);
    else if (arg === '--quiet-below') options.quietBelowMB = Number(argv[(index += 1)]);
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 输入按北京时间解释；已经带时区的输入原样使用。 */
function parseBeijingTime(text, label) {
  const trimmed = String(text).trim();
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const normalized = hasZone ? trimmed : `${trimmed.replace(' ', 'T')}+08:00`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new Error(`${label} 不是有效时间：${text}`);
  return ms;
}

const at = (iso) => Date.parse(iso);
const beijing = (iso) => new Date(at(iso) + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
const mb = (bytes) => bytes / MB;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** 最小二乘拟合，x 为距段起点的累计小时数。 */
function linearFit(points) {
  const count = points.length;
  if (count < 2) return { slope: 0, r2: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let num = 0;
  let den = 0;
  let ssTot = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    num += dx * (y - meanY);
    den += dx * dx;
    ssTot += (y - meanY) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  for (const [x, y] of points) ssRes += (y - (intercept + slope * x)) ** 2;
  return { slope, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/**
 * 从序列里剥离阶跃，返回干净的平台残差。
 * 剥离后剩下的趋势才代表持续增长，而不是"涨上去就停住"。
 */
function removeSteps(values) {
  let stepCount = 0;
  let stepTotal = 0;
  let removed = 0;
  const adjusted = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (Math.abs(delta) >= STEP_THRESHOLD_MB * MB) {
      stepCount += 1;
      stepTotal += delta;
      removed += delta;
    }
    adjusted.push(values[index] - removed);
  }
  return { stepCount, stepTotalMB: mb(stepTotal), adjusted };
}

/**
 * 按父进程判断它在整棵树里的角色。
 * PID 每次重启都会变，但角色名稳定，可以跨运行段比较。
 */
function roleOf(process, parents) {
  const name = process.process_name;
  const parentName = parents.get(process.parent_process_id)?.process_name ?? '';
  if (name === 'CPEMonitor') return '宿主 CPEMonitor';
  if (name === 'node') return parentName === 'CPEMonitor' ? '内置后台 node' : '其它 node';
  if (name === 'msedgewebview2') {
    if (parentName === 'CPEMonitor') return 'WebView2 主进程';
    if (parentName === 'msedgewebview2') return 'WebView2 子进程';
    return 'WebView2 其它';
  }
  if (name === 'conhost') return 'conhost';
  return `其它 ${name}`;
}

/** 按 uptime 回落切分运行段，与之前的分析口径一致。 */
function splitSegments(aggregates) {
  const segments = [];
  let current = null;
  for (const row of aggregates) {
    if (!current || row.uptime_seconds < current.lastUptime - 5) {
      current = { rows: [row], lastUptime: row.uptime_seconds };
      segments.push(current);
    } else {
      current.rows.push(row);
      current.lastUptime = row.uptime_seconds;
    }
  }
  for (const segment of segments) {
    const rows = segment.rows;
    segment.start = rows[0].sampled_at;
    segment.end = rows[rows.length - 1].sampled_at;
    segment.spanHours = (at(segment.end) - at(segment.start)) / 3600000;
  }
  return segments;
}

/**
 * series 是先按「采样 × 角色」求和之后的时间序列。
 * 必须先求和再分析：同一角色可能同时有多个进程（WebView2 常有五个子进程），
 * 按进程行处理会被进程增减干扰。
 */
function summarizeRole(series) {
  const sorted = [...series].sort((a, b) => at(a.sampledAt) - at(b.sampledAt));
  const values = sorted.map((entry) => entry.privateBytes);
  const base = at(sorted[0].sampledAt);
  const hours = sorted.map((entry) => (at(entry.sampledAt) - base) / 3600000);

  const { stepCount, stepTotalMB, adjusted } = removeSteps(values);
  const raw = linearFit(hours.map((hour, index) => [hour, values[index]]));
  const drift = linearFit(hours.map((hour, index) => [hour, adjusted[index]]));

  const middle = Math.floor(hours.length / 2);
  const canCompareHalves = middle >= 3 && hours.length - middle >= 3;
  const halfSlope = (from, to) => linearFit(
    hours.slice(from, to).map((hour, index) => [hour, adjusted[from + index]]),
  ).slope / MB;

  const edge = values.length < 3 ? 1 : Math.max(1, Math.round(values.length * 0.1));
  return {
    sampleCount: sorted.length,
    processRows: sorted.reduce((sum, entry) => sum + entry.processCount, 0),
    firstProcesses: sorted[0].processCount,
    lastProcesses: sorted[sorted.length - 1].processCount,
    firstMB: mb(values[0]),
    lastMB: mb(values[values.length - 1]),
    minMB: mb(Math.min(...values)),
    maxMB: mb(Math.max(...values)),
    meanMB: mb(mean(values)),
    // 首尾各一成采样的差，抗单个尖峰
    deltaMB: mb(mean(values.slice(-edge)) - mean(values.slice(0, edge))),
    rawSlopeMBPerHour: raw.slope / MB,
    rawR2: raw.r2,
    stepCount,
    stepTotalMB,
    driftMBPerHour: drift.slope / MB,
    driftR2: drift.r2,
    driftFirstHalfMBPerHour: canCompareHalves ? halfSlope(0, middle) : null,
    driftSecondHalfMBPerHour: canCompareHalves ? halfSlope(middle, hours.length) : null,
    spanHours: hours[hours.length - 1],
  };
}

/** 把一次采样的所有进程按角色聚合成「该角色本次的合计」。 */
function aggregateByRole(rows) {
  const parents = new Map(rows.map((row) => [row.process_id, row]));
  const totals = new Map();
  for (const row of rows) {
    const role = roleOf(row, parents);
    const bucket = totals.get(role) ?? { privateBytes: 0, processCount: 0 };
    bucket.privateBytes += row.private_bytes;
    bucket.processCount += 1;
    totals.set(role, bucket);
  }
  return totals;
}

function signed(value, digits = 1) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/** 用前后半段斜率给一句判断，避免读的人自己从数字里猜。 */
function halveVerdict(first, second) {
  const FLAT = 0.2;
  const firstFlat = Math.abs(first) < FLAT;
  const secondFlat = Math.abs(second) < FLAT;
  if (firstFlat && secondFlat) return '两半段都基本持平';
  if (firstFlat) return second > 0 ? '前半段持平，后半段转升' : '前半段持平，后半段转降';
  if (secondFlat) return '后半段回到持平，趋于收敛';
  if (first > 0 && second > 0) {
    return second < first * 0.5 ? '后半段明显小于前半段，趋于收敛' : '两半段都在涨，尚未收敛';
  }
  if (first < 0 && second < 0) {
    return second > first * 0.5 ? '降幅在收窄' : '两半段都在降';
  }
  if (first > 0 && second < 0) return '后半段由升转降，趋于收敛';
  return '后半段由降转升，需要继续观察';
}

function roleLine(role, summary) {
  const processes = summary.firstProcesses === summary.lastProcesses
    ? `${summary.firstProcesses}`
    : `${summary.firstProcesses}→${summary.lastProcesses}`;
  return `  ${role.padEnd(16)} 采样 ${String(summary.sampleCount).padStart(4)}  进程 ${processes.padStart(4)}  `
    + `净 ${signed(summary.deltaMB).padStart(7)}MB  `
    + `阶跃 ${String(summary.stepCount).padStart(2)} 次/${signed(summary.stepTotalMB).padStart(7)}MB  `
    + `漂移 ${(summary.driftMBPerHour >= 0 ? '+' : '')}${summary.driftMBPerHour.toFixed(3).padStart(7)} MB/时 R² ${summary.driftR2.toFixed(2)}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node scripts/analyze-resource-samples.mjs [--db 路径] [--from 时间] [--to 时间] [--quiet] [--quiet-below MB] [--skip-warmup 分钟] [--json]');
    return;
  }

  const dbPath = options.dbPath
    ?? path.join(process.env.APPDATA ?? '', 'com.cpeye.monitor', 'data', 'cpe-monitor.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const hasProcessTable = db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'resource_process_samples'",
    ).get().count === 1;
    if (!hasProcessTable) {
      console.log('数据库里没有 resource_process_samples 表。该表由 0.3.16（schema v10）起创建，请先安装 0.3.16 canary 并等待采样。');
      return;
    }

    const aggregates = db.prepare(
      `SELECT sampled_at, process_count, working_set_bytes, private_bytes, handles, threads, uptime_seconds
       FROM resource_samples ORDER BY sampled_at`,
    ).all();
    const workingSetBySample = new Map(aggregates.map((row) => [row.sampled_at, row.working_set_bytes]));

    const fromMs = options.from ? parseBeijingTime(options.from, '--from') : null;
    const toMs = options.to ? parseBeijingTime(options.to, '--to') : null;
    const inWindow = (sampledAt) => {
      const ms = at(sampledAt);
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
      if (options.quiet && (workingSetBySample.get(sampledAt) ?? Infinity) / MB >= options.quietBelowMB) return false;
      return true;
    };

    const processRows = db.prepare(
      `SELECT sampled_at, process_id, parent_process_id, process_name, private_bytes, handles
       FROM resource_process_samples ORDER BY sampled_at`,
    ).all();
    if (processRows.length === 0) {
      console.log('还没有单进程明细数据。0.3.16 canary 每 60 秒写入一批，等一两分钟再试。');
      return;
    }

    const bySample = new Map();
    for (const row of processRows) {
      if (!bySample.has(row.sampled_at)) bySample.set(row.sampled_at, []);
      bySample.get(row.sampled_at).push(row);
    }

    // 完整性核对：同一次采样里，明细合计是否等于汇总行。
    let maxPrivateGapMB = 0;
    let maxHandlesGap = 0;
    let checkedSamples = 0;
    for (const aggregate of aggregates) {
      const rows = bySample.get(aggregate.sampled_at);
      if (!rows) continue;
      checkedSamples += 1;
      const privateSum = rows.reduce((sum, row) => sum + row.private_bytes, 0);
      const handlesSum = rows.reduce((sum, row) => sum + row.handles, 0);
      maxPrivateGapMB = Math.max(maxPrivateGapMB, Math.abs(mb(privateSum - aggregate.private_bytes)));
      maxHandlesGap = Math.max(maxHandlesGap, Math.abs(handlesSum - aggregate.handles));
    }

    const report = { dbPath, detailRows: processRows.length, checkedSamples, maxPrivateGapMB, maxHandlesGap, segments: [] };

    for (const [index, segment] of splitSegments(aggregates).entries()) {
      // 启动后一段时间内存和句柄都在爬升，属于瞬态而非稳态，
      // 默认跳过前 15 分钟，否则会把启动开销误判成增长。
      const warmupMs = Number.isFinite(options.skipWarmupMinutes) ? options.skipWarmupMinutes * 60000 : 0;
      const eligible = segment.rows
        .map((row) => row.sampled_at)
        .filter((sampledAt) => inWindow(sampledAt) && bySample.has(sampledAt));
      const sampledTimes = eligible.filter((sampledAt) => at(sampledAt) - at(segment.start) >= warmupMs);

      if (sampledTimes.length === 0) {
        report.segments.push({
          index: index + 1,
          start: beijing(segment.start),
          end: beijing(segment.end),
          spanHours: segment.spanHours,
          analysedSamples: 0,
          note: eligible.length === 0 ? '该段没有单进程明细（0.3.16 之前）' : '该段样本都被过滤条件排除',
        });
        continue;
      }

      const roleSeries = new Map();
      for (const sampledAt of sampledTimes) {
        for (const [role, totals] of aggregateByRole(bySample.get(sampledAt))) {
          if (!roleSeries.has(role)) roleSeries.set(role, []);
          roleSeries.get(role).push({ sampledAt, ...totals });
        }
      }

      const roles = [...roleSeries.entries()]
        .map(([role, series]) => ({ role, summary: summarizeRole(series) }))
        .sort((a, b) => b.summary.deltaMB - a.summary.deltaMB);
      const totalDelta = roles.reduce((sum, item) => sum + item.summary.deltaMB, 0);
      const attribution = roles
        .filter((item) => Math.abs(item.summary.deltaMB) > 0.5)
        .map((item) => ({
          role: item.role,
          deltaMB: item.summary.deltaMB,
          share: totalDelta === 0 ? 0 : item.summary.deltaMB / totalDelta,
        }));

      report.segments.push({
        index: index + 1,
        start: beijing(segment.start),
        end: beijing(segment.end),
        spanHours: segment.spanHours,
        analysedSamples: sampledTimes.length,
        warmupDropped: eligible.length - sampledTimes.length,
        totalDeltaMB: totalDelta,
        roles,
        attribution,
      });
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const analysed = aggregates.filter((row) => inWindow(row.sampled_at) && bySample.has(row.sampled_at));
    console.log(`数据库：${dbPath}`);
    console.log(`有单进程明细的采样：${analysed.length} 次，明细 ${processRows.length} 行`
      + (options.quiet ? `（仅低占用采样，工作集 < ${options.quietBelowMB}MB）` : ''));
    if (analysed.length > 0) {
      console.log(`明细时间范围：${beijing(analysed[0].sampled_at)} → ${beijing(analysed[analysed.length - 1].sampled_at)}（北京时间）`);
    }
    console.log(`完整性核对：${checkedSamples} 次采样中，明细合计与汇总行最大偏差 ${maxPrivateGapMB.toFixed(1)}MB 私有提交、${maxHandlesGap} 个句柄`);
    if (maxPrivateGapMB > 1 || maxHandlesGap > 0) {
      console.log('  偏差非零说明同一次采样没有完整落库，下列结论需要谨慎。');
    }
    console.log(`口径：净变化取首尾各一成采样的差；阶跃指相邻采样间 ≥${STEP_THRESHOLD_MB}MB 的突变；漂移是剥离阶跃后的残余趋势，判断泄漏看漂移。`);

    for (const segment of report.segments) {
      console.log(`\n=== 运行段 ${segment.index}　${segment.start} → ${segment.end}　跨度 ${segment.spanHours.toFixed(1)} 小时 ===`);
      if (segment.analysedSamples === 0) {
        console.log(`  ${segment.note}`);
        continue;
      }
      console.log(`  参与采样 ${segment.analysedSamples} 次${segment.warmupDropped > 0 ? `（已跳过启动预热 ${segment.warmupDropped} 次）` : ''}`);
      for (const item of segment.roles) console.log(roleLine(item.role, item.summary));
      console.log(`  各角色净变化合计 ${signed(segment.totalDeltaMB)}MB`);
      if (segment.attribution.length > 0) {
        console.log('  增长归因：');
        for (const item of segment.attribution) {
          console.log(`    ${item.role.padEnd(16)} ${signed(item.deltaMB).padStart(7)}MB　占合计 ${(item.share * 100).toFixed(0)}%`);
        }
      }
    }

    const withDetail = report.segments.filter((segment) => segment.analysedSamples > 0);
    const last = withDetail[withDetail.length - 1];
    console.log('\n=== 结论 ===');
    if (!last) {
      console.log('  还没有任何可分析的运行段。');
      return;
    }

    const movers = last.roles
      .filter((item) => item.summary.sampleCount >= MIN_SAMPLES && Math.abs(item.summary.deltaMB) > 1)
      .slice(0, 4);
    for (const item of movers) {
      const summary = item.summary;
      const steps = summary.stepCount > 0
        ? `净变化由 ${summary.stepCount} 次阶跃贡献 ${signed(summary.stepTotalMB)}MB`
        : '无阶跃';
      const drift = Math.abs(summary.driftMBPerHour) < CONCLUSIVE_DRIFT_MB_PER_HOUR || summary.driftR2 < CONCLUSIVE_R2
        ? '剔除阶跃后没有持续趋势'
        : `剔除阶跃后仍有 ${signed(summary.driftMBPerHour, 3)} MB/时 的持续${summary.driftMBPerHour > 0 ? '增长' : '下降'}（R² ${summary.driftR2.toFixed(2)}）`;
      console.log(`  ${item.role.padEnd(16)} ${steps}；${drift}`);
    }

    if (last.spanHours >= HALVES_MIN_HOURS) {
      const drifting = movers.filter((item) => item.summary.driftFirstHalfMBPerHour !== null);
      if (drifting.length > 0) {
        console.log('  残余漂移的前后半段对比：');
        for (const item of drifting) {
          const summary = item.summary;
          const first = summary.driftFirstHalfMBPerHour;
          const second = summary.driftSecondHalfMBPerHour;
          console.log(`    ${item.role.padEnd(16)} 前半段 ${signed(first, 3)}　后半段 ${signed(second, 3)} MB/时　${halveVerdict(first, second)}`);
        }
      }
    }

    if (last.spanHours < CONCLUSIVE_HOURS) {
      console.log(`  最新运行段只有 ${(last.spanHours * 60).toFixed(0)} 分钟，不足 ${CONCLUSIVE_HOURS} 小时，先不给最终结论。`);
      return;
    }
    const leaks = last.roles.filter((item) => item.summary.sampleCount >= MIN_SAMPLES
      && item.summary.driftMBPerHour > CONCLUSIVE_DRIFT_MB_PER_HOUR
      && item.summary.driftR2 > CONCLUSIVE_R2);
    if (leaks.length === 0) {
      console.log('  最新运行段里没有任何角色存在持续漂移，净变化都能用阶跃解释。');
    } else {
      console.log('  存在持续漂移的角色（这才是需要继续观察的）：');
      for (const item of leaks) {
        console.log(`    ${item.role.padEnd(16)} ${signed(item.summary.driftMBPerHour, 3)} MB/时　R² ${item.summary.driftR2.toFixed(2)}　段内净增 ${signed(item.summary.deltaMB)}MB`);
      }
    }
  } finally {
    db.close();
  }
}

main();
