interface TrafficSchedulerStatus { running: boolean }

const shared = globalThis as typeof globalThis & {
  __cpeMonitorTrafficSchedulerStatus?: TrafficSchedulerStatus;
};

// Next 的不同路由包共享实际调度状态，实时服务无需反向引用调度器。
export function getTrafficSchedulerStatus(): TrafficSchedulerStatus {
  return shared.__cpeMonitorTrafficSchedulerStatus ??= { running: false };
}

export function setTrafficSchedulerRunning(running: boolean): void {
  getTrafficSchedulerStatus().running = running;
}
