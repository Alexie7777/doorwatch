#!/usr/bin/env node
/**
 * 门磁模拟器 —— 没有硬件时先用它把整条链路跑通。
 *
 * 用法:
 *   node tools/simulate.mjs                       # 连本机 broker,模拟"关着"
 *   node tools/simulate.mjs --open                # 模拟"开着"
 *   node tools/simulate.mjs --cycle 20             # 每 20 秒自动开/关一次
 *   node tools/simulate.mjs --device door-server-room
 *   node tools/simulate.mjs --drop                 # 模拟传感器掉线(不发心跳)
 *   node tools/simulate.mjs --host 192.168.1.10 --port 1883
 *
 *   # 模拟 Home Assistant(米家门磁走这条路):
 *   node tools/simulate.mjs --mode ha              # 模拟 HA 发消息的形态
 *   node tools/simulate.mjs --mode ha --open       # HA 侧读到的状态是"开"
 *   node tools/simulate.mjs --mode ha --unreadable  # 模拟 HA 读不到传感器
 *
 *  --mode ha 模拟的是"HA 自动化"的行为,和真实传感器有两点不同:
 *    1. 状态消息只在状态变化时发(HA 的 state trigger 就是这样)
 *    2. 心跳只有在传感器可读时才发 —— 读不到就不发,
 *       doorwatch 于是会在超时后降级成"状态未知"。
 *       这正是 HA 那套自动化模板的行为,也是最需要提前验证的一条。
 */
import mqtt from 'mqtt';

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 1883, device: 'it-office-door', prefix: 'doorwatch', mode: 'sensor', recover: 0, hb: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--closed') out.open = false;
    else if (a === '--drop') out.drop = true;
    else if (a === '--cycle') out.cycle = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--device') out.device = argv[++i];
    else if (a === '--prefix') out.prefix = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--unreadable') out.unreadable = true;
    else if (a === '--recover') out.recover = Number(argv[++i]);
    else if (a === '--hb') out.hb = Number(argv[++i]);
    else if (a === '--push-offline') out.pushOffline = true;
    else if (a === '--push-unknown') out.pushUnknown = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/simulate.mjs [--mode sensor|ha] [--open|--closed] [--cycle 秒] [--drop] [--unreadable] [--push-offline] [--push-unknown] [--recover 秒] [--hb 秒] [--host IP] [--port 端口] [--device ID] [--prefix 前缀]');
      console.log('  --mode ha       模拟 Home Assistant 自动化的行为(状态变化才发、读不到就不发心跳)');
      console.log('  --unreadable   模拟 HA 读不到传感器(不发光心跳,看板应降级为未知)');
      console.log('  --push-offline 失联时额外推 status=offline(HA 模板层的快速降级路径)');
      console.log('  --push-unknown 失联时额外推 state=UNKNOWN(HA 模板输出 UNKNOWN 时的路径)');
      console.log('  --recover 秒   多少秒后传感器恢复可读(验证心跳恢复后状态回升)');
      console.log('  --hb 秒        心跳间隔秒数');
      process.exit(0);
    }
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
const topic = (kind) => `${opt.prefix}/${opt.device}/${kind}`;
const isHa = opt.mode === 'ha';

const url = `mqtt://${opt.host}:${opt.port}`;
console.log(`[sim] 连接 ${url},设备 ${opt.device},模式 ${isHa ? 'HA' : '传感器'}`);

const client = mqtt.connect(url, { reconnectPeriod: 2000, clean: true });

let isOpen = Boolean(opt.open);
/** HA 模式下,传感器是否可读。不可读 -> 不发心跳,让 doorwatch 降级 */
let readable = !opt.unreadable;
/** HA 模式下,当前已经发给 doorwatch 的状态(用来判断"变化了没") */
let lastSent = null;

function publishState() {
  client.publish(topic('state'), isOpen ? 'OPEN' : 'CLOSED', { qos: 1, retain: true });
  console.log(`[sim] ${opt.device} 状态 -> ${isOpen ? 'OPEN' : 'CLOSED'}`);
}

function publishStateIfChanged() {
  const next = isOpen ? 'OPEN' : 'CLOSED';
  if (next === lastSent) return;
  lastSent = next;
  client.publish(topic('state'), next, { qos: 1, retain: true });
  console.log(`[sim] ${opt.device} 状态变化 -> ${next}`);
}

/** 模拟 HA 自动化:读不到传感器就不发心跳。doorwatch 会因此降级成"未知"。 */
function publishHeartbeat() {
  if (isHa && !readable) {
    console.log('[sim] 传感器不可读 —— 不发心跳(doorwatch 将降级为未知)');
    return;
  }
  client.publish(topic('heartbeat'), 'alive', { qos: 0, retain: false });
}

client.on('connect', () => {
  console.log('[sim] 已连接');
  client.publish(topic('status'), 'online', { qos: 1, retain: false });
  if (isHa) {
    // HA 侧:启动时补发一次当前状态 + 心跳
    publishStateIfChanged();
    publishHeartbeat();
  } else {
    publishState();
    if (!opt.drop) {
      client.publish(topic('heartbeat'), 'alive', { qos: 1, retain: false });
    }
  }
});

client.on('error', (err) => console.warn('[sim] 错误:', err.message));
client.on('reconnect', () => console.log('[sim] 重连中...'));

// 心跳
if (isHa) {
  setInterval(publishHeartbeat, opt.hb * 1000);
} else if (!opt.drop) {
  setInterval(() => {
    if (client.connected) client.publish(topic('heartbeat'), 'alive', { qos: 0, retain: false });
  }, opt.hb * 1000);
}

// 自动开关
if (opt.cycle) {
  setInterval(() => {
    isOpen = !isOpen;
    if (isHa) publishStateIfChanged();
    else publishState();
  }, opt.cycle * 1000);
}

// --unreadable:模拟传感器在 HA 里变成 unavailable(比如 token 过期、网关断电)
if (isHa && opt.unreadable) {
  setTimeout(() => {
    readable = false;
    console.log('[sim] ===== 传感器变为不可读 =====');
    // HA 的模板层检测到「状态太久没更新」后,会立刻推一条 offline。
    // 这条是 doorwatch 立即降级的关键路径,不是等心跳超时。
    if (opt.pushOffline) {
      client.publish(topic('status'), 'offline', { qos: 1, retain: false });
      console.log('[sim] 已推送 status=offline');
    }
    // HA 的状态模板这时会输出 UNKNOWN 并推给 doorwatch。
    // doorwatch 必须认识这个值 —— 收到就把状态打回"未知",
    // 而不是继续显示上次的开/关。
    if (opt.pushUnknown) {
      client.publish(topic('state'), 'UNKNOWN', { qos: 1, retain: true });
      lastSent = 'UNKNOWN';
      console.log('[sim] 已推送 state=UNKNOWN');
    }
  }, 5000);
}

// --recover:多少秒后传感器恢复可读(验证"心跳恢复 → 状态恢复"这条路径)
if (isHa && opt.recover > 0) {
  setTimeout(() => {
    readable = true;
    console.log('[sim] ===== 传感器恢复可读 =====');
    if (opt.pushOffline) {
      client.publish(topic('status'), 'online', { qos: 1, retain: false });
      console.log('[sim] 已推送 status=online');
    }
    publishHeartbeat();
    publishStateIfChanged();
  }, opt.recover * 1000);
}

// Ctrl+C 模拟"设备被拔电" —— Broker 会收到遗嘱消息,发 offline
process.on('SIGINT', () => {
  console.log('\n[sim] 模拟异常掉电(不发遗嘱,直接断开)');
  client.end(true);
  process.exit(0);
});
