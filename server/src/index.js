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
 * 用途:index.html 里引用 /style.css、/app.js 时带上 ?v=<戳>。
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

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
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

  let body;
  if (ext === '.html') {
    const stamp = buildStamp();
    body = Buffer.from(
      fs
        .readFileSync(target, 'utf8')
        .replace(/(\/(?:style\.css|app\.js))(["'])/g, `$1?v=${stamp}$2`),
      'utf8',
    );
  } else {
    body = fs.readFileSync(target);
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // 一律 no-cache:资源很小,让浏览器每次跟服务器校验一下,
    // 改完样式/逻辑刷新即生效。离线缓存由 Service Worker 负责,不需要 HTTP 缓存。
    'Cache-Control': 'no-cache',
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
