import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from './config.js';
import {
  openDb,
  syncRegistry,
  listDoors,
  getDoor,
  listEvents,
  listRecentEvents,
  todayStats,
  setOverride,
} from './db.js';
import { toPublic, effectiveState } from './state.js';
import { currentSnapshot, pushState } from './live.js';
import { sseHub } from './sse.js';
import { ensureCert } from './certs.js';
import { loadDoorRegistry } from './doors.js';
import { startBroker, stopBroker, brokerStatus } from './broker.js';

/* ------------------------------------------------------------------ *
 * 管理员密钥
 * ------------------------------------------------------------------ */

function resolveAdminKey() {
  if (config.adminKey) return config.adminKey;
  if (fs.existsSync(paths.adminKeyFile)) {
    return fs.readFileSync(paths.adminKeyFile, 'utf8').trim();
  }
  const key = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(paths.adminKeyFile, key, { mode: 0o600 });
  console.log(`[doorwatch] 已生成管理密钥,写入 ${paths.adminKeyFile}`);
  return key;
}

const adminKey = resolveAdminKey();

function isAdmin(req, url) {
  const headerKey = req.headers['x-admin-key'];
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryKey = url.searchParams.get('key') ?? '';
  const provided = [headerKey, bearer, queryKey].filter(Boolean);
  if (provided.length === 0) return false;
  return provided.some((k) => k === adminKey);
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * 给页面资源算一个版本戳。
 *
 * 用途:index.html 里引用 /style.css、/app.js 时带上版本前缀。
 * 一旦改过这些文件,戳就变,URL 也就变,浏览器和 Service Worker
 * 都不会再拿旧版资源出来 —— 内部工具改完刷新就得生效,不能等缓存过期。
 */
let cachedStamp = null;
function buildStamp() {
  if (cachedStamp) return cachedStamp;
  let newest = 0;
  try {
    for (const name of fs.readdirSync(config.publicDir)) {
      const p = path.join(config.publicDir, name);
      const st = fs.statSync(p);
      if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
    }
  } catch {
    /* 目录不存在就退化成版本号 */
  }
  cachedStamp = `${config.version}-${Math.floor(newest).toString(36)}`;
  return cachedStamp;
}

/**
 * 静态资源的版本前缀。
 *
 * ★ 为什么把戳放在**路径**里,而不是用 ?v=<戳> 查询参数:
 *
 *   查询参数这一层,很多反向代理的缓存键只看路径($uri),不看查询串。
 *   戳变了、URL 的查询串变了,缓存的键却没变 —— 代理照样把旧的那份
 *   app.js 发给浏览器。症状是:页面先闪一下新标题,又被旧文案盖回去。
 *   (这个坑真踩过,见 README「页面资源带版本戳」那条。)
 *
 *   放进路径里就不一样了:/v/<戳>/app.js —— 不管代理怎么算缓存键,
 *   路径变了就是一条全新的缓存,一定回源。
 *
 *   注意:服务端不按戳挑内容,任何 /v/<任意戳>/xxx 都返回**当前这一版**。
 *   所以哪怕浏览器手里攥着旧的外壳,它引用的资源也一定是新的。
 */
function versionPrefix(stamp) {
  return `/v/${stamp}`;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;

  // 版本化路径:/v/<戳>/<文件> —— 去掉前缀,取当前这一版的内容
  const vm = /^\/v\/[^/]+(\/.*)$/.exec(rel);
  if (vm) rel = vm[1];

  // 目录穿越防护
  const target = path.resolve(config.publicDir, `.${rel}`);
  if (!target.startsWith(path.resolve(config.publicDir))) {
    json(res, 403, { error: '非法路径', errorKey: 'bad_path' });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    json(res, 404, { error: '页面不存在', errorKey: 'page_not_found' });
    return;
  }
  const ext = path.extname(target).toLowerCase();
  const st = fs.statSync(target);
  const stamp = buildStamp();

  // ★ ETag 要把 buildStamp() 也算进去。
  //   因为正文是被改写过的(注入 ?v=戳),别的文件一变,这份的正文也跟着变;
  //   只用本文件的 mtime/size 算 ETag,会出现"这份没变 → 回 304"，
  //   而实际上它引用的戳变了、正文已经不同 —— 浏览器就一直拿着旧版。
  const etag = `W/"${stamp}-${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(16)}"`;

  // 条件请求:浏览器/中间代理拿 ETag 来问"变了吗",没变就回 304,不重传正文。
  // 有了这个,即使某个资源漏了版本戳,也不会一直用旧副本。
  const inm = String(req.headers['if-none-match'] ?? '')
    .split(',')
    .map((s) => s.trim());
  if (inm.includes(etag) || inm.includes('*')) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }

  let body;
  const prefix = versionPrefix(stamp);

  // 资源路径里带版本前缀的正则(HTML 和 manifest 共用)
  const ASSET_PATH = /(\/[\w.-]+\.(?:css|js|svg|webmanifest|png|jpe?g|gif|ico|webp))(["'])/g;

  if (ext === '.html') {
    // ★ index.html 里引用的**每一个**本地静态资源都要带版本前缀:
    //   style.css / app.js / icon.svg / manifest.webmanifest ……
    //   URL 恒定不变 = 可能被浏览器或中间代理一直留着旧副本。
    //   只给 app.js 加戳、漏掉 icon.svg,改完图标手机上还是旧的 —— 一模一样的坑。
    body = Buffer.from(
      fs.readFileSync(target, 'utf8').replace(ASSET_PATH, `${prefix}$1$2`),
      'utf8',
    );
  } else if (ext === '.webmanifest') {
    // manifest 里的图标也一样要带前缀(主屏幕图标改了得能换掉)
    // start_url / scope 是页面路径,不能动 —— 正则只认带扩展名的资源。
    body = Buffer.from(
      fs.readFileSync(target, 'utf8').replace(ASSET_PATH, `${prefix}$1$2`),
      'utf8',
    );
  } else if (ext === '.js') {
    // ★ 模块依赖也要带版本前缀。
    //   app.js 里 import 的 './i18n.js' 如果不带戳,它的 URL 永远不变,
    //   浏览器(或中间的反向代理)可以一直留着旧副本。
    //   实测出来的症状:页面先闪一下新标题,又被旧 i18n.js 里的文案盖回去。
    //   这里改成**绝对**的版本化路径,不管 app.js 自己是从哪个 URL 来的,
    //   依赖都指向同一份版本化资源。
    body = Buffer.from(
      fs
        .readFileSync(target, 'utf8')
        .replace(/(['"])\.\/([\w.-]+\.js)\1/g, `$1${prefix}/$2$1`)
        // Service Worker 里的 __STAMP__ 占位符 → 当前这一版的版本前缀
        .replaceAll('__STAMP__', prefix),
      'utf8',
    );
  } else {
    body = fs.readFileSync(target);
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    ETag: etag,
    // 一律 no-cache:资源很小,让浏览器每次跟服务器校验一下,
    // 改完样式/逻辑刷新即生效。离线缓存由 Service Worker 负责,不需要 HTTP 缓存。
    // HTML 外壳额外禁存 —— 它引用的是带戳的资源,外壳本身必须永远是最新的那一份。
    'Cache-Control': ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'no-cache',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, sub] = seg;

  // GET /api/health
  if (resource === 'health' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      version: config.version,
      // 构建指纹:public/ 里任何文件改过都会变。
      // 排查「我明明重新部署了,页面怎么还是旧的」时,先看这一行 ——
      // 它和浏览器地址栏里 /v/<戳>/app.js 里那个戳是同一个。
      build: buildStamp(),
      uptimeSec: Math.round(process.uptime()),
      doors: listDoors().length,
      mqtt: brokerStatus(),
      sseClients: sseHub.size,
      now: Date.now(),
    });
    return true;
  }

  // GET /api/doors
  if (resource === 'doors' && !id && req.method === 'GET') {
    json(res, 200, { doors: currentSnapshot(), now: Date.now() });
    return true;
  }

  // /api/doors/:id ...
  if (resource === 'doors' && id) {
    const door = getDoor(id);
    if (!door) {
      json(res, 404, { error: '没有这扇门', errorKey: 'no_such_door' });
      return true;
    }

    // GET /api/doors/:id
    if (!sub && req.method === 'GET') {
      const now = Date.now();
      const pub = toPublic(door, now);
      pub.stats = todayStats(door.id, now);
      json(res, 200, { door: pub });
      return true;
    }

    // GET /api/doors/:id/events
    if (sub === 'events' && req.method === 'GET') {
      const limit = url.searchParams.get('limit') ?? '100';
      const events = listEvents(door.id, limit);
      json(res, 200, { doorId: door.id, events, stats: todayStats(door.id) });
      return true;
    }

    // POST /api/doors/:id/state  —— 外部系统推门磁状态(webhook 通道)
    if (sub === 'state' && req.method === 'POST') {
      if (!isAdmin(req, url)) {
        json(res, 401, { error: '需要管理密钥', errorKey: 'need_admin_key' });
        return true;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        json(res, 400, { error: '请求体不是合法 JSON', errorKey: 'bad_json' });
        return true;
      }
      const state = body.state === 'open' || body.state === 'closed' ? body.state : null;
      if (!state) {
        json(res, 400, { error: 'state 必须是 open 或 closed', errorKey: 'bad_state' });
        return true;
      }
      const { recordState } = await import('./db.js');
      const { changed } = recordState(door.device_id, state);
      if (changed) pushState();
      json(res, 200, { ok: true, changed, door: toPublic(getDoor(door.id)) });
      return true;
    }

    // POST /api/doors/:id/override  —— 人工置顶(如全员出差,钉死"别来")
    if (sub === 'override' && req.method === 'POST') {
      if (!isAdmin(req, url)) {
        json(res, 401, { error: '需要管理密钥', errorKey: 'need_admin_key' });
        return true;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        json(res, 400, { error: '请求体不是合法 JSON', errorKey: 'bad_json' });
        return true;
      }
      const state = body.state === 'open' || body.state === 'closed' ? body.state : null;
      if (!state) {
        json(res, 400, { error: 'state 必须是 open 或 closed', errorKey: 'bad_state' });
        return true;
      }
      const hours = Number(body.hours ?? 0);
      const until = hours > 0 ? Date.now() + hours * 3600_000 : null;
      setOverride(door.id, state, until);
      pushState();
      json(res, 200, { ok: true, door: toPublic(getDoor(door.id)) });
      return true;
    }

    // DELETE /api/doors/:id/override
    if (sub === 'override' && req.method === 'DELETE') {
      if (!isAdmin(req, url)) {
        json(res, 401, { error: '需要管理密钥', errorKey: 'need_admin_key' });
        return true;
      }
      setOverride(door.id, null, null);
      pushState();
      json(res, 200, { ok: true, door: toPublic(getDoor(door.id)) });
      return true;
    }
  }

  // GET /api/admin/verify —— 校验管理密钥,没有任何副作用
  // 注意这是 3 段路径:解构后 resource='admin'、id='verify'、sub=undefined
  if (resource === 'admin' && id === 'verify' && req.method === 'GET') {
    if (!isAdmin(req, url)) {
      json(res, 401, { error: '管理密钥不正确', errorKey: 'bad_admin_key' });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/events
  if (resource === 'events' && req.method === 'GET') {
    json(res, 200, { events: listRecentEvents(url.searchParams.get('limit') ?? '50') });
    return true;
  }

  // GET /api/stream —— SSE
  if (resource === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`event: doors\ndata: ${JSON.stringify(currentSnapshot())}\n\n`);
    sseHub.add(res);

    // 保活注释,防止中间代理把闲置连接掐掉
    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(timer);
      }
    }, 25_000);
    res.on('close', () => clearInterval(timer));
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });

  // ★ 值班微信二维码也走版本化路径。
  //   换人值班时只换 public/wechat-qr.jpg 这张图,URL 不变的话
  //   浏览器(或中间代理)可能还拿着旧图 —— 和 app.js 陈旧是同一个坑。
  //   config.wechatQr 在 toPublic() 里是每次现读的,这里改了就生效。
  if (
    typeof config.wechatQr === 'string' &&
    config.wechatQr.startsWith('/') &&
    !config.wechatQr.startsWith('/v/')
  ) {
    config.wechatQr = `${versionPrefix(buildStamp())}${config.wechatQr}`;
  }

  const registry = loadDoorRegistry();
  openDb();
  syncRegistry(registry);
  console.log(`[doorwatch] 已登记 ${registry.length} 扇门: ${registry.map((d) => d.name).join('、')}`);

  // 把每扇门该发到哪个主题打印出来 —— 传感器配错了照着这个改就行
  for (const d of registry) {
    console.log(`[doorwatch]   ${d.name}  ←  主题前缀 ${config.topicPrefix}/${d.deviceId}`);
  }

  await startBroker();

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS:允许内网其它页面嵌入(比如学校门户放个入口)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (!handled) json(res, 404, { error: '接口不存在', errorKey: 'api_not_found' });
        return;
      }
      serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error('[http] 处理请求出错:', err);
      if (!res.headersSent) json(res, 500, { error: '服务器内部错误', errorKey: 'server_error' });
      else res.end();
    }
  };

  let server;
  if (config.https) {
    const { key, cert, source } = ensureCert();
    server = https.createServer({ key, cert }, handler);
    console.log(`[doorwatch] 证书来源: ${source}`);
    console.log(`[doorwatch] 访问地址: https://<本机IP>:${config.port}`);
  } else {
    server = http.createServer(handler);
    console.log(`[doorwatch] 访问地址: http://<本机IP>:${config.port}`);
  }

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[doorwatch] 看板已启动,端口 ${config.port}`);

  if (config.httpPort > 0) {
    // ★ 纯 HTTP 端口**直接提供看板**,不是跳转到 HTTPS。
    //   为什么改:微信内置浏览器打不开自签证书的 HTTPS ——
    //   它直接显示「无法访问此网站」,连「高级 → 继续前往」那个按钮都不给。
    //   跳转过去还是同一个证书错误,毫无意义。
    //   要让人能在微信里点开链接,就得有一条真正的 HTTP 通路。
    //
    //   两种常见摆法:
    //     HTTPS=true  + HTTP_PORT=8080 → 8443 走 HTTPS(给 PWA),8080 走 HTTP(给微信)
    //     HTTPS=false + HTTP_PORT=0    → 8443 直接走 HTTP(最简单,当前部署就是这样)
    const plain = http.createServer(handler);
    await new Promise((resolve) => plain.listen(config.httpPort, config.host, resolve));
    console.log(
      `[doorwatch] 纯 HTTP 端口(微信等内置浏览器走这个): ${config.httpPort}`,
    );
  }

  const shutdown = async (sig) => {
    console.log(`\n[doorwatch] 收到 ${sig},正在退出...`);
    server.close();
    await stopBroker();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[doorwatch] 启动失败:', err);
  process.exit(1);
});
