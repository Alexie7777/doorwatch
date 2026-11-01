import { EventEmitter } from 'node:events';

/**
 * SSE(Severe-Sent Events)推送中心。
 *
 * 看板用 SSE 而不是轮询:
 *   - 门开/关是低频事件,轮询纯属浪费手机流量
 *   - SSE 自带断线重连,手机上锁屏再解锁就自动接上
 */
class SseHub extends EventEmitter {
  constructor() {
    super();
    /** @type {Set<{res: import('node:http').ServerResponse}>} */
    this.clients = new Set();
  }

  add(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  get size() {
    return this.clients.size;
  }
}

export const sseHub = new SseHub();
