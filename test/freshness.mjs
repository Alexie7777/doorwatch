#!/usr/bin/env node
/**
 * 「不许撒谎」这条底线的单元测试。
 *
 * 这里钉住三条不变量:
 *   1. UNKNOWN / unavailable 是"我不知道",不是垃圾值
 *      → 必须让状态打回 unknown,而不是保留上次的开/关
 *   2. broker 重放的 retained 旧消息只是历史数据
 *      → 不能拿来证明"设备还活着"
 *   3. 心跳只能证明"活着",不能复活一个已被打回 unknown 的状态
 *
 * 这些是纯逻辑,不起服务,毫秒级跑完。
 *
 * 运行: node test/freshness.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, syncRegistry, getDoorByDevice, recordState, recordUnknown, recordSeen, setOnline } from '../server/src/db.js';
import { normalizeState, effectiveState } from '../server/src/state.js';

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
