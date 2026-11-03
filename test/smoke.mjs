#!/usr/bin/env node
/**
 * 端到端冒烟测试。
 *
 * 覆盖最关键的几件事:
 *   1. 服务能起来,内置 MQTT broker 能连上
 *   2. 传感器上报 OPEN/CLOSED,看板 API 跟着变
 *   3. 传感器心跳断了 -> 状态自动降级成 unknown(这是本项目最核心的正确性)
 *   4. 人工置顶能覆盖传感器状态,取消后恢复
 *
 * 运行: node test/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doorwatch-test-'));
const HTTP_PORT = 18099;
/** 额外的纯 HTTP 端口 —— 微信等内置浏览器走这条 */
const PLAIN_PORT = 18097;
const MQTT_PORT = 18899;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const PLAIN_BASE = `http://127.0.0.1:${PLAIN_PORT}`;

let failures = 0;
function check(name, cond, extra = '') {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000, step = 250) {
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
  const res = await fetch(`${BASE}/api/doors/${id}`);
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
      // 额外开一个纯 HTTP 端口 —— 微信等内置浏览器走这条(见 server/src/index.js)
      HTTP_PORT: String(PLAIN_PORT),
      MQTT_PORT: String(MQTT_PORT),
      ONLINE_TIMEOUT_MS: '2000', // 心跳超时缩到 2 秒,方便测
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

process.on('exit', () => {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

try {
  console.log(`\n[test] 数据目录: ${DATA_DIR}\n`);

  // --- 1. 服务启动 ---
  const healthy = await waitFor(async () => {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok ? await res.json() : null;
  });
  check('服务启动并通过健康检查', Boolean(healthy), healthy ? `v${healthy.version}` : serverLog.slice(-500));
  if (!healthy) throw new Error('服务起不来,终止测试');

  // --- 2. 接上 MQTT ---
  const client = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { reconnectPeriod: 1000 });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
    setTimeout(() => reject(new Error('MQTT 连接超时')), 8000);
  });
  check('内置 MQTT broker 可连接', true);

  const pub = (topic, payload, opts = {}) =>
    new Promise((resolve) => client.publish(topic, payload, { qos: 1, ...opts }, resolve));

  // --- 3. 上报状态 ---
  await pub('doorwatch/it-office-door/status', 'online');
  await pub('doorwatch/it-office-door/state', 'CLOSED');
  await pub('doorwatch/it-office-door/heartbeat', 'alive');

  let door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'closed' ? d : null;
  });
  check('传感器上报 CLOSED 后看板显示"门关着"', Boolean(door), door ? `state=${door.state}` : '');
  check('传感器在线标记正确', door?.online === true);

  await pub('doorwatch/it-office-door/state', 'OPEN');
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  });
  check('传感器上报 OPEN 后看板显示"门开着"', Boolean(door), door ? `state=${door.state}` : '');
  check('开关门被记入历史', (door?.stats?.opens ?? 0) >= 1, `今日开 ${door?.stats?.opens} 次`);

  // --- 4. 心跳断了 -> unknown ---
  console.log('\n[test] 停止心跳,等待超时(2s)…');
  await sleep(3500);
  door = await getDoor('it-office');
  check('心跳超时后状态降级为"未知"', door?.state === 'unknown', `state=${door?.state}`);
  check('心跳超时后传感器标记为离线', door?.online === false);

  // 恢复心跳
  await pub('doorwatch/it-office-door/heartbeat', 'alive');
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'open' ? d : null;
  });
  check('心跳恢复后状态回到"门开着"', Boolean(door), door ? `state=${door?.state}` : '');

  // --- 5. 人工置顶 ---
  const key = fs.readFileSync(path.join(DATA_DIR, 'ADMIN_KEY.txt'), 'utf8').trim();
  const override = await fetch(`${BASE}/api/doors/it-office/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    body: JSON.stringify({ state: 'closed', hours: 1 }),
  });
  check('人工置顶接口可用', override.ok, `HTTP ${override.status}`);

  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && d.state === 'closed' && d.overridden ? d : null;
  });
  check('置顶后覆盖传感器状态', Boolean(door), door ? `state=${door?.state}` : '');

  const noKey = await fetch(`${BASE}/api/doors/it-office/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  check('没有密钥的写操作被拒绝', noKey.status === 401, `HTTP ${noKey.status}`);

  await fetch(`${BASE}/api/doors/it-office/override`, {
    method: 'DELETE',
    headers: { 'X-Admin-Key': key },
  });
  door = await waitFor(async () => {
    const d = await getDoor('it-office');
    return d && !d.overridden ? d : null;
  });
  check('取消置顶后恢复传感器状态', Boolean(door), door ? `state=${door?.state}` : '');

  // --- 6. 静态页面 ---
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('看板页面可访问', page.ok && html.includes('IT 办公室'), `HTTP ${page.status}`);

  const asset = await fetch(`${BASE}/app.js`);
  check('前端资源可访问', asset.ok, `HTTP ${asset.status}`);

  // --- 6b. 静态资源缓存链 ---
  // ★ 这一组是在钉一个真 bug:页面刷新时先闪一下新标题,
  //   随后又被旧文案盖回去。根因是模块依赖 (app.js → ./i18n.js)
  //   的 URL 恒定不变,浏览器(或中间的反向代理)可以一直留旧副本。
  //   修法:所有 .js 的相对模块 import 都要带版本戳,再加 ETag 兜底。
  const stamp = healthy.build;
  check('健康检查暴露 build 指纹(用于核对缓存版本)', Boolean(stamp), `build=${stamp}`);

  check(
    'HTML 外壳引用带版本戳的 app.js',
    html.includes(`/app.js?v=${stamp}`),
    stamp ? `期望 /app.js?v=${stamp}` : '',
  );
  check(
    'HTML 外壳引用带版本戳的 style.css',
    html.includes(`/style.css?v=${stamp}`),
    stamp ? `期望 /style.css?v=${stamp}` : '',
  );

  // ★ index.html 里引用的**每一个**本地静态资源都得带戳 ——
  //   漏掉一个(比如 icon.svg),改完图标手机上还是旧的,和标题闪一下是一回事。
  const localRefs = [
    ...new Set(
      [...html.matchAll(/(?:src|href)\s*=\s*["'](\/[^"']+)["']/g)].map((m) => m[1]),
    ),
  ];
  const unstamped = localRefs.filter(
    (u) => /\.(css|js|svg|webmanifest|png|jpe?g|gif|ico|webp)(\?|$)/.test(u) && !u.includes('?v='),
  );
  check(
    '★ HTML 里所有本地静态资源都带版本戳',
    unstamped.length === 0,
    unstamped.length ? `漏戳: ${unstamped.join(', ')}` : `${localRefs.length} 个引用全部带戳`,
  );
  check(
    'HTML 里没有漏掉的静态资源引用',
    localRefs.length >= 4,
    `共 ${localRefs.length} 个本地引用`,
  );

  const appJs = await (await fetch(`${BASE}/app.js`)).text();
  check(
    '★ 模块依赖 i18n.js 也带版本戳(修复闪标题的关键)',
    appJs.includes(`./i18n.js?v=${stamp}`),
    stamp ? `期望 ./i18n.js?v=${stamp}` : '',
  );

  const htmlRes = await fetch(`${BASE}/`);
  const cc = htmlRes.headers.get('cache-control') ?? '';
  check(
    'HTML 外壳禁用缓存(no-store)',
    /no-store/.test(cc) && /no-cache/.test(cc),
    `Cache-Control: ${cc}`,
  );

  const assetRes = await fetch(`${BASE}/app.js`);
  const etag = assetRes.headers.get('etag');
  check('静态资源返回 ETag', Boolean(etag), etag ?? '');
  check(
    'ETag 包含 build 指纹(别的文件变了正文也会变)',
    Boolean(etag && stamp && etag.includes(stamp)),
    etag ?? '',
  );

  if (etag) {
    const cond = await fetch(`${BASE}/app.js`, { headers: { 'If-None-Match': etag } });
    check('★ 带 If-None-Match 的重复请求返回 304', cond.status === 304, `HTTP ${cond.status}`);
  }

  const stale = await fetch(`${BASE}/app.js`, { headers: { 'If-None-Match': 'W/"nope"' } });
  check(
    'ETag 不匹配时正常返回 200 正文',
    stale.status === 200 && (await stale.text()).includes('i18n.js'),
    `HTTP ${stale.status}`,
  );

  // --- 7. 额外的纯 HTTP 端口 ---
  // ★ 这个端口**直接提供看板**,不是跳转到 HTTPS。
  //   微信内置浏览器打不开自签证书的 HTTPS(连"高级 → 继续"都不给),
  //   所以要让人能在微信里点开链接,必须有一条真正的 HTTP 通路。
  const plainPage = await fetch(`${PLAIN_BASE}/`, { redirect: 'manual' });
  const plainHtml = await plainPage.text();
  check(
    '★ 纯 HTTP 端口直接提供看板(不是 302 跳转)',
    plainPage.status === 200 && plainHtml.includes('IT 办公室'),
    `HTTP ${plainPage.status}`,
  );

  const plainHealth = await fetch(`${PLAIN_BASE}/api/health`);
  const plainHealthJson = plainHealth.ok ? await plainHealth.json() : null;
  check(
    '纯 HTTP 端口的 /api/health 可用',
    plainHealth.status === 200 && plainHealthJson?.ok === true,
    `HTTP ${plainHealth.status}`,
  );

  const plainDoors = await fetch(`${PLAIN_BASE}/api/doors`);
  const plainDoorsJson = plainDoors.ok ? await plainDoors.json() : null;
  check(
    '纯 HTTP 端口的 /api/doors 能拿到门的状态',
    plainDoors.status === 200 && Array.isArray(plainDoorsJson?.doors),
    `HTTP ${plainDoors.status}`,
  );

  client.end(true);
} catch (err) {
  failures++;
  console.error(`\n❌ 测试异常: ${err.message}\n${serverLog.slice(-1500)}`);
}

console.log(`\n${failures === 0 ? '🎉 全部通过' : `💥 ${failures} 项失败`}\n`);
server.kill();
process.exit(failures === 0 ? 0 : 1);
