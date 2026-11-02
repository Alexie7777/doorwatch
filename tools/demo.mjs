#!/usr/bin/env node
/**
 * 一键演示:起服务 + 拉起几个模拟传感器。
 * 没有硬件时,用这个就能把整条链路跑起来看效果。
 *
 *   node tools/demo.mjs            # HTTP,方便直接看
 *   node tools/demo.mjs --https    # HTTPS(带自签证书,和正式部署一致)
 *   node tools/demo.mjs --mode ha  # 模拟 Home Assistant 接入(米家门磁路线)
 *
 * Ctrl+C 退出。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const useHttps = process.argv.includes('--https');
const useHa = process.argv.includes('--mode') && process.argv.includes('ha');
const PORT = Number(process.env.DEMO_PORT ?? (useHttps ? 8443 : 8081));
const MQTT_PORT = Number(process.env.DEMO_MQTT_PORT ?? 1884);

const children = [];

function run(label, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[${label}]`;
  const pipe = (stream) => {
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) console.log(`${tag} ${line}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  children.push(child);
  return child;
}

// ★ 演示用的是**自己的一份三门配置**,不读 config/doors.json。
//   真实部署只接了一扇门(IT 办公室),但演示要同时展示三种状态:
//   关着 / 开着 / 传感器离线(状态未知)。
//   所以这里用 DOORS_JSON 塞一份演示专用的登记表进去 ——
//   DOORS_JSON 的优先级高于 DOORS_FILE,不会碰到真实配置。
const DEMO_DOORS = JSON.stringify({
  doors: [
    {
      id: 'it-office',
      name: 'IT 办公室',
      location: 'A512',
      deviceId: 'it-office-door',
      openHint: 'IT 有人在,直接过来就行',
      closedHint: '门已关,IT 暂时不在,先别跑一趟',
    },
    {
      id: 'server-room',
      name: '机房',
      location: '行政楼 A 座 1F',
      deviceId: 'server-room-door',
      openHint: '机房有人,调试设备可直接找我们',
      closedHint: '机房无人,请勿进入',
    },
    {
      id: 'it-store',
      name: 'IT 备件间',
      location: '行政楼 A 座 2F',
      deviceId: 'it-store-door',
      openHint: '备件间有人,取件直接来',
      closedHint: '备件间无人,需要请先联系 IT',
    },
  ],
});

run('server', process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.js'], {
  DATA_DIR: path.join(ROOT, 'data-demo'),
  HTTPS: String(useHttps),
  PORT: String(PORT),
  MQTT_PORT: String(MQTT_PORT),
  // 演示专用的三门登记表,不动真实配置
  DOORS_JSON: DEMO_DOORS,
  // 心跳超时。模拟器心跳 10 秒一跳,这里给 30 秒(3 倍冗余),
  // 和真实配置一致:传感器心跳 60 秒一跳,超时 180 秒。
  ONLINE_TIMEOUT_MS: process.env.ONLINE_TIMEOUT_MS ?? '30000',
});

// 两扇门有传感器,第三扇(备件间)不接 —— 用来演示"传感器离线 → 状态未知"
if (useHa) {
  // 模拟 HA 接入:状态变化才发消息,读不到传感器就不发心跳
  run('sim:HA-IT办公室', process.execPath, ['tools/simulate.mjs', '--mode', 'ha', '--port', String(MQTT_PORT), '--device', 'it-office-door', '--closed'], {});
  run('sim:HA-机房', process.execPath, ['tools/simulate.mjs', '--mode', 'ha', '--port', String(MQTT_PORT), '--device', 'server-room-door', '--open', '--unreadable', '--recover', '40'], {});
} else {
  run('sim:IT办公室', process.execPath, ['tools/simulate.mjs', '--port', String(MQTT_PORT), '--device', 'it-office-door', '--closed'], {});
  run('sim:机房', process.execPath, ['tools/simulate.mjs', '--port', String(MQTT_PORT), '--device', 'server-room-door', '--open'], {});
}

setTimeout(() => {
  const scheme = useHttps ? 'https' : 'http';
  console.log('\n────────────────────────────────────────');
  console.log(`  看板地址: ${scheme}://<本机IP>:${PORT}/`);
  console.log(`  MQTT:     <本机IP>:${MQTT_PORT}`);
  if (useHa) {
    console.log('  模式:     Home Assistant 模拟');
    console.log('  IT 办公室=关着 / 机房=开着,传感器 5 秒后不可读,40 秒后恢复 / 备件间=未接入');
  } else {
    console.log('  IT 办公室=关着 / 机房=开着 / 备件间=传感器离线');
  }
  console.log('  Ctrl+C 退出');
  console.log('────────────────────────────────────────\n');
}, 2500);

function shutdown() {
  console.log('\n正在退出...');
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
