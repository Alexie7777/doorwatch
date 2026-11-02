#!/usr/bin/env node
/**
 * doctor 的端到端测试。
 *
 * 起一个假的 doorwatch 服务端,看体检脚本的判断对不对:
 *   · 链路全通   → 退出码 0,结论是「链路已通」
 *   · 服务端挂了 → 退出码非 0,并给出拉起服务端的命令
 *   · 服务端活着但没数据 → 结论要指向 HA 那几项排查
 *
 * 运行: node test/doctor.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures += 1;
}

const ROOT = path.resolve(import.meta.dirname, '..');

/** 假 doorwatch 的行为开关 */
let mode = 'ok';

const server = http.createServer((req, res) => {
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/api/health') {
    json({
      ok: true,
      version: '1.0.0',
      uptimeSec: 600,
      doors: 1,
      mqtt: {
        embedded: true,
        brokerPort: 1883,
        clients: mode === 'ok' ? 2 : 0,
        topicPrefix: 'doorwatch',
      },
    });
    return;
  }
  if (req.url === '/api/doors') {
    json({
      doors: [
        {
          id: 'd1',
          name: 'IT 办公室门',
          deviceId: 'it-office-door',
          state: mode === 'ok' ? 'open' : 'unknown',
          online: mode === 'ok',
          lastSeenAt: mode === 'ok' ? Date.now() - 5000 : null,
        },
      ],
      now: Date.now(),
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function runDoctor(extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'tools', 'doctor.mjs'), '--doorwatch', `http://127.0.0.1:${port}`, ...extraArgs],
      { cwd: ROOT },
    );
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

console.log('\n[test] doctor:链路全通');
mode = 'ok';
const ok = await runDoctor();
check('退出码为 0', ok.code === 0, `退出码 ${ok.code}`);
check('报告服务端可达', ok.out.includes('服务可达'));
check('报告了 MQTT 客户端数', ok.out.includes('2 个客户端连着'));
check('把 open 翻成「门开着」', ok.out.includes('门开着'));
check('deviceId 两边对得上', ok.out.includes('两边对得上'));
check('结论是链路已通', ok.out.includes('链路已通'));
check('提示了手机怎么用', ok.out.includes('主屏幕'));

console.log('\n[test] doctor:服务端活着但没数据');
mode = 'empty';
const empty = await runDoctor();
check('退出码非 0', empty.code !== 0, `退出码 ${empty.code}`);
check('提示 MQTT 没有客户端', empty.out.includes('一个客户端都没有'));
check('结论指向 HA 的排查步骤', empty.out.includes('检查配置'));
check('提醒了 MQTT 端口是 1883 不是 8123', empty.out.includes('1883'));

console.log('\n[test] doctor:服务端连不上');
const down = await runDoctor(['--doorwatch', 'http://127.0.0.1:1']);
check('退出码非 0', down.code !== 0, `退出码 ${down.code}`);
check('给出了拉起服务端的命令', down.out.includes('docker compose'));
check('结论说明服务端没起来', down.out.includes('服务端没起来'));

/* ------------------------------------------------------------------ *
 * 假 HA:验证 https 写错时能自动降级,以及自动化检查
 * ------------------------------------------------------------------ */
console.log('\n[test] doctor:连 HA(故意用 https 写错)');

/** 假 HA 的行为开关:'ok' 正常 | 'unavailable' 模板实体炸了 */
let haMode = 'ok';

const haServer = http.createServer((req, res) => {
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/api/states') {
    const now = new Date().toISOString();
    json([
      {
        entity_id: 'sensor.doorwatch_it_office_door_state',
        state: haMode === 'unavailable' ? 'unavailable' : 'OPEN',
        attributes: { friendly_name: 'Doorwatch IT Office Door State' },
        last_updated: now,
      },
      {
        entity_id: 'binary_sensor.doorwatch_it_office_door_readable',
        state: 'on',
        attributes: { friendly_name: 'Doorwatch IT Office Door Readable' },
        last_updated: now,
      },
      {
        entity_id: 'binary_sensor.isa_dw2hl_b95b_magnet_sensor',
        state: 'off',
        attributes: { friendly_name: '门磁' },
        last_updated: now,
        last_reported: now,
      },
      {
        entity_id: 'automation.doorwatch_it_office_report',
        state: 'on',
        attributes: { friendly_name: '每分钟体检 → doorwatch(IT 办公室)', last_triggered: now },
        last_updated: now,
      },
    ]);
    return;
  }
  // HA 的模板接口:POST /api/template {"template": "..."} → {"result": "..."}
  if (req.url === '/api/template' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let tpl = '';
      try { tpl = JSON.parse(body || '{}').template ?? ''; } catch { /* 忽略 */ }
      if (haMode === 'unavailable') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: "Template error: as_timestamp got invalid input Undefined",
        }));
        return;
      }
      // 模拟 HA 的渲染结果:sensor 出状态文本,binary_sensor 出布尔
      json({ result: /true if/.test(tpl) ? 'True' : 'CLOSED' });
    });
    return;
  }
  // HA 的错误日志
  if (req.url === '/api/error_log') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(haMode === 'unavailable'
      ? '2026-10-21 09:00:00 ERROR (MainThread) [homeassistant.components.template.template_entity] '
        + 'Error rendering template for sensor.doorwatch_it_office_door_state: '
        + "Template error: as_timestamp got invalid input Undefined\n"
      : '2026-10-21 09:00:00 INFO (MainThread) [homeassistant.core] 一切正常\n');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
await new Promise((resolve) => haServer.listen(0, '127.0.0.1', resolve));
const haPort = haServer.address().port;

/** 跑一次 doctor,带上 HA 的参数 */
function runDoctorHa(haUrl, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, 'tools', 'doctor.mjs'),
        '--doorwatch', `http://127.0.0.1:${port}`,
        '--ha', haUrl,
        '--token', 'test-token',
        ...extraArgs,
      ],
      { cwd: ROOT },
    );
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

// HA 默认是 http,用户很可能写成 https —— 工具要能自己降级
const ha = await runDoctorHa(`https://127.0.0.1:${haPort}`);

check('https 写错时自动降级成 http 并连上', ha.out.includes('门状态模板 = OPEN'), '没连上 HA');
check('提示了降级原因', ha.out.includes('已自动改用 http'));
check('校验出可读性模板是 on/off', ha.out.includes('可读性模板 = on'));
check('打印了原始门磁实体', ha.out.includes('原始门磁实体'));
check('列出了 doorwatch 的自动化', ha.out.includes('每分钟体检'));
check('报告了自动化上次触发时间', ha.out.includes('上次触发'));
check('把仓库里的模板拿去 HA 现场渲染了', ha.out.includes('现场渲染'));
check('报出了现场渲染的结果', ha.out.includes('→ CLOSED'),
  ha.out.split('\n').filter((l) => l.includes('现场渲染')).join(' | '));
check('查了 HA 错误日志', ha.out.includes('错误日志'));

console.log('\n[test] doctor:模板实体 unavailable(线上事故现场)');
haMode = 'unavailable';
const broken = await runDoctorHa(`http://127.0.0.1:${haPort}`);
check('报出门状态模板 = unavailable', broken.out.includes('门状态模板 = unavailable'));
check('说清了是模板渲染抛异常', broken.out.includes('模板渲染抛异常'));
check('现场渲染失败时把 HA 的报错原文带出来', broken.out.includes('as_timestamp got invalid input'));
check('把错误日志里的 doorwatch 报错打出来了', broken.out.includes('Error rendering template'));
check('退出码非 0', broken.code !== 0, `退出码 ${broken.code}`);
haMode = 'ok';

console.log('\n[test] doctor:HA 里没有自动化');
haServer.removeAllListeners('request');
haServer.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([]));
});
const noAuto = await runDoctorHa(`http://127.0.0.1:${haPort}`);
check('报出「没有 doorwatch 相关的自动化」', noAuto.out.includes('没有 doorwatch 相关的自动化'));
check('指出了 configuration.yaml 缺 include', noAuto.out.includes('automation: !include automations.yaml'));

haServer.close();
server.close();

console.log(`\n${failures === 0 ? '✅ doctor 测试全部通过' : `❌ ${failures} 项未通过`}\n`);
process.exit(failures ? 1 : 0);
