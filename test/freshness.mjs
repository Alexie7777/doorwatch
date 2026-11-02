#!/usr/bin/env node
/**
 * 「不许撒谎」这条底线的单元测试。
 *
 * 这里钉住这几条不变量:
 *   1. UNKNOWN / unavailable 是"我不知道",不是垃圾值
 *      → 必须让状态打回 unknown,而不是保留上次的开/关
 *   2. broker 重放的 retained 旧消息只是历史数据
 *      → 不能拿来证明"设备还活着",也不能把过期读数"洗"成新的
 *   3. 心跳只能证明"活着",不能复活一个已被打回 unknown 的状态
 *   4. 电量是"顺便报一下的",不刷新心跳、不改状态、不复活离线设备
 *
 * 这些是纯逻辑,不起服务,毫秒级跑完。
 *
 * 运行: node test/freshness.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, syncRegistry, getDoorByDevice, recordState, recordUnknown, recordSeen, recordBattery, setOnline, getDb } from '../server/src/db.js';
import { normalizeState, effectiveState, effectiveBattery, toPublic } from '../server/src/state.js';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doorwatch-fresh-'));
const DEVICE = 'it-office-door';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

try {
  openDb(path.join(DATA_DIR, 'test.db'));
  syncRegistry([
    { id: 'it-office', name: 'IT 办公室', location: '', deviceId: DEVICE, openHint: '', closedHint: '' },
    {
      id: 'server-room',
      name: '机房',
      location: '',
      deviceId: 'server-room-door',
      openHint: '',
      closedHint: '',
    },
  ]);

  // --- 1. 载荷归一化 ---
  console.log('\n[test] 载荷归一化');
  check('UNKNOWN 被识别为"不知道"', normalizeState('UNKNOWN') === 'unknown');
  check('unavailable 被识别为"不知道"', normalizeState('unavailable') === 'unknown');
  check('offline 被识别为"不知道"', normalizeState('offline') === 'unknown');
  check('无法识别的值仍然是 null(异常,不是"不知道")', normalizeState('WHAT??') === null);
  check('OPEN 归一化为 open', normalizeState('OPEN') === 'open');
  check('CLOSED 归一化为 closed', normalizeState('CLOSED') === 'closed');
  check('off 仍然是 closed(二值传感器语义不被破坏)', normalizeState('off') === 'closed');
  check('大小写不敏感', normalizeState('  open  ') === 'open');

  // --- 2. 新鲜读数会刷新心跳 ---
  console.log('\n[test] 新鲜读数');
  const t0 = Date.now();
  recordState(DEVICE, 'open', t0, { fresh: true });
  let door = getDoorByDevice(DEVICE);
  check('状态写进去了', door.state === 'open');
  check('在线标记置 1', door.online === 1);
  check('心跳时间刷新了', door.last_seen_at === t0);

  // --- 3. 重放的旧消息不刷新心跳 ---
  console.log('\n[test] broker 重放的 retained 旧消息');
  const t1 = t0 + 60_000;
  recordState(DEVICE, 'closed', t1, { fresh: false });
  door = getDoorByDevice(DEVICE);
  check('状态照样更新(它是设备最后一次真实读数)', door.state === 'closed');
  check('★ 没有刷新心跳时间', door.last_seen_at === t0, `last_seen=${door.last_seen_at} 应为 ${t0}`);

  // 最要命的那种:门已经判离线了,broker 重放一条旧的 OPEN,
  // 服务端要是把它当成"刚读到的",门就诈尸了。
  setOnline(DEVICE, false);
  recordState(DEVICE, 'open', t0 + 120_000, { fresh: false });
  door = getDoorByDevice(DEVICE);
  check('★ 重放的旧消息不会把离线的门重新标成在线', door.online === 0);
  check('★ 重放的旧消息不会刷新心跳时间', door.last_seen_at === t0);
  check(
    '★ 离线的门对外仍然是"未知",不是"门开着"',
    effectiveState(door, t0 + 120_000) === 'unknown',
    `effective=${effectiveState(door, t0 + 120_000)}`,
  );

  // --- 4. UNKNOWN 把状态打回未知 ---
  console.log('\n[test] 上报 UNKNOWN');
  recordSeen(DEVICE, t0 + 200_000);
  recordUnknown(DEVICE, t0 + 200_000, { fresh: true });
  door = getDoorByDevice(DEVICE);
  check('状态被打回 unknown', door.state === 'unknown');
  check('传感器被标记为离线', door.online === 0);
  check('对外状态是"未知",不是上次的 closed', effectiveState(door, t0 + 200_000) === 'unknown');

  // --- 5. 心跳不能复活已被打回 unknown 的状态 ---
  console.log('\n[test] 心跳不能复活旧状态');
  recordSeen(DEVICE, t0 + 210_000);
  door = getDoorByDevice(DEVICE);
  check('心跳后在线标记恢复', door.online === 1);
  check('★ 但状态仍然是"未知"(心跳只证明活着,不证明开还是关)', door.state === 'unknown');
  check('★ 对外状态仍然是"未知"', effectiveState(door, t0 + 210_000) === 'unknown');

  // --- 6. 收到合法状态才能恢复 ---
  console.log('\n[test] 收到合法状态后恢复');
  recordState(DEVICE, 'open', t0 + 220_000, { fresh: true });
  door = getDoorByDevice(DEVICE);
  check('状态恢复为 open', door.state === 'open');
  check('对外状态是"门开着"', effectiveState(door, t0 + 220_000) === 'open');

  // --- 7. 离线标记优先于状态 ---
  console.log('\n[test] 离线标记优先');
  door = { ...door, online: 0 };
  check('online=0 时对外一律是"未知"', effectiveState(door, t0 + 220_000) === 'unknown');

  // --- 8. 电量:只是"顺便报一下",不能当存活证明 ---
  console.log('\n[test] 电量不变量');
  recordState(DEVICE, 'closed', t0 + 300_000, { fresh: true });
  door = getDoorByDevice(DEVICE);
  const seenBefore = door.last_seen_at;
  const onlineBefore = door.online;

  recordBattery(DEVICE, 87, t0 + 310_000);
  door = getDoorByDevice(DEVICE);
  check('电量写进去了', door.battery === 87);
  check('记下了读到电量的时刻', door.battery_at === t0 + 310_000);
  check('★ 电量不改变门状态', door.state === 'closed');
  check('★ 电量不刷新心跳时间', door.last_seen_at === seenBefore);
  check('★ 电量不改变在线标记', door.online === onlineBefore);

  check('新读数对外可见', effectiveBattery(door, t0 + 310_000) === 87);
  check('对外接口也带上了电量', toPublic(door, t0 + 310_000).battery === 87);
  check(
    '★ 过期读数一律不认(宁可说不知道)',
    effectiveBattery(door, t0 + 310_000 + 8 * 24 * 3600_000) === null,
  );
  check(
    '★ 过期后对外也不显示那个数字',
    toPublic(door, t0 + 310_000 + 8 * 24 * 3600_000).battery === null,
  );

  // 最要命的那种:设备已经死了,但还有人报电量。
  // 电量消息要是能刷新心跳,一台没电的门磁就会被"救活"成在线。
  setOnline(DEVICE, false);
  recordBattery(DEVICE, 3, t0 + 320_000);
  door = getDoorByDevice(DEVICE);
  check('★ 电量消息没有把离线设备救活', door.online === 0);
  check('★ 对外仍然是"未知",不是上次的 closed', effectiveState(door, t0 + 320_000) === 'unknown');
  check('低电量读数本身照样记下来了', door.battery === 3);

  // --- 9. broker 重放的 retained 电量消息 ---
  // 服务端每次重启都会重新订阅,broker 会把 retained 存储里的旧消息重放一遍。
  // 那条消息是**什么时候读到的**没人知道 —— 写上"现在"就是撒谎:
  // 一台 3 个月前就没电的门磁,会因为每次重启都被"洗"成新鲜的读数,
  // 7 天超时永远不触发,看板就一直显示一个看着正常的 87%。
  console.log('\n[test] retained 重放的电量不算新读数');
  const batteryAtBefore = door.battery_at;
  recordBattery(DEVICE, 87, t0 + 400_000, { fresh: false });
  door = getDoorByDevice(DEVICE);
  check('重放消息里的数字照样记下来', door.battery === 87);
  check('★ 重放不更新时间戳', door.battery_at === batteryAtBefore);
  check(
    '★ 重放不会把过期读数洗成新的',
    effectiveBattery(door, t0 + 400_000 + 8 * 24 * 3600_000) === null,
  );

  // 完全没有历史记录时(比如数据库刚重建),重放也不能凭空造一个时间戳。
  const otherDevice = 'server-room-door';
  recordBattery(otherDevice, 55, t0 + 410_000, { fresh: false });
  const other = getDoorByDevice(otherDevice);
  check('重放不会凭空写出时间戳', other.battery_at == null);
  check('★ 没有可信时间戳就不显示电量', effectiveBattery(other, t0 + 410_000) === null);

  // --- 10. 登记表里删掉的门,数据库里也要真的删掉 ---
  // 以前 syncRegistry 只做 upsert,于是"从 doors.json 里删掉一扇门"根本不生效:
  // 看板会一直显示那扇已经不存在的门,而且它永远停在"状态未知"。
  console.log('\n[test] 登记表清理');
  syncRegistry([
    {
      id: 'it-office',
      name: 'IT 办公室',
      location: 'A512',
      deviceId: DEVICE,
      openHint: '',
      closedHint: '',
    },
  ]);
  check('登记表里没有的门被移出了数据库', getDoorByDevice(otherDevice) === null);
  check('还在登记表里的门留着', getDoorByDevice(DEVICE) !== null);
  check('位置跟着登记表更新了', getDoorByDevice(DEVICE).location === 'A512');
  check(
    '★ 同步登记表不会覆盖运行时状态(不会被冲成 unknown)',
    getDoorByDevice(DEVICE).state === 'closed',
  );

  // 登记表为空(配置文件写坏了)时,不能把已经登在册的门全清空。
  syncRegistry([]);
  check('★ 登记表为空时不清空数据库', getDoorByDevice(DEVICE) !== null);

  // --- 11. 中英双语文案 ---
  // 服务端要把两套文案一起下发,前端切语言时不用再问服务器要一次。
  // ★ 英文那份缺字段时必须**回退到中文**,绝不能是空白。
  console.log('\n[test] toPublic 的 i18n');

  // 先看一个没配英文的门
  syncRegistry([
    {
      id: 'it-office',
      name: 'IT 办公室',
      location: 'A512',
      deviceId: DEVICE,
      openHint: '中文开着',
      closedHint: '中文关着',
    },
  ]);
  let pub = toPublic(getDoorByDevice(DEVICE), t0 + 220_000);
  check('i18n 同时下发 zh / en 两套', Boolean(pub.i18n?.zh && pub.i18n?.en));
  check('中文那套用中文文案', pub.i18n.zh.name === 'IT 办公室' && pub.i18n.zh.open === '中文开着');
  check(
    '★ 没配英文时回退到中文(不是空白)',
    pub.i18n.en.name === 'IT 办公室' && pub.i18n.en.open === '中文开着',
    `name="${pub.i18n.en.name}" open="${pub.i18n.en.open}"`,
  );
  check('英文位置回退到中文位置', pub.i18n.en.location === 'A512');
  check('unknown 提示有兜底文案', typeof pub.i18n.zh.unknown === 'string' && pub.i18n.zh.unknown.length > 0);
  check(
    '★ 英文 unknown 用英文兜底(不给英文界面塞一句中文)',
    pub.i18n.en.unknown === 'Sensor offline, status unknown — please contact IT',
    `实际="${pub.i18n.en.unknown}"`,
  );
  check('中文 unknown 用中文兜底', pub.i18n.zh.unknown === '传感器没上线,状态未知 —— 请先联系 IT');
  check('旧的 hints 结构没被破坏(免得弄坏已有文档和测试)', pub.hints.open === '中文开着');

  // 只配了中文提示、没配英文时的回落
  syncRegistry([
    {
      id: 'it-office',
      name: 'IT 办公室',
      location: 'A512',
      deviceId: DEVICE,
      openHint: '中文开着',
      closedHint: '中文关着',
      unknownHint: '这门的传感器掉线了',
    },
  ]);
  pub = toPublic(getDoorByDevice(DEVICE), t0 + 220_000);
  check(
    '★ 只配了中文 unknown 时,英文回退到那份中文(不是空白)',
    pub.i18n.en.unknown === '这门的传感器掉线了',
    `实际="${pub.i18n.en.unknown}"`,
  );

  // 再看一个配了英文的门
  syncRegistry([
    {
      id: 'it-office',
      name: 'IT 办公室',
      nameEn: 'IT Office',
      location: 'A512',
      locationEn: 'Building A',
      deviceId: DEVICE,
      openHint: '中文开着',
      openHintEn: 'Someone is in',
      closedHint: '中文关着',
      closedHintEn: 'Door closed',
      unknownHint: '中文未知',
      unknownHintEn: 'Status unknown',
    },
  ]);
  pub = toPublic(getDoorByDevice(DEVICE), t0 + 220_000);
  check('配了英文就用英文', pub.i18n.en.name === 'IT Office' && pub.i18n.en.open === 'Someone is in');
  check('中文那套还是中文', pub.i18n.zh.name === 'IT 办公室' && pub.i18n.zh.open === '中文开着');
  check('英文位置用 locationEn', pub.i18n.en.location === 'Building A');
  check('英文关门提示用 closedHintEn', pub.i18n.en.closed === 'Door closed');
  check('英文 unknown 用 unknownHintEn', pub.i18n.en.unknown === 'Status unknown');
  check('中文 unknown 用 unknownHint', pub.i18n.zh.unknown === '中文未知');

  // --- 12. 老库迁移:缺列要补上 ---
  //
  // CREATE TABLE IF NOT EXISTS 对**已存在**的表不会加列,
  // 所以线上那些老库必须靠 PRAGMA table_info + ALTER TABLE 补列,
  // 否则 syncRegistry 一写新列就报 "no such column"。
  console.log('\n[test] 老库补列');
  const legacyPath = path.join(DATA_DIR, 'legacy.db');
  {
    const legacy = new DatabaseSync(legacyPath);
    // 旧版 doors 表:没有 name_en / location_en / *_hint_en / unknown_hint
    legacy.exec(`
      CREATE TABLE doors (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        location       TEXT NOT NULL DEFAULT '',
        device_id      TEXT NOT NULL UNIQUE,
        open_hint      TEXT NOT NULL DEFAULT '',
        closed_hint    TEXT NOT NULL DEFAULT '',
        state          TEXT NOT NULL DEFAULT 'unknown',
        online         INTEGER NOT NULL DEFAULT 0,
        last_change_at INTEGER,
        last_seen_at   INTEGER,
        updated_at     INTEGER
      );
      INSERT INTO doors (id, name, location, device_id, open_hint, closed_hint, state, online, last_seen_at)
      VALUES ('it-office', 'IT 办公室', 'A512', 'it-office-door', '中文开着', '中文关着', 'open', 1, ${t0});
    `);
    legacy.close();
  }

  // 打开老库 —— 迁移应该自动把缺的列补上
  openDb(legacyPath);
  const legacyCols = getDb()
    .prepare('PRAGMA table_info(doors)')
    .all()
    .map((c) => c.name);
  for (const col of [
    'name_en',
    'location_en',
    'open_hint_en',
    'closed_hint_en',
    'unknown_hint',
    'unknown_hint_en',
  ]) {
    check(`老库补上了 ${col} 列`, legacyCols.includes(col));
  }
  check('老数据没丢', getDb().prepare('SELECT COUNT(*) AS n FROM doors').get().n === 1);

  // 迁移必须幂等:再开一次不报错,列也不能重复
  openDb(legacyPath);
  const colsAgain = getDb()
    .prepare('PRAGMA table_info(doors)')
    .all()
    .map((c) => c.name);
  check(
    '★ 迁移幂等(重复运行不报错、列不重复)',
    colsAgain.filter((c) => c === 'name_en').length === 1,
  );

  // 老库上同步登记表,新列也得能写进去
  syncRegistry([
    {
      id: 'it-office',
      name: 'IT 办公室',
      nameEn: 'IT Office',
      location: 'A512',
      locationEn: 'Building A',
      deviceId: DEVICE,
      openHint: '中文开着',
      openHintEn: 'Someone is in',
      closedHint: '中文关着',
      closedHintEn: 'Door closed',
      unknownHint: '中文未知',
      unknownHintEn: 'Status unknown',
    },
  ]);
  const legacyRow = getDb().prepare('SELECT * FROM doors WHERE id = ?').get('it-office');
  check('老库上也能写入英文列', legacyRow.name_en === 'IT Office' && legacyRow.closed_hint_en === 'Door closed');
  check(
    '老库上也能写入 unknown_hint 两列',
    legacyRow.unknown_hint === '中文未知' && legacyRow.unknown_hint_en === 'Status unknown',
  );
  check(
    '★ 老库迁移没覆盖运行时状态',
    legacyRow.state === 'open' && legacyRow.last_seen_at === t0,
  );
} catch (err) {
  failures++;
  console.error(`\n❌ 测试异常: ${err.stack}`);
} finally {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n${failures === 0 ? '🎉 全部通过' : `💥 ${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
