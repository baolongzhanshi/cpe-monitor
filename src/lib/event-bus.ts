/**
 * Server-side event bus for broadcasting real-time updates to SSE clients.
 * Singleton EventEmitter shared across API routes and background services.
 */
import { EventEmitter } from 'events';

export interface CpeEvent {
  type: 'metrics' | 'alert' | 'collection' | 'connection';
  payload: Record<string, unknown>;
  timestamp: string;
}

class CpeEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  emit(event: 'message', data: CpeEvent): boolean;
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  broadcast(type: CpeEvent['type'], payload: Record<string, unknown>): void {
    const data: CpeEvent = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit('message', data);
  }
}

const shared = globalThis as typeof globalThis & { __cpeMonitorEventBus?: CpeEventBus };

// 路由和后台可能被 Next 编进不同模块，统一复用进程内的事件总线。
export const eventBus = shared.__cpeMonitorEventBus ??= new CpeEventBus();
