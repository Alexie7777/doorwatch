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
import { openDb, syncRegistry, getDoorByDevice, recordState, recordUnknown, recordSeen, recordBattery, setOnline } from '../server/src/db.js';
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
