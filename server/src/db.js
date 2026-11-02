import { DatabaseSync } from 'node:sqlite';
import { paths, config } from './config.js';

/**
 * SQLite 存储层。
 *
 * 用 Node 24 内置的 node:sqlite,不需要 better-sqlite3 那种原生编译,
 * 换机器/换容器都是 npm i 即走,不会卡在编译工具链上。
 */

let db;

/** node:sqlite 只接受 null/number/bigint/string/Buffer,布尔要自己转 */
const bool01 = (v) => (v ? 1 : 0);

export function openDb(file = paths.db) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS doors (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      location       TEXT NOT NULL DEFAULT '',
      device_id      TEXT NOT NULL UNIQUE,
      open_hint      TEXT NOT NULL DEFAULT '',
      closed_hint    TEXT NOT NULL DEFAULT '',
      -- 运行时状态
      state          TEXT NOT NULL DEFAULT 'unknown',   -- open | closed | unknown
      online         INTEGER NOT NULL DEFAULT 0,
      last_change_at INTEGER,                            -- 上次开/关切换的时间
      last_seen_at   INTEGER,                            -- 上次收到传感器任何消息的时间
      battery        INTEGER,                            -- 电池百分比 0-100(NULL = 不知道)
      battery_at     INTEGER,                            -- 最后一次读到电量的时间
      override_state TEXT,                               -- 人工置顶: open | closed | null
      override_until INTEGER,                            -- 人工置顶的失效时间,NULL 表示不过期
      updated_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      door_id    TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_door_at ON events(door_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
  `);

  // ------------------------------------------------------------------
  //  迁移:老库补列
  //
  //  CREATE TABLE IF NOT EXISTS 对**已存在**的表不会做任何事,
  //  所以新加的列在老库上根本不会出现 —— 那张 doors 表还停在旧结构,
  //  后面 UPDATE ... SET battery = ? 直接报 "no such column"。
  //
  //  这里显式查一遍表结构,缺哪列补哪列。幂等,反复跑没副作用。
  // ------------------------------------------------------------------
  const cols = db.prepare('PRAGMA table_info(doors)').all().map((c) => c.name);
  for (const [name, ddl] of [['battery', 'INTEGER'], ['battery_at', 'INTEGER']]) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE doors ADD COLUMN ${name} ${ddl}`);
      console.log(`[db] 已给 doors 表补上 ${name} 列`);
    }
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('数据库还没打开');
  return db;
}

/**
 * 同步登记表。只写静态档案字段,绝不覆盖运行时状态,
 * 否则每次重启服务都会把"门开着"冲成 unknown。
 */
export function syncRegistry(doors) {
  const now = Date.now();
  const stmt = getDb().prepare(`
    INSERT INTO doors (id, name, location, device_id, open_hint, closed_hint, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name      = excluded.name,
      location  = excluded.location,
      device_id = excluded.device_id,
      open_hint = excluded.open_hint,
      closed_hint = excluded.closed_hint,
      updated_at = excluded.updated_at
  `);
  for (const d of doors) {
    stmt.run(d.id, d.name, d.location, d.deviceId, d.openHint, d.closedHint, now);
  }
}

/** 登记的传感器还没上报过状态时,也要能查出来 */
export function ensureKnown(doors) {
  syncRegistry(doors);
}

export function listDoors() {
  return getDb().prepare('SELECT * FROM doors ORDER BY rowid ASC').all();
}

export function getDoor(id) {
  return getDb().prepare('SELECT * FROM doors WHERE id = ?').get(id) ?? null;
}

export function getDoorByDevice(deviceId) {
  return getDb().prepare('SELECT * FROM doors WHERE device_id = ?').get(deviceId) ?? null;
}

/**
 * 记录一次状态变化。
 *
 * 只有真正发生 open<->closed 切换时才算"变化",重复上报同状态只刷新心跳时间。
 *
 * @param {boolean} fresh
 *   true  = 设备刚发来的新消息,可以算"还活着"(刷新 online / last_seen_at)
 *   false = broker 重放的 retained 旧消息,只是历史数据,
 *           **不能**拿来证明设备活着 —— 否则服务端一重启,
 *           看板会把几天前的旧状态当成"刚刚读到的",重新活过来。
 * @returns {{door: object, changed: boolean}}
 */
export function recordState(deviceId, state, at = Date.now(), { fresh = true } = {}) {
  const door = getDoorByDevice(deviceId);
  if (!door) return { door: null, changed: false };

  const changed = door.state !== state;
  const lastChangeAt = changed ? at : door.last_change_at;
  const online = fresh ? 1 : door.online;
  const lastSeen = fresh ? at : door.last_seen_at;

  getDb()
    .prepare(
      `UPDATE doors
          SET state = ?, online = ?, last_change_at = ?, last_seen_at = ?, updated_at = ?
        WHERE device_id = ?`,
    )
    .run(state, online, lastChangeAt, lastSeen, at, deviceId);

  if (changed) {
    getDb()
      .prepare(
        `INSERT INTO events (door_id, device_id, from_state, to_state, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(door.id, deviceId, door.state, state, at);
  }

  return { door: getDoor(idOf(door)) ?? getDoorByDevice(deviceId), changed };
}

function idOf(door) {
  return door.id;
}

/** 刷新心跳时间(收到任何消息都算"设备还活着") */
export function recordSeen(deviceId, at = Date.now()) {
  getDb()
    .prepare(
      `UPDATE doors SET last_seen_at = ?, online = 1, updated_at = ?
        WHERE device_id = ?`,
    )
    .run(at, at, deviceId);
}

/**
 * 记录一次电量读数。
 *
 * ★ 这里**故意不动** state / online / last_seen_at:
 *   电量是"顺便报一下的",不是"门状态刚刚读到过"的证明。
 *   要是把它算进心跳,一台电池耗尽、门磁早就不动的设备,
 *   只要还有人报电量,看板就会一直显示"传感器在线 + 门关着" ——
 *   那是在撒谎,正是这个项目最要避免的事。
 *
 *   电量过期不认,交给 state.js 的 effectiveBattery() 判断。
 *
 * @param {number} level 电量百分比 0-100
 * @param {boolean} fresh
 *   true  = 设备刚发来的新读数,可以记"什么时候读到的"。
 *   false = broker 重放的 retained 旧消息 —— **只更新数字,不更新时间戳**。
 *           我们没法知道那条 retained 消息是什么时候读到的,
 *           写上 now 就是拿一个过期读数冒充新的。
 *           (状态那边的 recordState 已经是同样的处理:重放只更新值,不算存活。)
 */
export function recordBattery(deviceId, level, at = Date.now(), { fresh = true } = {}) {
  const door = getDoorByDevice(deviceId);
  if (!door) return { door: null, changed: false };

  const prevAt = door.battery_at ?? null;
  // 重放的旧消息:保留原来那个真实的时间戳,不要动它。
  const nextAt = fresh ? at : prevAt;

  // 值变了,或者以前压根没有时间戳(以前 effectiveBattery 一直是 null,
  // 现在有真实时间戳了,看板上的徽章会从"不显示"变成"显示")—— 都算变化。
  const changed = door.battery !== level || prevAt == null;

  getDb()
    .prepare('UPDATE doors SET battery = ?, battery_at = ?, updated_at = ? WHERE device_id = ?')
    .run(level, nextAt, at, deviceId);

  return { door: getDoorByDevice(deviceId), changed };
}

/**
 * 记录一次"我不知道"。
 *
 * 传感器侧明确说读不到(上报 UNKNOWN / unavailable / offline),
 * 这时候必须把状态打回 unknown 并且标记为离线 ——
 * 绝不能继续留着上一次的开/关。那样等于在撒谎:
 * 门磁电池耗尽之后,看板会一直显示"门开着",谁都不会再来问。
 *
 * 恢复条件只有一个:之后收到一个合法的 open/closed,recordState 会把
 * online 重新置 1,状态自然回到正常。
 */
export function recordUnknown(deviceId, at = Date.now(), { fresh = true } = {}) {
  const door = getDoorByDevice(deviceId);
  if (!door) return { door: null, changed: false };

  const changed = door.state !== 'unknown';
  // 历史消息(重放的 retained)不能刷新心跳时间,
  // 但把状态打回 unknown 是安全的 —— 宁可说不知道。
  const online = fresh ? 0 : door.online;
  const lastSeen = fresh ? at : door.last_seen_at;

  getDb()
    .prepare(
      `UPDATE doors
          SET state = 'unknown', online = ?, last_seen_at = ?, updated_at = ?
        WHERE device_id = ?`,
    )
    .run(online, lastSeen, at, deviceId);

  if (changed) {
    getDb()
      .prepare(
        `INSERT INTO events (door_id, device_id, from_state, to_state, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(door.id, deviceId, door.state, 'unknown', at);
  }

  return { door: getDoorByDevice(deviceId), changed };
}

/** MQTT 遗嘱消息(offline) */
export function setOnline(deviceId, online, at = Date.now()) {
  getDb()
    .prepare('UPDATE doors SET online = ?, updated_at = ? WHERE device_id = ?')
    .run(bool01(online), at, deviceId);
}

/** 人工置顶/取消置顶 */
export function setOverride(doorId, state, until = null) {
  getDb()
    .prepare('UPDATE doors SET override_state = ?, override_until = ?, updated_at = ? WHERE id = ?')
    .run(state, until, Date.now(), doorId);
  return getDoor(doorId);
}

export function listEvents(doorId, limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return getDb()
    .prepare('SELECT * FROM events WHERE door_id = ? ORDER BY at DESC LIMIT ?')
    .all(doorId, n);
}

export function listRecentEvents(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return getDb()
    .prepare(
      `SELECT e.*, d.name AS door_name
         FROM events e JOIN doors d ON d.id = e.door_id
        ORDER BY e.at DESC LIMIT ?`,
    )
    .all(n);
}

/** 取某个时间点之后的事件,按时间正序(画 24 小时时间轴用) */
export function eventsSince(doorId, since, limit = 500) {
  return getDb()
    .prepare('SELECT * FROM events WHERE door_id = ? AND at >= ? ORDER BY at ASC LIMIT ?')
    .all(doorId, since, limit);
}

/** 今天的开关次数,用于看板上的小统计 */
export function todayStats(doorId, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const rows = getDb()
    .prepare(
      `SELECT to_state, at FROM events
        WHERE door_id = ? AND at >= ?
        ORDER BY at ASC`,
    )
    .all(doorId, start.getTime());
  const opens = rows.filter((r) => r.to_state === 'open').length;
  const closes = rows.filter((r) => r.to_state === 'closed').length;
  return { opens, closes, total: rows.length, first: rows[0]?.at ?? null, last: rows.at(-1)?.at ?? null };
}
