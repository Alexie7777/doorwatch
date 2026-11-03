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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACTS = path.join(ROOT, 'test', 'artifacts');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doorwatch-ui-'));
const HTTP_PORT = 18098;
const MQTT_PORT = 18898;
/**
 * Chrome 调试端口**每次现挑一个空闲端口**。
 * 写死端口的话,上一轮跑剩下的 Chrome 还占着它,这一轮的 Chrome 就绑不上 ——
 * 表现是「连不上 Chrome 调试端口」,而实际上 Chrome 好好地开着,只是端口被占。
 */
const DEBUG_PORT = await freePort();
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const ADMIN_KEY = 'test-admin-key-1234';

/** 找一个当前没人用的本地端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

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

async function connectCdp(browser) {
  // 30 秒预算(原来 10 秒)。机器内存紧张的时候,headless Chrome 启动
  // 会被换页拖慢,10 秒不够 —— 那种失败看着像代码坏了,其实是机器忙。
  for (let i = 0; i < 120; i++) {
    if (browser?.exitCode !== null && browser?.exitCode !== undefined) {
      throw new Error(`Chrome 启动就退出了(退出码 ${browser.exitCode})`);
    }
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
            {
              id: 'it-office',
              name: 'IT 办公室',
              nameEn: 'IT Office',
              location: '行政楼 A 座 2F',
              locationEn: 'Admin Bldg A, 2F',
              deviceId: 'it-office-door',
              openHint: 'IT 有人在,直接过来就行',
              openHintEn: 'Someone from IT is in — just come over',
              closedHint: '门已关，IT 暂时不在，可联系值班微信',
              closedHintEn: 'Door closed, IT is temporarily away. Contact the on-duty WeChat.',
            },
            {
              id: 'server-room',
              name: '机房',
              nameEn: 'Server Room',
              location: '行政楼 A 座 1F',
              locationEn: 'Admin Bldg A, 1F',
              deviceId: 'server-room-door',
            },
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
  // 电量:看板要在卡片头部显示出来(以前算出来了却忘了插进模板,这里钉住)
  sim.publish('doorwatch/it-office-door/battery', '87', { qos: 1 });

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

  const cdp = await connectCdp(browser);
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

  const batteryBadge = await cdp.eval(
    'document.querySelector("article.door .badge--battery")?.textContent?.trim()',
  );
  check('卡片上显示电量徽章', batteryBadge === '电量 87%', `实际="${batteryBadge}"`);

  const batteryWarn = await cdp.eval(
    'document.querySelectorAll("article.door .badge--warn").length',
  );
  check('电量 87% 不算低电量(不高亮)', batteryWarn === 0, `高亮徽章 ${batteryWarn} 个`);

  // 页头图标必须和 favicon 是同一张图(以前页头是 CSS 画的,长得不一样)
  const logo = await cdp.eval(`
    (() => {
      const img = document.querySelector('.topbar__logo');
      const fav = document.querySelector('link[rel="icon"]');
      return {
        tag: img?.tagName ?? null,
        src: img?.getAttribute('src') ?? null,
        fav: fav?.getAttribute('href') ?? null,
      };
    })()
  `);
  check('页头图标是 <img>', logo.tag === 'IMG', `实际=<${logo.tag}>`);
  check('页头图标和 favicon 是同一张图', logo.src === logo.fav, `${logo.src} vs ${logo.fav}`);

  // Service Worker 绝对不能碰 SSE —— SW 被回收时会把响应流一起掐断
  const swText = await (await fetch(`${BASE}/sw.js`)).text();
  check(
    'Service Worker 不再拦截 SSE',
    swText.includes("/api/stream") && !/pathname\.startsWith\('\/api\/'\)/.test(
      swText.split("/api/stream")[0],
    ),
  );

  // 客户端必须有自愈能力:看门狗 + 兜底轮询
  const appText = await (await fetch(`${BASE}/app.js`)).text();
  check('客户端有 SSE 看门狗', appText.includes('WATCHDOG_MS'));
  check('客户端有兜底轮询', appText.includes('FALLBACK_POLL_MS'));
  check('客户端监听页面可见性变化', appText.includes('visibilitychange'));
  check('页面里不再有取版本号那段代码', !appText.includes("$('#version')"));

  // 4. 中英切换
  console.log('\n[ui] 中英切换');
  const zhState = await cdp.eval(
    'document.querySelector("article.door .state__title")?.textContent?.trim()',
  );
  check('默认是中文', zhState === '门开着', `实际="${zhState}"`);

  // 页脚:只剩品牌署名,「管理」和版本号都得消失
  const footerInfo = await cdp.eval(`
    (() => {
      const f = document.querySelector('.footer');
      return {
        text: f?.innerText ?? '',
        hasBrandEl: !!document.querySelector('#footer-brand'),
        hasVersionEl: !!document.querySelector('#version'),
        hasManageInFooter: !!f?.querySelector('#manage-btn'),
      };
    })()
  `);
  check(
    '页脚显示 Powered By IT Dept',
    footerInfo.text.includes('Powered By IT Dept'),
    footerInfo.text.replace(/\s+/g, ' ').trim(),
  );
  const zhFooterHint = await cdp.eval(
    'document.querySelector("#footer-hint")?.textContent?.trim()',
  );
  check('★ 中文页脚文案正确', zhFooterHint === '一眼知门况，免跑空一趟。', `实际="${zhFooterHint}"`);
  check(
    '★ 页脚没有版本号',
    !footerInfo.text.includes('v1.0.0') && !footerInfo.hasVersionEl,
  );
  check(
    '★ 页脚没有「管理」',
    !footerInfo.text.includes('管理') && !footerInfo.hasManageInFooter,
  );
  const headerManage = await cdp.eval('!!document.querySelector(".topbar #manage-btn")');
  check('★「管理」按钮挪到了页头', headerManage === true);

  // 页头副标题(「有人值班,可以直接过去」)已经删掉了 —— 门卡片里本来就有这句,
  // 页头再说一遍是重复。钉住它别被加回来。
  const topbarText = await cdp.eval('document.querySelector(".topbar")?.innerText ?? ""');
  const hasSubEl = await cdp.eval('!!document.querySelector("#subtitle")');
  check(
    '★ 页头不再有副标题',
    !hasSubEl && !topbarText.includes('有人值班') && !topbarText.includes('值班,可以直接过去'),
    `实际="${topbarText.replace(/\s+/g, ' ').trim()}"`,
  );

  // 切到英文
  await cdp.eval('document.querySelector("#lang-toggle").click()');
  await sleep(500);
  const enState = await cdp.eval(
    'document.querySelector("article.door .state__title")?.textContent?.trim()',
  );
  check('★ 切到英文后「门开着」变成「Door Open」', enState === 'Door Open', `实际="${enState}"`);
  const enFooterHint = await cdp.eval(
    'document.querySelector("#footer-hint")?.textContent?.trim()',
  );
  check(
    '★ 英文页脚文案正确',
    enFooterHint === 'Glance before you leave, no need to grieve.',
    `实际="${enFooterHint}"`,
  );
  const htmlLang = await cdp.eval('document.documentElement.lang');
  check('★ documentElement.lang 变成 en', htmlLang === 'en', `实际="${htmlLang}"`);
  const enName = await cdp.eval(
    'document.querySelector("article.door .door__name")?.textContent?.trim()',
  );
  check('门名用服务端下发的英文', enName?.startsWith('IT Office'), `实际="${enName}"`);
  const enHint = await cdp.eval(
    'document.querySelector("article.door .state__hint")?.textContent?.trim()',
  );
  check('提示语用服务端下发的英文', enHint === 'Someone from IT is in — just come over', `实际="${enHint}"`);
  const enBadge = await cdp.eval(
    'document.querySelector("article.door .badge--battery")?.textContent?.trim()',
  );
  check('电量徽章变成英文', enBadge === 'Battery 87%', `实际="${enBadge}"`);
  const enToggle = await cdp.eval('document.querySelector("#lang-toggle")?.textContent?.trim()');
  check('切换按钮显示另一种语言的名字', enToggle === '中', `实际="${enToggle}"`);
  const enManage = await cdp.eval('document.querySelector("#manage-btn")?.textContent?.trim()');
  check('页头「管理」按钮变成英文 Manage', enManage === 'Manage', `实际="${enManage}"`);
  const enMeta = await cdp.eval(
    'document.querySelector("article.door .door__meta")?.innerText?.replace(/\\s+/g, " ")?.trim()',
  );
  // 断言的是「标签和值之间留了空格」(英文的 colon 是 ': '),
  // 所以只看「标签 + 冒号 + 空格 + 值」这个形状 —— 不要写死 'just now',
  // 那取决于门最后一次变化是几秒前,跑得慢一点就变 '10s ago',纯属自找的随机失败。
  check(
    '英文标签和值之间留了空格',
    /Last change: \S/.test(enMeta ?? ''),
    `实际="${enMeta}"`,
  );
  const enUnknown = await cdp.eval(
    'document.querySelectorAll("article.door .state__hint")[1]?.textContent?.trim()',
  );
  check(
    '★ 离线门的提示语也是英文(不给英文界面塞中文)',
    /^Sensor offline/.test(enUnknown ?? ''),
    `实际="${enUnknown}"`,
  );

  // 英文看板截图
  const shotEn = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const shotEnPath = path.join(ARTIFACTS, 'dashboard-en.png');
  fs.writeFileSync(shotEnPath, Buffer.from(shotEn.data, 'base64'));
  check('英文看板截图已生成', fs.existsSync(shotEnPath), shotEnPath);

  // 刷新后语言还在(靠 localStorage)
  const reloaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.reload', { ignoreCache: true });
  await reloaded;
  let readyEn = false;
  for (let i = 0; i < 40; i++) {
    const n = await cdp.eval('document.querySelectorAll("article.door").length');
    if (n === 2) {
      readyEn = true;
      break;
    }
    await sleep(250);
  }
  check('刷新后看板重新渲染', readyEn);
  const langAfterReload = await cdp.eval('document.documentElement.lang');
  check('★ 刷新后语言仍然是英文(localStorage)', langAfterReload === 'en', `实际="${langAfterReload}"`);
  const stateAfterReload = await cdp.eval(
    'document.querySelector("article.door .state__title")?.textContent?.trim()',
  );
  check('刷新后文案仍然是英文', stateAfterReload === 'Door Open', `实际="${stateAfterReload}"`);

  // 切回中文
  await cdp.eval('document.querySelector("#lang-toggle").click()');
  await sleep(500);
  const backZh = await cdp.eval(
    'document.querySelector("article.door .state__title")?.textContent?.trim()',
  );
  check('★ 再点一次变回中文「门开着」', backZh === '门开着', `实际="${backZh}"`);
  const langBack = await cdp.eval('document.documentElement.lang');
  check('documentElement.lang 变回 zh', langBack === 'zh', `实际="${langBack}"`);

  // 中文看板截图
  const shotZh = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const shotZhPath = path.join(ARTIFACTS, 'dashboard-zh.png');
  fs.writeFileSync(shotZhPath, Buffer.from(shotZh.data, 'base64'));
  check('中文看板截图已生成', fs.existsSync(shotZhPath), shotZhPath);

  // 5. 点"管理"
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
