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

server.close();

console.log(`\n${failures === 0 ? '✅ doctor 测试全部通过' : `❌ ${failures} 项未通过`}\n`);
process.exit(failures ? 1 : 0);
