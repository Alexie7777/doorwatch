#!/usr/bin/env node
/**
 * 看板 UI 自动化测试(Chrome DevTools Protocol,不需要装 Playwright)。
 *
 * 覆盖真实用户路径:
 *   1. 手机尺寸(390x844)下页面正常渲染,门状态正确
 *   2. 页面是**纯只读**的:没有「管理」按钮、没有管理面板、不碰管理密钥
 *   3. 中英文切换:文案、徽章、页脚全部跟着换
 *   4. 关门提示语里的「值班微信」可点,点了弹出值班微信二维码
 *   5. 截手机版 / 桌面版效果图到 test/artifacts/
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
              closedHint: '门已关，IT 暂时不在，可联系[值班微信](wechat)',
              closedHintEn:
                'Door closed, IT is temporarily away. Contact [the on-duty WeChat](wechat).',
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

  // 默认按「系统是深色」跑,跟看板一直以来的观感一致。
  // 主题那一节里再把系统切来切去,测跟随/手动两种行为。
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
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
    '页脚显示 Powered By 不徒步 · nohike | IT Dept BIPH',
    footerInfo.text.includes('Powered By 不徒步 · nohike | IT Dept BIPH'),
    footerInfo.text.replace(/\s+/g, ' ').trim(),
  );
  const pageTitle = await cdp.eval('document.title');
  check(
    '★ 标签标题带品牌名',
    pageTitle === '不徒步 · nohike — IT 办公室状态',
    `实际="${pageTitle}"`,
  );
  const topbarTitle = await cdp.eval(
    'document.querySelector(".topbar__brand")?.textContent?.trim()',
  );
  check(
    '★ 页头大标题是品牌名',
    topbarTitle === '不徒步 · nohike',
    `实际="${topbarTitle}"`,
  );

  // ★ 陈旧 app.js 免疫(这是本次修复的核心回归)。
  //   旧版本的 app.js 里是这么写的:
  //       const title = document.querySelector('.topbar h1');
  //       if (!title) return;
  //       title.textContent = 门名;   // ← 会把品牌名盖成「IT 办公室」
  //   所以现在页头**不能有** <h1> 给它写 —— 品牌名是静态 HTML,JS 一个字都不碰。
  const staleAttack = await cdp.eval(`
    (() => {
      const before = document.querySelector('.topbar__brand')?.textContent?.trim() ?? null;
      const h1 = document.querySelector('.topbar h1');
      if (h1) h1.textContent = 'IT 办公室';
      const after = document.querySelector('.topbar__brand')?.textContent?.trim() ?? null;
      return { before, after, hasTopbarH1: !!h1 };
    })()
  `);
  check(
    '★ 陈旧 app.js 碰不到页头品牌(免疫回归)',
    staleAttack.hasTopbarH1 === false &&
      staleAttack.before === '不徒步 · nohike' &&
      staleAttack.after === '不徒步 · nohike',
    JSON.stringify(staleAttack),
  );
  const homeScreenTitle = await cdp.eval(
    'document.querySelector(\'meta[name="apple-mobile-web-app-title"]\')?.getAttribute("content")',
  );
  check(
    '★ 主屏幕图标名是短名(不会被截断)',
    homeScreenTitle === '不徒步',
    `实际="${homeScreenTitle}"`,
  );

  // ★ 缓存链:浏览器实际发出去的请求 URL 必须带版本前缀。
  //   app.js → './i18n.js' 的依赖如果不含戳,浏览器(或中间的反向代理)
  //   就能一直留旧副本 —— 症状是刷新时标题先闪一下新文案、随即被旧文案盖回去。
  //   版本戳放在**路径**里(/v/<戳>/xxx.js):很多代理的缓存键只看路径、
  //   不看查询串,只有路径变了才能保证回源拿到新的一份。
  //   这里直接看浏览器真实请求过的资源 URL,比看服务端更接近用户现场。
  const resourceUrls = await cdp.eval(
    'performance.getEntriesByType("resource").map(e => e.name)',
  );
  const i18nUrl = (resourceUrls ?? []).find((u) => u.includes('i18n.js'));
  check(
    '★ 浏览器请求的 i18n.js 带版本前缀',
    Boolean(i18nUrl && /\/v\/[^/]+\/i18n\.js$/.test(i18nUrl)),
    i18nUrl ?? '未捕获到 i18n.js 请求',
  );
  const appJsUrl = (resourceUrls ?? []).find((u) => /\/app\.js$/.test(u));
  check(
    '★ 浏览器请求的 app.js 带版本前缀',
    Boolean(appJsUrl && /\/v\/[^/]+\/app\.js$/.test(appJsUrl)),
    appJsUrl ?? '未捕获到 app.js 请求',
  );
  // theme.js 是 app.js 的模块依赖,同样的道理:不带戳就会被代理留着旧副本,
  // 症状是「主题按钮点了没反应」或者「切换后又跳回旧配色」。
  const themeJsUrl = (resourceUrls ?? []).find((u) => u.includes('theme.js'));
  check(
    '★ 浏览器请求的 theme.js 带版本前缀',
    Boolean(themeJsUrl && /\/v\/[^/]+\/theme\.js$/.test(themeJsUrl)),
    themeJsUrl ?? '未捕获到 theme.js 请求',
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
  // ★「管理」按钮整个删掉了 —— 看板现在只读,没有任何写入口
  const headerManage = await cdp.eval('!!document.querySelector("#manage-btn")');
  check('★ 页头没有「管理」按钮', headerManage === false);
  const manageSheet = await cdp.eval('!!document.querySelector("#manage-sheet")');
  check('★ 没有管理面板', manageSheet === false);
  const adminKeyInDom = await cdp.eval(
    'document.documentElement.innerHTML.includes("dw_admin_key")',
  );
  check('★ 前端不再碰管理密钥', adminKeyInDom === false);

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
    enFooterHint === 'Glance before you leave, no need to be grieved.',
    `实际="${enFooterHint}"`,
  );
  const htmlLang = await cdp.eval('document.documentElement.lang');
  check('★ documentElement.lang 变成 en', htmlLang === 'en', `实际="${htmlLang}"`);
  const enPageTitle = await cdp.eval('document.title');
  check(
    '★ 英文界面的标签标题也带品牌名',
    enPageTitle === '不徒步 · nohike — IT Office Status',
    `实际="${enPageTitle}"`,
  );
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
  const enManage = await cdp.eval('!!document.querySelector("#manage-btn")');
  check('★ 英文界面也没有「管理」按钮', enManage === false);
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

  // 5. 主题:跟随系统 / 日间 / 夜间
  console.log('\n[ui] 主题');

  /** 读当前的主题状态 */
  const themeState = () =>
    cdp.eval(`
      (() => {
        const d = document.documentElement;
        return {
          mode: d.getAttribute('data-theme-mode'),
          theme: d.getAttribute('data-theme'),
          bg: getComputedStyle(document.body).backgroundColor,
          meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
          stored: localStorage.getItem('dw_theme'),
          label: document.querySelector('#theme-toggle')?.getAttribute('aria-label') ?? null,
        };
      })()
    `);

  /** 刷新页面并等看板重新渲染出来 */
  const reloadAndWait = async () => {
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.reload', { ignoreCache: true });
    await loaded;
    for (let i = 0; i < 40; i++) {
      const n = await cdp.eval('document.querySelectorAll("article.door").length');
      if (n === 2) break;
      await sleep(250);
    }
  };

  /** 背景色的相对亮度 —— 用来断言"到底是亮是暗" */
  const lum = (rgb) => {
    const m = String(rgb).match(/[\d.]+/g);
    if (!m) return -1;
    return 0.2126 * Number(m[0]) + 0.7152 * Number(m[1]) + 0.0722 * Number(m[2]);
  };

  // A. 没有本地选择 + 系统是深色 → 跟随系统,深色
  await cdp.eval('localStorage.removeItem("dw_theme")');
  await reloadAndWait();
  const th1 = await themeState();
  check('★ 默认是「跟随系统」', th1.mode === 'auto', `实际="${th1.mode}"`);
  check('★ 系统是深色 → 页面是深色', th1.theme === 'dark', `实际="${th1.theme}"`);
  check('★ 深色模式下背景确实是深的', lum(th1.bg) < 60, `背景="${th1.bg}"`);
  check('★ theme-color 跟着主题走', th1.meta === '#0b0f14', `实际="${th1.meta}"`);

  // ★ 不闪屏:主题必须在第一帧之前就定好。
  //
  //   做不到的话,刷新时会先按深色画一帧再切成浅色 —— 屏幕"闪一下"。
  //   办法是把定主题的脚本内联到 <head> 里、排在 <body> 之前,
  //   这样第一帧渲染时就带着正确的 data-theme。
  //
  //   这条是结构性的:内联脚本位置不对,闪屏就回来了。
  const pageHtml = await (await fetch(`${BASE}/`)).text();
  const headEndAt = pageHtml.indexOf('</head>');
  const bodyAt = pageHtml.indexOf('<body');
  const themeScriptAt = pageHtml.indexOf('data-theme-mode');
  check(
    '★ 主题在 <head> 里就地定下来(排在 <body> 之前)',
    themeScriptAt > 0 && themeScriptAt < headEndAt && headEndAt < bodyAt,
    `脚本位置=${themeScriptAt} </head>=${headEndAt} <body>=${bodyAt}`,
  );
  check(
    '★ 内联脚本同时管 data-theme 和 theme-color',
    pageHtml.includes('data-theme') && pageHtml.includes('theme-color'),
  );

  // 动态:页面一加载出来,背景色就已经是目标主题(不是等 app.js 跑完才变)
  const firstBg = await cdp.eval('getComputedStyle(document.body).backgroundColor');
  check('★ 页面一加载出来背景色就是深色', lum(firstBg) < 60, `背景="${firstBg}"`);

  // B. 系统切到浅色 → 页面立刻跟着变浅(不用刷新)
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await sleep(500);
  const th2 = await themeState();
  check('★ 系统切浅色 → 页面立刻跟着变浅色', th2.theme === 'light', `实际="${th2.theme}"`);
  check('★ 浅色模式下背景确实是亮的', lum(th2.bg) > 200, `背景="${th2.bg}"`);
  check('★ theme-color 跟着变浅', th2.meta === '#f1f4f8', `实际="${th2.meta}"`);

  // C. 点按钮:跟随系统 → 日间
  await cdp.eval('document.querySelector("#theme-toggle").click()');
  await sleep(300);
  const th3 = await themeState();
  check('★ 点一下:跟随系统 → 日间', th3.mode === 'light' && th3.theme === 'light', `实际="${th3.mode}/${th3.theme}"`);
  check('★ 主题选择写进了 localStorage', th3.stored === 'light', `实际="${th3.stored}"`);
  check(
    '★ 主题按钮的标签写清了当前模式和下一个',
    /日间/.test(th3.label ?? '') && /夜间/.test(th3.label ?? ''),
    `实际="${th3.label}"`,
  );

  // D. 再点:日间 → 夜间(系统此刻是浅色,手动选的必须压过系统)
  await cdp.eval('document.querySelector("#theme-toggle").click()');
  await sleep(300);
  const th4 = await themeState();
  check('★ 再点:日间 → 夜间', th4.mode === 'dark' && th4.theme === 'dark', `实际="${th4.mode}/${th4.theme}"`);
  check('★ 手动选了夜间就不跟系统走(系统还是浅色)', th4.theme === 'dark', `实际="${th4.theme}"`);

  // E. 刷新后还是用户选的那个
  await reloadAndWait();
  const th5 = await themeState();
  check('★ 刷新后主题还是用户选的那个', th5.mode === 'dark' && th5.theme === 'dark', `实际="${th5.mode}/${th5.theme}"`);

  // F. 再点:夜间 → 回到跟随系统
  await cdp.eval('document.querySelector("#theme-toggle").click()');
  await sleep(300);
  const th6 = await themeState();
  check('★ 再点回到「跟随系统」', th6.mode === 'auto', `实际="${th6.mode}"`);
  check('★ 回到跟随系统就按系统的来(此刻系统是浅色)', th6.theme === 'light', `实际="${th6.theme}"`);

  // G. 英文界面下主题按钮也得是英文
  await cdp.eval('document.querySelector("#lang-toggle").click()');
  await sleep(500);
  const enThemeLabel = await cdp.eval(
    'document.querySelector("#theme-toggle")?.getAttribute("aria-label") ?? ""',
  );
  check(
    '★ 英文界面下主题按钮也是英文',
    /Follow system/i.test(enThemeLabel),
    `实际="${enThemeLabel}"`,
  );
  await cdp.eval('document.querySelector("#lang-toggle").click()');
  await sleep(500);

  // 浅色模式效果图
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await sleep(500);
  const shotLight = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const shotLightPath = path.join(ARTIFACTS, 'dashboard-light.png');
  fs.writeFileSync(shotLightPath, Buffer.from(shotLight.data, 'base64'));
  check('浅色模式效果图已生成', fs.existsSync(shotLightPath), shotLightPath);

  // 恢复成深色 —— 后面的截图跟以前一样
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await sleep(500);
  const backDark = await themeState();
  check('恢复成深色', backDark.theme === 'dark', `实际="${backDark.theme}"`);

  // 中文看板截图
  const shotZh = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  const shotZhPath = path.join(ARTIFACTS, 'dashboard-zh.png');
  fs.writeFileSync(shotZhPath, Buffer.from(shotZh.data, 'base64'));
  check('中文看板截图已生成', fs.existsSync(shotZhPath), shotZhPath);

  // 5. 值班微信二维码:关门提示语里的「值班微信」可点,点了弹出二维码
  console.log('\n[ui] 值班微信二维码');
  sim.publish('doorwatch/it-office-door/state', 'CLOSED', { qos: 1, retain: true });
  let closedShown = false;
  for (let i = 0; i < 40; i++) {
    const s = await cdp.eval(
      'document.querySelector("article.door .state__title")?.textContent?.trim()',
    );
    if (s === '门关着') {
      closedShown = true;
      break;
    }
    await sleep(250);
  }
  check('先把门切成「门关着」', closedShown);

  const qrLinkText = await cdp.eval(
    'document.querySelector("article.door .qr-link")?.textContent?.trim()',
  );
  check(
    '★ 关门提示语里「值班微信」是可点的',
    qrLinkText === '值班微信',
    `实际="${qrLinkText}"`,
  );
  const qrSrc = await cdp.eval(
    'document.querySelector("article.door .qr-link")?.dataset?.qr ?? ""',
  );
  check('★ 二维码路径由服务端下发', /wechat-qr\.jpg$/.test(qrSrc), `实际="${qrSrc}"`);

  await cdp.eval('document.querySelector("article.door .qr-link").click()');
  await sleep(600);
  const modalOpen = await cdp.eval(
    '!document.querySelector("#qr-modal").hasAttribute("hidden")',
  );
  check('★ 点一下弹出二维码', modalOpen === true);
  const modalImg = await cdp.eval('document.querySelector("#qr-img")?.getAttribute("src") ?? ""');
  check('★ 弹层里是那张二维码', /wechat-qr\.jpg$/.test(modalImg), `实际="${modalImg}"`);

  // 等图片真的加载完再截图,不然拍到的是空白框
  for (let i = 0; i < 40; i++) {
    const done = await cdp.eval('document.querySelector("#qr-img")?.complete ?? false');
    if (done) break;
    await sleep(150);
  }
  const shotQr = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotQrPath = path.join(ARTIFACTS, 'wechat-qr-modal.png');
  fs.writeFileSync(shotQrPath, Buffer.from(shotQr.data, 'base64'));
  check('二维码弹层截图已生成', fs.existsSync(shotQrPath), shotQrPath);

  await cdp.eval('document.querySelector("#qr-close").click()');
  await sleep(300);
  const modalClosed = await cdp.eval(
    'document.querySelector("#qr-modal").hasAttribute("hidden")',
  );
  check('★ 关闭按钮能关掉弹层', modalClosed === true);

  // 恢复开门状态,再截正常态的图
  sim.publish('doorwatch/it-office-door/state', 'OPEN', { qos: 1, retain: true });
  for (let i = 0; i < 40; i++) {
    const s = await cdp.eval(
      'document.querySelector("article.door .state__title")?.textContent?.trim()',
    );
    if (s === '门开着') break;
    await sleep(250);
  }

  // 6. 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(ARTIFACTS, 'dashboard-mobile.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  check('手机版效果图已生成', fs.existsSync(shotPath), shotPath);
  // README 首页引用的那张(以前是"关掉管理面板之后"的正常态,
  // 现在没有面板了,两张就是同一张)
  const shot2Path = path.join(ARTIFACTS, 'dashboard-mobile-normal.png');
  fs.writeFileSync(shot2Path, Buffer.from(shot.data, 'base64'));
  check('README 用的手机版图已生成', fs.existsSync(shot2Path), shot2Path);

  // 桌面尺寸也看一眼
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
