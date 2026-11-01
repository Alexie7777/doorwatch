#!/usr/bin/env node
/**
 * 看板 UI 自动化测试(Chrome DevTools Protocol,不需要装 Playwright)。
 *
 * 覆盖真实用户路径:
 *   1. 手机尺寸(390x844)下页面正常渲染,三扇门状态正确
 *   2. 点"管理"能拉起管理面板
 *   3. 输入管理密钥能解锁
 *   4. 点"置顶为关门"后,卡片出现"人工置顶"标记并覆盖传感器状态
 *   5. 截手机版效果图到 test/artifacts/
 *
 * 运行: node test/ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doorwatch-ui-'));
const HTTP_PORT = 18098;
const MQTT_PORT = 18898;
const DEBUG_PORT = 19333;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ADMIN_KEY = 'test-admin-key-1234';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (path.isAbsolute(c) ? fs.existsSync(c) : true) return c;
  }
  return null;
}

/* ---------------- CDP 客户端 ---------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const waiters = this.events.get(msg.method) ?? [];
        this.events.delete(msg.method);
        waiters.forEach((w) => w(msg.params));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const list = this.events.get(method) ?? [];
      list.push(resolve);
      this.events.set(method, list);
      setTimeout(() => reject(new Error(`等待事件超时: ${method}`)), timeoutMs);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面脚本异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result.value;
  }
}

async function connectCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
          setTimeout(() => reject(new Error('CDP WebSocket 超时')), 10000);
        });
        return new Cdp(ws);
      }
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error('连不上 Chrome 调试端口');
}

/* ---------------- 主流程 ---------------- */

const procs = [];
function cleanup() {
  for (const p of procs) {
    try {
      p.kill();
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
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  // 1. 起服务
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
        ADMIN_KEY,
        DOORS_JSON: JSON.stringify({
          doors: [
            { id: 'it-office', name: 'IT 办公室', location: '行政楼 A 座 2F', deviceId: 'it-office-door' },
            { id: 'server-room', name: '机房', location: '行政楼 A 座 1F', deviceId: 'server-room-door' },
          ],
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  procs.push(server);
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }

  // 2. 模拟一个开着门的传感器
  const sim = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`);
  procs.push(sim);
  await new Promise((resolve, reject) => {
    sim.once('connect', resolve);
    setTimeout(() => reject(new Error('模拟器连不上')), 8000);
  });
  sim.publish('doorwatch/it-office-door/status', 'online', { qos: 1 });
  sim.publish('doorwatch/it-office-door/state', 'OPEN', { qos: 1, retain: true });
  sim.publish('doorwatch/it-office-door/heartbeat', 'alive', { qos: 1 });

  // 3. 起 Chrome
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome/Edge,跳过 UI 测试');
  console.log(`\n[ui] 浏览器: ${chrome}\n`);

  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'dw-chrome-')),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  procs.push(browser);

  const cdp = await connectCdp();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 手机尺寸
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: BASE });
  await loaded;

  // 等看板把数据渲染出来
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const n = await cdp.eval('document.querySelectorAll("article.door").length');
    if (n === 2) {
      ready = true;
      break;
    }
    await sleep(250);
  }
  check('看板在手机尺寸下渲染出 2 张门卡片', ready);

  const state1 = await cdp.eval(
    'document.querySelector("article.door .state__title")?.textContent?.trim()',
  );
  check('第一张卡片显示"门开着"', state1 === '门开着', `实际="${state1}"`);

  // 4. 点"管理"
  await cdp.eval('document.querySelector("#manage-btn").click()');
  await sleep(400);
  const sheetOpen = await cdp.eval(
    '!document.querySelector("#manage-sheet").hasAttribute("hidden")',
  );
  check('点"管理"能拉起管理面板', sheetOpen === true);

  const bodyLen = await cdp.eval('document.querySelector("#manage-body").innerText.length');
  check('管理面板渲染出内容', bodyLen > 0, `长度 ${bodyLen}`);

  // 5. 输入密钥解锁
  await cdp.eval(`
    (() => {
      const input = document.querySelector('#key-input');
      if (!input) return 'no-input';
      input.value = ${JSON.stringify(ADMIN_KEY)};
      document.querySelector('#key-verify').click();
      return 'ok';
    })()
  `);
  await sleep(1200);
  const unlocked = await cdp.eval('!!document.querySelector(".door-admin")');
  check('输入管理密钥后解锁成功', unlocked === true);

  // 6. 置顶为关门
  await cdp.eval(`
    (() => {
      const btn = document.querySelector('button[data-act="closed"]');
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()
  `);
  await sleep(1200);
  const overridden = await cdp.eval(
    'document.querySelector("article.door .badge--override")?.textContent?.trim()',
  );
  check('置顶后卡片出现"人工置顶"标记', overridden === '人工置顶', `实际="${overridden}"`);

  const state2 = await cdp.eval(
    'document.querySelector("article.door .state__title")?.textContent?.trim()',
  );
  check('置顶覆盖了传感器状态(开着→关着)', state2 === '门关着', `实际="${state2}"`);

  // 7. 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(ARTIFACTS, 'dashboard-mobile.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  check('手机版效果图已生成', fs.existsSync(shotPath), shotPath);

  // 关闭管理面板,再截一张正常态
  await cdp.eval('document.querySelector("#manage-close").click()');
  await sleep(400);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shot2Path = path.join(ARTIFACTS, 'dashboard-mobile-normal.png');
  fs.writeFileSync(shot2Path, Buffer.from(shot2.data, 'base64'));

  // 8. 桌面尺寸也看一眼
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(600);
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shot3Path = path.join(ARTIFACTS, 'dashboard-desktop.png');
  fs.writeFileSync(shot3Path, Buffer.from(shot3.data, 'base64'));
  check('桌面版效果图已生成', fs.existsSync(shot3Path), shot3Path);

  sim.end(true);
} catch (err) {
  failures++;
  console.error(`\n❌ UI 测试异常: ${err.message}`);
}

console.log(`\n${failures === 0 ? '🎉 UI 测试全部通过' : `💥 ${failures} 项失败`}\n`);
cleanup();
process.exit(failures === 0 ? 0 : 1);
