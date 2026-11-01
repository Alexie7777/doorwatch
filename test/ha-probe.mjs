#!/usr/bin/env node
/**
 * ha-probe.mjs 的端到端测试。
 *
 * 为什么需要:探针里有一段 WebSocket 代码(查实体归属哪个集成),
 * 那段代码只有在真 HA 上才跑得到,没法靠人肉点验证。
 * 这里起一个「假 HA」——REST 接口 + WebSocket 握手都自己实现——
 * 然后真的把探针 spawn 起来跑一遍,断言它输出的结论对不对。
 *
 * 假 HA 模拟的场景:
 *   · 两个候选实体(一个 contact_state、一个 magnet_sensor)
 *   · magnet_sensor 归属 xiaomi_miot,contact_state 归属 xiaomi_home
 *   · 轮询型:last_reported 每轮推进,last_updated 冻住
 *
 * 运行: node test/ha-probe.mjs
 */
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

/* ------------------------------------------------------------------ *
 * 假 HA 的状态
 * ------------------------------------------------------------------ */
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const STATES = [
  {
    entity_id: 'binary_sensor.isa_dw2hl_b95b_contact_state',
    state: 'on',
    attributes: { friendly_name: '门窗传感器 Contact State' },
    last_changed: iso(3600_000),
    last_updated: iso(3600_000),
    last_reported: iso(3300_000),
  },
  {
    entity_id: 'binary_sensor.isa_dw2hl_b95b_magnet_sensor',
    state: 'off',
    attributes: {
      friendly_name: '门窗传感器 Magnet Sensor',
      device_class: 'door',
      battery_level: 100,
    },
    last_changed: iso(3600_000),
    last_updated: iso(60_000),
    last_reported: iso(60_000),
  },
  {
    entity_id: 'sensor.doorwatch_it_office_door_state',
    state: 'CLOSED',
    attributes: { friendly_name: 'Doorwatch IT Office Door State' },
    last_changed: iso(120_000),
    last_updated: iso(120_000),
    last_reported: iso(120_000),
  },
];

/** entity_id → 集成平台 */
const REGISTRY = {
  'binary_sensor.isa_dw2hl_b95b_contact_state': 'xiaomi_home',
  'binary_sensor.isa_dw2hl_b95b_magnet_sensor': 'xiaomi_miot',
  'sensor.doorwatch_it_office_door_state': 'template',
};

/* ------------------------------------------------------------------ *
 * WebSocket:够用就行的手写实现(只处理文本帧)
 * ------------------------------------------------------------------ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 从 socket 里解出完整的客户端帧 */
function frameReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
      buf = buf.subarray(offset + maskLen + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      onMessage(payload.toString('utf8'));
    }
  };
}

function wsSend(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/* ------------------------------------------------------------------ *
 * 起服务
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  if (req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '2026.10.4' }));
    return;
  }
  if (req.url === '/api/states') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(STATES));
    return;
  }
  res.writeHead(404).end('{}');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  const read = frameReader((text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'auth') {
      wsSend(socket, JSON.stringify({ type: 'auth_ok', ha_version: '2026.10.4' }));
    } else if (msg.type === 'config/entity_registry/list') {
      wsSend(
        socket,
        JSON.stringify({
          id: msg.id,
          type: 'result',
          success: true,
          result: Object.entries(REGISTRY).map(([entity_id, platform]) => ({ entity_id, platform })),
        }),
      );
    }
  });
  socket.on('data', read);
  socket.on('error', () => {});
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

console.log(`\n[test] 假 HA 已启动: http://127.0.0.1:${port}\n`);

/* ------------------------------------------------------------------ *
 * 跑探针
 * ------------------------------------------------------------------ */
function runProbe(extra = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'tools', 'ha-probe.mjs'), '--host', `http://127.0.0.1:${port}`, '--token', 'test-token', ...extra],
      { cwd: ROOT },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += `[spawn error] ${e.message}`; resolve({ code: -1, out }); });
    child.on('close', (code) => resolve({ code, out }));
    // 探针必须在有限时间内自己退出(不能被 WebSocket 挂住)
    setTimeout(() => {
      child.kill();
      resolve({ code: -2, out: `${out}\n[test] 探针 15 秒还没退出 —— 卡住了` });
    }, 15000);
  });
}

const { code, out } = await runProbe();

console.log(out);
console.log('--- 断言 ---\n');

check('探针正常退出', code === 0, `exit=${code}`);
check('读到了 HA 版本', out.includes('2026.10.4'));
check('列出了 contact_state 实体', out.includes('binary_sensor.isa_dw2hl_b95b_contact_state'));
check('列出了 magnet_sensor 实体', out.includes('binary_sensor.isa_dw2hl_b95b_magnet_sensor'));
check('显示出门磁实体带 device_class=door', out.includes('device_class=door'));
check('显示出门磁实体的电量属性', out.includes('电量=100%'));
check('查出了 magnet_sensor 归属 xiaomi_miot', /magnet_sensor[\s\S]{0,400}归属集成: xiaomi_miot/.test(out));
check('查出了 contact_state 归属 xiaomi_home', /contact_state[\s\S]{0,400}归属集成: xiaomi_home/.test(out));
check('识别出已存在的 doorwatch 模板实体', /sensor\.doorwatch_it_office_door_state\s+=\s+CLOSED/.test(out));
check('给出了轮询型/推送型的判断说明', out.includes('轮询') && out.includes('推送'));
check('提示了推送型该怎么改', out.includes('STALE_SECONDS') || out.includes('轮询型'));

server.close();
console.log(`\n${failures === 0 ? '✅ ha-probe 测试全部通过' : `❌ ${failures} 项未通过`}\n`);
process.exit(failures ? 1 : 0);
