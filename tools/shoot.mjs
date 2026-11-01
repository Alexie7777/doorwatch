#!/usr/bin/env node
/**
 * 文档截图工具:按锚点抓取页面的指定区块。
 *
 *   node tools/shoot.mjs <url> <anchor> <out.png> [width] [height]
 *
 * 例子:
 *   node tools/shoot.mjs docs/architecture.html hw docs/hw.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [urlArg, anchor, outArg, wArg, hArg] = process.argv.slice(2);
if (!urlArg || !anchor || !outArg) {
  console.log('用法: node tools/shoot.mjs <url> <anchor> <out.png> [width] [height]');
  process.exit(1);
}

const width = Number(wArg ?? 1280);
const height = Number(hArg ?? 900);
const out = path.resolve(outArg);
const url = urlArg.startsWith('http') ? urlArg : `file:///${path.resolve(urlArg).replace(/\\/g, '/')}`;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => (path.isAbsolute(p) ? fs.existsSync(p) : true));

if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}

const DEBUG_PORT = 19500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-')),
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => {
  try { browser.kill(); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let ws;
let msgId = 0;
const pending = new Map();

try {
  let target = null;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 等浏览器起来 */ }
    await sleep(200);
  }
  if (!target) throw new Error('连不上调试端口');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true });
    setTimeout(() => reject(new Error('WS 超时')), 10000);
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });

  const send = (method, params = {}) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, 20000);
    });
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url });
  await sleep(2500); // 等字体和布局稳定

  // 滚到目标区块
  await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(anchor)});
      if (el) el.scrollIntoView({ block: 'start' });
      return el ? el.getBoundingClientRect().top : -1;
    })()`,
  });
  await sleep(900);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`已保存 ${out}`);
} catch (err) {
  console.error(`失败: ${err.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
