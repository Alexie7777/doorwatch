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

/**
 * 一扇门对外展示的电量。
 *
 * @returns {number|null} 0-100;null = 不知道电量
 *
 * ★ 和状态一样的原则:宁可说不知道,不要拿过期数据糊弄人。
 *   电量是"上一次读到的数"。设备可能三天前就没电了,
 *   而我们手里还留着它最后上报的 87% —— 那个数字早就没意义了。
 *   超过 batteryTimeoutMs(默认 7 天)就不认,返回 null。
 */
export function effectiveBattery(door, now = Date.now()) {
  if (!door || door.battery == null) return null;
  if (!door.battery_at) return null;
  if (now - door.battery_at > config.batteryTimeoutMs) return null;
  return door.battery;
}

/**
 * 「传感器没上线」时的默认提示语。
 * 以前是写死在这里的,现在挪到门禁登记表里,每扇门都能定制;
 * 没定制就还用这一句(见 server/src/doors.js 的 normalize)。
 */
export const DEFAULT_UNKNOWN_HINT = '传感器没上线,状态未知 —— 请先联系 IT';

/**
 * 英文界面的默认提示语。
 *
 * 英文那份的回落链是:unknown_hint_en → unknown_hint → 这一句。
 * 只有在登记表里**完全没写** unknown 提示时才会用到它 ——
 * 那时候连中文那句都没有,总不能给英文界面塞一句中文。
 */
export const DEFAULT_UNKNOWN_HINT_EN = 'Sensor offline, status unknown — please contact IT';

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
    // 电池电量(0-100);null = 不知道 / 读数已过期
    battery: effectiveBattery(door, now),
    // 最后一次读到电量的时刻
    batteryAt: door.battery_at ?? null,
    // 前端据此区分"时间被脱敏隐藏"和"本来就没有记录"
    timesHidden: config.hideTimes,
    // hints 保留不动(免得破坏已有测试和文档)
    hints: {
      open: door.open_hint,
      closed: door.closed_hint,
      unknown: door.unknown_hint || DEFAULT_UNKNOWN_HINT,
    },
    // ★ 中英两套文案一起下发,前端切语言时不用再问服务端要一次。
    //   英文那份**全部回退到中文**,保证任何时候都不会出现空白。
    i18n: {
      zh: {
        name: door.name,
        location: door.location,
        open: door.open_hint,
        closed: door.closed_hint,
        unknown: door.unknown_hint || DEFAULT_UNKNOWN_HINT,
      },
      en: {
        name: door.name_en || door.name,
        location: door.location_en || door.location,
        open: door.open_hint_en || door.open_hint,
        closed: door.closed_hint_en || door.closed_hint,
        unknown: door.unknown_hint_en || door.unknown_hint || DEFAULT_UNKNOWN_HINT_EN,
      },
    },
    // 未脱敏时给时间,脱敏时只给 null
    lastChangeAtPublic: config.hideTimes ? null : door.last_change_at,
    lastSeenAtPublic: config.hideTimes ? null : door.last_seen_at,
  };
}
