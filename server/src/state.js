import { config } from './config.js';

/**
 * 状态机 —— 这个项目的核心正确性所在。
 *
 * 三种「有效状态」(effective state):
 *   open    门开着,IT 有人
 *   closed  门关着,IT 不在
 *   unknown 传感器离线 / 没上报过 / 报文无法识别 —— 不知道
 *
 * 为什么必须有 unknown:
 *   门磁挂掉之后,传感器会保持最后一次上报的状态。如果直接把这个状态显示出来,
 *   一旦最后一次上报是 "closed",那传感器死了整整一周,看板都显示"已关门"。
 *   用户一看"关门"就更不会来了 —— 系统反而在最需要它的时候彻底失效。
 *
 *   所以:只有确认传感器活着(有心跳)且状态合法,才敢显示 open/closed;
 *   其余一律 unknown,看板用醒目颜色提示"状态未知,请先联系 IT"。
 */

export const STATES = Object.freeze(['open', 'closed', 'unknown']);

/**
 * 明确表示"我不知道"的写法。
 *
 * 这不是垃圾值,而是数据源在明确说"我读不到"。
 * Home Assistant 的模板在传感器失联时会输出 UNKNOWN,
 * 实体本身变成 unavailable 时也会输出 unavailable。
 *
 * ★ 这里必须和"看不懂的值"区分开:
 *   - UNKNOWN  -> 门的状态就是未知,必须打回 unknown
 *   - 垃圾值    -> 设备还活着但这包看不懂,属于异常,记日志待查
 * 以前两者都被当成 null 扔掉,只刷新心跳不改状态 ——
 * 于是传感器已经死了,看板还在一直显示上次的"门开着"。
 */
export const UNKNOWN_MARKERS = Object.freeze([
  'unknown',
  'unavailable',
  'none',
  'null',
  'offline',
  'error',
  'stale',
  'unreachable',
]);

/**
 * 把传感器发来的各种写法归一化。
 * @returns {'open'|'closed'|'unknown'|null}
 *          null = 完全看不懂的值(异常,不是"不知道")
 */
export function normalizeState(payload) {
  if (payload === null || payload === undefined) return null;
  const p = String(payload).trim().toLowerCase();
  if (['open', 'opened', 'on', 'true', '1', 'yes', 'present', 'detected'].includes(p)) return 'open';
  if (['closed', 'close', 'off', 'false', '0', 'no', 'absent', 'cleared'].includes(p)) return 'closed';
  if (UNKNOWN_MARKERS.includes(p)) return 'unknown';
  return null;
}

/**
 * 计算一扇门对外展示的"有效状态"。
 *
 * @param {object} door  doors 表的一行
 * @param {number} now   当前时间戳(ms)
 * @returns {'open'|'closed'|'unknown'}
 */
export function effectiveState(door, now = Date.now()) {
  if (!door) return 'unknown';

  // 人工置顶优先(例如全员出差,直接钉死成"别来")
  const override = activeOverride(door, now);
  if (override) return override;

  // 没上报过 -> 不知道
  if (!door.last_seen_at) return 'unknown';

  // 心跳超时 -> 传感器失联,即使有旧状态也不能信
  if (now - door.last_seen_at > config.onlineTimeoutMs) return 'unknown';

  // MQTT 遗嘱说离线 -> 不知道
  if (!door.online) return 'unknown';

  if (door.state === 'open' || door.state === 'closed') return door.state;
  return 'unknown';
}

/** 人工置顶是否仍然有效 */
export function activeOverride(door, now = Date.now()) {
  if (!door?.override_state) return null;
  if (door.override_state !== 'open' && door.override_state !== 'closed') return null;
  if (door.override_until && door.override_until <= now) return null;
  return door.override_state;
}

/** 传感器是否算在线(心跳未超时) */
export function isOnline(door, now = Date.now()) {
  if (!door?.last_seen_at) return false;
  if (now - door.last_seen_at > config.onlineTimeoutMs) return false;
  return Boolean(door.online);
}

/** 把 doors 表的一行转成前端要的形状 */
export function toPublic(door, now = Date.now()) {
  const state = effectiveState(door, now);
  const online = isOnline(door, now);
  const override = activeOverride(door, now);

  return {
    id: door.id,
    name: door.name,
    location: door.location,
    deviceId: door.device_id,
    state,
    online,
    overridden: Boolean(override),
    // 状态最后一次发生变化的时刻
    lastChangeAt: door.last_change_at,
    // 最后一次收到传感器消息的时刻
    lastSeenAt: door.last_seen_at,
    battery: door.battery ?? null,
    // 前端据此区分"时间被脱敏隐藏"和"本来就没有记录"
    timesHidden: config.hideTimes,
    hints: {
      open: door.open_hint,
      closed: door.closed_hint,
      unknown: '传感器没上线,状态未知 —— 请先联系 IT',
    },
    // 未脱敏时给时间,脱敏时只给 null
    lastChangeAtPublic: config.hideTimes ? null : door.last_change_at,
    lastSeenAtPublic: config.hideTimes ? null : door.last_seen_at,
  };
}
