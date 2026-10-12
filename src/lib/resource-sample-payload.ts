/**
 * 灰度版资源采样的单进程明细载荷校验。
 *
 * 明细是可选字段：宿主不上报、字段缺失或类型不对时退回空数组，
 * 让写入路径与升级前完全一致，避免旧宿主因为新字段被拒。
 */

/** 单次采样的进程数上限，避免异常载荷把表撑爆。 */
export const MAX_PROCESSES = 64;
export const MAX_PROCESS_NAME = 128;

export interface SanitizedProcess {
  processId: number;
  parentProcessId: number;
  processName: string;
  workingSetBytes: number;
  privateBytes: number;
  handles: number;
  threads: number;
  cpuSeconds: number;
}

function nonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * 逐条校验进程明细。缺名字或名字非法的条目单独丢弃，
 * 不因为一条脏数据丢掉整次采样，也不影响同批次的其它进程。
 */
export function sanitizeProcesses(value: unknown): SanitizedProcess[] {
  if (!Array.isArray(value)) return [];
  const result: SanitizedProcess[] = [];
  for (const entry of value.slice(0, MAX_PROCESSES)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item.processName === 'string'
      ? item.processName.trim().slice(0, MAX_PROCESS_NAME)
      : '';
    if (!name) continue;
    result.push({
      processId: nonNegative(item.processId) ?? 0,
      parentProcessId: nonNegative(item.parentProcessId) ?? 0,
      processName: name,
      workingSetBytes: nonNegative(item.workingSetBytes) ?? 0,
      privateBytes: nonNegative(item.privateBytes) ?? 0,
      handles: nonNegative(item.handles) ?? 0,
      threads: nonNegative(item.threads) ?? 0,
      cpuSeconds: nonNegative(item.cpuSeconds) ?? 0,
    });
  }
  return result;
}
