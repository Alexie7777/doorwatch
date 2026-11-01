#!/usr/bin/env node
/**
 * 端口占用检查 —— 部署 doorwatch 前先跑一下。
 *
 * 「端口又被占了」是部署时最常见的一类卡点:
 * 上一次测试没退干净、或者别的服务正好在监听,
 * 表现是容器起不来、日志里一句 EADDRINUSE,
 * 但看不出是谁占的。这个脚本直接告诉你「谁占着」。
 *
 * 用法:
 *   node tools/check-ports.mjs              # 只看
 *   node tools/check-ports.mjs --kill       # 看 + 结束占用进程(谨慎)
 *   node tools/check-ports.mjs 9000 1883    # 自定义端口
 *
 * 判定方式:直接尝试 bind 一下这个端口。
 * 能绑上 = 端口是空的(和 doorwatch 启动时的行为完全一致);
 * 绑不上 = 有人占着。这比看 netstat 准,不会把 TIME_WAIT 之类的算进来。
 */
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);

const DEFAULT_PORTS = [
  { port: 8443, label: '看板 HTTPS' },
  { port: 1883, label: 'MQTT broker' },
];

const args = process.argv.slice(2);
const wantKill = args.includes('--kill');
const custom = args.filter((a) => /^\d+$/.test(a)).map(Number);

const ports = custom.length
  ? custom.map((p) => ({ port: p, label: '自定义' }))
  : DEFAULT_PORTS;

/** 试一下这个端口能不能绑 —— 能绑就是空的 */
function probe(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve({ free: false, code: err.code }));
    srv.once('listening', () => {
      srv.close(() => resolve({ free: true }));
    });
    srv.listen({ port, host: '0.0.0.0', exclusive: true });
  });
}

/** 找出占用进程(平台差异较大,尽力而为) */
async function findOwner(port) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP']);
      const lines = stdout.split(/\r?\n/).filter((l) => l.includes(`:${port}`) && /LISTENING/i.test(l));
      const pids = [...new Set(lines.map((l) => (l.trim().split(/\s+/).pop() || '')).filter(Boolean))];
      if (!pids.length) return null;
      const names = [];
      for (const pid of pids) {
        try {
          const { stdout: t } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
          const m = t.match(/^(\S+)\s+(\d+)\s+/m);
          names.push({ pid, name: m ? m[1] : '未知' });
        } catch {
          names.push({ pid, name: '未知' });
        }
      }
      return names;
    } catch {
      return null;
    }
  }

  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('ss', ['-tlnpH']);
      const lines = stdout.split(/\r?\n/).filter((l) => l.includes(`:${port}`));
      const out = [];
      for (const l of lines) {
        const pid = l.match(/pid=(\d+)/)?.[1];
        const name = l.match(/users:\(\("([^"]+)"/)?.[1];
        if (pid) out.push({ pid, name: name || '未知' });
      }
      return out.length ? out : null;
    } catch {
      return null;
    }
  }

  // macOS / 其他
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    const out = [];
    for (const l of stdout.split(/\r?\n/).slice(1)) {
      const p = l.trim().split(/\s+/);
      if (p.length >= 2) out.push({ pid: p[1], name: p[0] });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

async function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/F']);
    } else {
      process.kill(Number(pid), 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

console.log('\n端口占用检查\n');
let busy = 0;

for (const { port, label } of ports) {
  const r = await probe(port);
  if (r.free) {
    console.log(`  ${String(port).padEnd(6)} ${label.padEnd(14)} 空闲 ✅`);
    continue;
  }
  busy++;
  console.log(`  ${String(port).padEnd(6)} ${label.padEnd(14)} 被占用 ❌  (${r.code})`);

  const owners = await findOwner(port);
  if (!owners) {
    console.log('          占用进程:查不到(可能是别的用户/容器/WSL 转发)');
    console.log('          Linux 上再试: sudo ss -tlnp | grep ' + port);
    continue;
  }
  for (const o of owners) {
    console.log(`          占用进程: ${o.name}  (PID ${o.pid})`);
    if (wantKill) {
      const ok = await killPid(o.pid);
      console.log(`          ${ok ? '已结束该进程' : '结束失败(可能需要管理员权限)'}`);
    }
  }
}

console.log('');
if (!busy) {
  console.log('全部空闲,可以部署。\n');
} else if (wantKill) {
  console.log('已尝试清理占用进程,再跑一次确认。\n');
} else {
  console.log('有端口被占用。确认是自己上次的残留再执行:');
  console.log('  node tools/check-ports.mjs --kill');
  console.log('或者手动看是谁:');
  console.log('  Windows  netstat -ano | findstr ":8443"');
  console.log('  Linux    ss -tlnp | grep -E ":(8443|1883)"');
  console.log('');
}

process.exit(busy && !wantKill ? 1 : 0);
