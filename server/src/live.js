import { listDoors, todayStats, eventsSince } from './db.js';
import { toPublic } from './state.js';
import { sseHub } from './sse.js';

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 当前所有门的对外快照 */
export function currentSnapshot() {
  const now = Date.now();
  const since = startOfToday(now);
  return listDoors().map((d) => {
    const pub = toPublic(d, now);
    pub.stats = todayStats(d.id, now);
    pub.todayEvents = eventsSince(d.id, since);
    return pub;
  });
}

/** 状态变了就推给所有打开着的看板 */
export function pushState() {
  sseHub.broadcast('doors', currentSnapshot());
}
