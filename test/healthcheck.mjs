#!/usr/bin/env node
/**
 * 部署 healthcheck 的回归测试。
 *
 * 为什么需要它:
 *   healthcheck 那段 `node -e "..."` 藏在 deploy/Dockerfile 和
 *   deploy/docker-compose.yml 里,语法写错、或者用了 `fetch` 走 https
 *   撞上自签证书 —— 这两种情况都不会让服务挂掉,只会让容器一直显示
 *   unhealthy,docker compose ps 里看着"起来了"其实没人管。
 *
 *   这个测试做三件事:
 *     1. 把两个部署文件里的 healthcheck 表达式**抽出来对比** —— 它们必须一模一样,
 *        否则改了一个忘了改另一个,迟早出事
 *     2. 语法检查(括号少一个这种低级错误当场就炸)
 *     3. 拿**真实的服务进程**分别以纯 HTTP 和纯 HTTPS 两种模式跑一遍,
 *        看退出码对不对;再确认"什么都不监听"时必须判 unhealthy
 *
 * 运行: node test/healthcheck.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = path.resolve(import.meta.dirname, '..');
const PLAIN_PORT = 18443;
const HTTPS_PORT = 18444;

let failures = 0;
function check(name, cond, extra = '') {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 1. 从两个部署文件里把 healthcheck 表达式抽出来
 * ------------------------------------------------------------------ */

/** Dockerfile:HEALTHCHECK ... CMD node -e "<表达式>" */
function extractFromDockerfile() {
  const text = fs.readFileSync(path.join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
  const m = text.match(/CMD\s+node\s+-e\s+"([^"]+)"/);
  return m ? m[1] : null;
}

/** docker-compose.yml:healthcheck.test 里的 CMD / node / -e 那一组 */
function extractFromCompose() {
  const text = fs.readFileSync(path.join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');
  const doc = YAML.parse(text);
  const test = doc?.services?.doorwatch?.healthcheck?.test;
  if (!Array.isArray(test)) return null;
  const i = test.indexOf('-e');
  if (i < 0 || i + 1 >= test.length) return null;
  return String(test[i + 1]);
}

const fromDockerfile = extractFromDockerfile();
const fromCompose = extractFromCompose();

check('Dockerfile 里能抽出 healthcheck 表达式', !!fromDockerfile);
check('docker-compose.yml 里能抽出 healthcheck 表达式', !!fromCompose);
check(
  '两个部署文件的 healthcheck 表达式完全一致',
  fromDockerfile && fromCompose && fromDockerfile === fromCompose,
);

if (!fromDockerfile || !fromCompose) {
  console.log('\n❌ 抽不出表达式,后面的用例没法跑');
  process.exit(1);
}

const EXPR = fromDockerfile;

/* ------------------------------------------------------------------ *
 * 2. 语法检查
 * ------------------------------------------------------------------ */
try {
  // eslint-disable-next-line no-new-func
  new Function(`return (async()=>{${EXPR}})()`);
  check('表达式语法正确', true);
} catch (err) {
  check('表达式语法正确', false, String(err.message));
  console.log('\n❌ 语法都不对,后面的用例没法跑');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 3. 拿真实服务跑
 * ------------------------------------------------------------------ */

/** 把表达式里的端口换成测试端口 —— 部署里写死 8443,测试要用别的端口 */
function exprForPort(port) {
  return EXPR.split('127.0.0.1:8443').join(`127.0.0.1:${port}`);
}

/**
 * 跑一次 healthcheck,拿退出码。
 * 必须用异步 spawn:execFileSync 会阻塞本进程的事件循环,
 * 而服务端虽然在本进程起(纯 HTTP 用例),会被自己饿死。
 */
function runHealthcheck(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', exprForPort(port)], {
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(124); // 超时,当成失败
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** 起一个真实的服务进程 */
function startServer({ https, port }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorwatch-hc-'));
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'src', 'index.js')],
    {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        HTTPS: https ? 'true' : 'false',
        PORT: String(port),
        HTTP_PORT: '0',
        MQTT_PORT: String(port + 100),
        DOORS_JSON: JSON.stringify({ doors: [{ id: 'it-office', name: 'IT 办公室', deviceId: 'it-office-door' }] }),
      },
      stdio: 'ignore',
    },
  );
  return { child, dataDir };
}

/**
 * 停掉服务进程,并**等它真的退出**。
 * 不等的话,下一个测试可能在服务还没退干净的时候就开始,
 * 端口还占着、CPU 还在转,后面那些卡时间阈值的断言就会莫名其妙地超时。
 */
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
}

/** 等服务起来(HTTP 和 HTTPS 都探一下) */
async function waitForHealth(port, isHttps) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const lib = isHttps ? https : http;
      const req = lib.get(
        `http${isHttps ? 's' : ''}://127.0.0.1:${port}/api/health`,
        isHttps ? { rejectUnauthorized: false } : {},
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

// --- 用例 1:纯 HTTP 部署 ---
{
  const { child } = startServer({ https: false, port: PLAIN_PORT });
  const up = await waitForHealth(PLAIN_PORT, false);
  check('纯 HTTP 服务起来了', up);
  if (up) {
    const code = await runHealthcheck(PLAIN_PORT);
    check('纯 HTTP 部署 → healthcheck 退出码 0', code === 0, `实际 ${code}`);
  }
  await stopServer(child);
}

/* --- 用例 2:纯 HTTPS 部署(自签证书) --- */
{
  const { child } = startServer({ https: true, port: HTTPS_PORT });
  const up = await waitForHealth(HTTPS_PORT, true);
  check('纯 HTTPS 服务起来了(自签证书)', up);
  if (up) {
    const code = await runHealthcheck(HTTPS_PORT);
    check(
      '纯 HTTPS 部署 → healthcheck 退出码 0',
      code === 0,
      `实际 ${code}  (用 fetch 走 https 会被自签证书拒掉 → 永远 unhealthy)`,
    );
  }
  await stopServer(child);
}

/* --- 用例 3:什么都不监听 → 必须 unhealthy --- */
{
  const code = await runHealthcheck(PLAIN_PORT);
  check('服务不在 → healthcheck 退出码非 0', code !== 0, `实际 ${code}`);
}

console.log('');
if (failures === 0) {
  console.log('🎉 healthcheck 测试全部通过');
} else {
  console.log(`❌ ${failures} 条失败`);
}
process.exit(failures === 0 ? 0 : 1);
