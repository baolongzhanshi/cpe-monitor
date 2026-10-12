import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROCESSES,
  MAX_PROCESS_NAME,
  sanitizeProcesses,
} from '../src/lib/resource-sample-payload.ts';

test('缺少或非法明细时退回空数组，保证旧宿主仍能写入', () => {
  assert.deepEqual(sanitizeProcesses(undefined), []);
  assert.deepEqual(sanitizeProcesses(null), []);
  assert.deepEqual(sanitizeProcesses('not-an-array'), []);
  assert.deepEqual(sanitizeProcesses({ processName: 'CPEMonitor' }), []);
  assert.deepEqual(sanitizeProcesses([]), []);
});

test('完整明细被原样保留', () => {
  const result = sanitizeProcesses([
    {
      processId: 61152,
      parentProcessId: 41380,
      processName: 'CPEMonitor',
      workingSetBytes: 15833497,
      privateBytes: 42061312,
      handles: 652,
      threads: 22,
      cpuSeconds: 93.8,
    },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    processId: 61152,
    parentProcessId: 41380,
    processName: 'CPEMonitor',
    workingSetBytes: 15833497,
    privateBytes: 42061312,
    handles: 652,
    threads: 22,
    cpuSeconds: 93.8,
  });
});

test('缺名字或名字非法的条目被单独丢弃，不影响同批其它进程', () => {
  const result = sanitizeProcesses([
    { processName: '   ' },
    { processName: '' },
    { processId: 1 },
    { processName: 12345 },
    null,
    'CPEMonitor',
    { processName: ' node ' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].processName, 'node');
});

test('负数和非法数字归零，不写进脏数据', () => {
  const result = sanitizeProcesses([
    {
      processName: 'node',
      processId: -5,
      parentProcessId: Number.NaN,
      workingSetBytes: -1,
      privateBytes: 'abc',
      handles: -100,
      threads: Number.POSITIVE_INFINITY,
      cpuSeconds: null,
    },
  ]);
  assert.equal(result.length, 1);
  const entry = result[0];
  assert.equal(entry.processId, 0);
  assert.equal(entry.parentProcessId, 0);
  assert.equal(entry.workingSetBytes, 0);
  assert.equal(entry.privateBytes, 0);
  assert.equal(entry.handles, 0);
  assert.equal(entry.threads, 0);
  assert.equal(entry.cpuSeconds, 0);
});

test('数值字符串被接受，便于宿主用宽松格式上报', () => {
  const result = sanitizeProcesses([
    { processName: 'node', processId: '42', privateBytes: '1024' },
  ]);
  assert.equal(result[0].processId, 42);
  assert.equal(result[0].privateBytes, 1024);
});

test('进程数与进程名都有上限，超出的被截断', () => {
  const many = Array.from({ length: MAX_PROCESSES + 10 }, (_, index) => ({
    processName: `p${index}`,
  }));
  assert.equal(sanitizeProcesses(many).length, MAX_PROCESSES);

  const longName = 'x'.repeat(MAX_PROCESS_NAME + 50);
  const [entry] = sanitizeProcesses([{ processName: longName }]);
  assert.equal(entry.processName.length, MAX_PROCESS_NAME);
});
