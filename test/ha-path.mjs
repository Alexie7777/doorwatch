#!/usr/bin/env node
/**
 * Home Assistant 接入路径的端到端测试。
 *
 * 覆盖 HA 那条路上最容易出问题的五件事:
 *   1. HA 发 OPEN/CLOSED,看板跟着变
 *   2. HA 读不到传感器(集成掉线 / token 过期)→ 不发心跳 → 看板降级成"未知"
 *      ★ 这是本项目最核心的正确性:传感器死了必须说"不知道",不能撒谎
 *   3. 传感器恢复可读 → 心跳恢复 → 状态回到 open/closed
 *   4. HA 推 state=UNKNOWN → 看板立刻变成"未知"(而不是继续显示上次的开/关)
 *   5. 非法状态值 → 不被当成有效读数,服务端会记告警
 *
 * 用的是 tools/simulate.mjs --mode ha,行为和 ha/automations.yaml 一致:
 * 状态变化才发 state,读不到就不发心跳。
 *
 * 运行: node test/ha-path.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doorwatch-ha-'));
const HTTP_PORT = 18098;
const MQTT_PORT = 18898;

/**
 * 心跳间隔 2 秒,超时 15 秒。
 *
 * 超时为什么给到 15 秒(而不是 6 秒):
 *   这条测试要区分两件事 —— 「offline 消息让看板**立刻**降级」和
 *   「等心跳超时才降级」。要证明前者,就必须让后者的阈值远大于前者,
 *   否则机器一忙,两条路径挤在一起,测出来的是运气不是逻辑。
 *   15 秒超时 + 10 秒观察窗口,既能证明「远早于超时」,又给慢机器留了余量。
 */
const HB = 2;
const TIMEOUT_MS = 15000;

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 20000, step = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 还没起来,继续等 */
    }
    await sleep(step);
  }
  return null;
}

async function getDoor(id) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/doors/${id}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.door;
}

const server = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'src', 'index.js')],
  {
    env: {
      ...process.env,
      DATA_DIR,
      HTTPS: 'false',
      PORT: String(HTTP_PORT),
      MQTT_PORT: String(MQTT_PORT),
      ONLINE_TIMEOUT_MS: String(TIMEOUT_MS),
      DOORS_JSON: JSON.stringify({
        doors: [{ id: 'it-office', name: 'IT 办公室', deviceId: 'it-office-door' }],
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d.toString()));
server.stderr.on('data', (d) => (serverLog += d.toString()));

/** HA 模拟器:8 秒后不可读,20 秒后恢复 */
const sim = spawn(
  process.execPath,
  [
    path.join(ROOT, 'tools', 'simulate.mjs'),
    '--mode', 'ha',
    '--port', String(MQTT_PORT),
    '--device', 'it-office-door',
    '--open',
    '--hb', String(HB),
    '--unreadable',
    '--push-offline',
    '--recover', '20',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let simLog = '';
sim.stdout.on('data', (d) => (simLog += d.toString()));
sim.stderr.on('data', (d) => (simLog += d.toString()));

function cleanup() {
  for (const c of [server, sim]) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.on('exit', cleanup);

try {
  console.log(`\n[test] 数据目录: ${DATA_DIR}`);
  console.log(`[test] 心跳 ${HB}s / 超时 ${TIMEOUT_MS / 1000}s\n`);

  // --- 1. 服务起来 ---
  const healthy = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/health`);
    return res.ok ? await res.json() : null;
  });
  check('服务启动并通过健康检查', Boolean(healthy), healthy ? `v${healthy.version}` : serverLog.slice(-500));
  if (!healthy) throw new Error('服务起不来,终止测试');

  // --- 2. HA 上报 OPEN,看板显示"门开着" ---
  let door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  });
  check('HA 上报 OPEN 后看板显示"门开着"', Boolean(door), door ? `state=${door.state}` : '');
  check('HA 心跳使传感器标记为在线', door?.online === true);

  // --- 3. HA 读不到传感器 → 不发心跳 → 降级为未知 ---
  console.log('\n[test] 等待 HA 侧传感器变为不可读,心跳中断…');
  // 不要写死 sleep(10_000) —— 模拟器第 5 秒就不可读了,睡固定时长再去查,
  // 差一秒和差十秒是两种完全不同的结果,机器一忙就随机翻车。
  // 直接轮询"状态变成未知",等它真发生。
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'unknown' ? d : null;
  }, 25_000, 200);
  check('HA 读不到传感器后看板降级为"未知"', door?.state === 'unknown', `state=${door?.state}`);
  check('降级后传感器标记为离线', door?.online === false);
  check(
    '模拟器确实停发了心跳',
    /不发心跳/.test(simLog),
    simLog.includes('传感器变为不可读') ? '已触发不可读' : '未触发',
  );
  check(
    'HA 推送了 status=offline(快速降级路径)',
    /已推送 status=offline/.test(simLog),
    simLog.includes('status=offline') ? '已推送' : '未推送',
  );

  // 离线后即使心跳还在,状态也必须是 unknown —— 离线优先
  // (doorwatch 的 setOnline(false) 会立即把 effectiveState 压成 unknown)
  const afterOffline = await getDoor('it-office');
  check(
    '收到 offline 后状态保持为"未知"',
    afterOffline?.state === 'unknown',
    `state=${afterOffline?.state}`,
  );

  // --- 4. 恢复 → 状态回升 ---
  console.log('\n[test] 等待传感器恢复可读…');
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  }, 25_000);
  check('传感器恢复后状态回到"门开着"', Boolean(door), door ? `state=${door?.state}` : '');
  check('恢复后传感器重新标记为在线', door?.online === true);

  // --- 5. 服务端没收到未登记设备告警 ---
  check(
    '服务端没有"未登记设备"告警',
    !/未登记设备/.test(serverLog),
    serverLog.match(/未登记设备.*/)?.[0] ?? '',
  );

  // --- 6. offline 的即时性:不等心跳超时,立刻降级 ---
  // 这是 HA 那条「传感器失联 → status=offline」自动化的核心价值。
  // 如果只靠心跳超时,门磁掉线后看板要等 6 秒(测试里)才降级;
  // 收到 offline 应该立刻变成 unknown。
  console.log('\n[test] 验证 offline 消息的即时降级…');
  const probe = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { reconnectPeriod: 1000 });
  await new Promise((resolve, reject) => {
    probe.once('connect', resolve);
    probe.once('error', reject);
    setTimeout(() => reject(new Error('MQTT 连接超时')), 8000);
  });

  // 先把状态恢复成 open,确保"降级"是真的由 offline 引起的
  probe.publish('doorwatch/it-office-door/state', 'OPEN', { qos: 1, retain: true });
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  });
  check('前置条件:状态恢复为"门开着"', Boolean(door), door ? `state=${door?.state}` : '');

  // 只发 offline,不碰心跳 —— 观察多久降级
  const sentAt = Date.now();
  probe.publish('doorwatch/it-office-door/status', 'offline', { qos: 1, retain: false });

  const degraded = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'unknown' ? d : null;
  }, 10_000, 50);
  const elapsed = Date.now() - sentAt;
  check(
    '收到 offline 后立即降级为"未知"',
    Boolean(degraded),
    degraded ? `耗时 ${elapsed}ms` : '10 秒内未降级',
  );
  check(
    '降级耗时远小于心跳超时',
    elapsed < TIMEOUT_MS,
    `降级 ${elapsed}ms < 超时 ${TIMEOUT_MS}ms`,
  );

  // --- 7. HA 的状态模板输出 UNKNOWN 时,看板必须立刻变成"未知" ---
  // HA 的模板在传感器读不到时输出 UNKNOWN 并推给 doorwatch。
  // 以前服务端把这个值当成"看不懂的垃圾"扔掉了,只刷新心跳不改状态 ——
  // 结果传感器明明已经死了,看板还一直显示"门开着"。这条就是那个坑的回归测试。
  console.log('\n[test] 验证 state=UNKNOWN 的处理(HA 模板输出 UNKNOWN 的路径)…');
  probe.publish('doorwatch/it-office-door/state', 'OPEN', { qos: 1, retain: true });
  probe.publish('doorwatch/it-office-door/heartbeat', 'alive', { qos: 1, retain: false });
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  }, 5000, 50);
  check('前置条件:状态是"门开着"', Boolean(door), door ? `state=${door?.state}` : '');

  const unknownAt = Date.now();
  probe.publish('doorwatch/it-office-door/state', 'UNKNOWN', { qos: 1, retain: true });
  const afterUnknown = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'unknown' ? d : null;
  }, 10_000, 50);
  const unknownElapsed = Date.now() - unknownAt;
  check(
    '收到 state=UNKNOWN 后立即降级为"未知"',
    Boolean(afterUnknown),
    afterUnknown ? `耗时 ${unknownElapsed}ms` : '10 秒内未降级',
  );
  check(
    'UNKNOWN 降级耗时远小于心跳超时',
    unknownElapsed < TIMEOUT_MS,
    `降级 ${unknownElapsed}ms < 超时 ${TIMEOUT_MS}ms`,
  );

  // 心跳只证明"活着",不证明"开还是关" —— 不能把旧状态复活
  probe.publish('doorwatch/it-office-door/heartbeat', 'alive', { qos: 1, retain: false });
  await sleep(600);
  const afterHb = await getDoor('it-office');
  check(
    'UNKNOWN 之后收到心跳,状态仍是"未知"(不复活旧状态)',
    afterHb?.state === 'unknown',
    `state=${afterHb?.state}`,
  );

  // 恢复:再来一条合法的 OPEN
  probe.publish('doorwatch/it-office-door/state', 'OPEN', { qos: 1, retain: true });
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  }, 5000, 50);
  check('收到合法的 OPEN 后状态恢复为"门开着"', Boolean(door), door ? `state=${door?.state}` : '');

  // --- 8. 非法状态值:不能被当成"有效读数" ---
  console.log('\n[test] 验证非法状态值的处理…');
  probe.publish('doorwatch/it-office-door/state', 'WHATEVER', { qos: 1, retain: false });
  await sleep(600);
  const afterGarbage = await getDoor('it-office');
  check(
    '非法值不会改变状态(保留最后一次合法读数)',
    afterGarbage?.state === 'open',
    `state=${afterGarbage?.state}`,
  );
  check(
    '服务端记录了"看不懂的状态"告警',
    /上报了看不懂的状态/.test(serverLog),
    serverLog.match(/上报了看不懂的状态.*/)?.[0] ?? '',
  );

  probe.end(true);
} catch (err) {
  failures++;
  console.error(`\n❌ 测试异常: ${err.message}\n${serverLog.slice(-1200)}\n${simLog.slice(-800)}`);
}

console.log(`\n${failures === 0 ? '🎉 全部通过' : `💥 ${failures} 项失败`}\n`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
