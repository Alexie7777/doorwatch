import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, paths } from './config.js';

/**
 * 自签证书生成。
 *
 * 用系统的 openssl 命令行,而不是 npm 包(node-forge 有未修复的高危公告,
 * 而它唯一的用途就是造证书,没必要为这个背一个安全债)。
 *
 * 三种来源,优先级从高到低:
 *   1. CERT_FILE / KEY_FILE —— 学校内网 CA 签发的正式证书(推荐)
 *   2. data/cert/ 下已有的文件 —— 复用上次生成的
 *   3. 用 openssl 现生成一张自签证书
 */

/** 列出本机所有非内网 IPv4 地址 */
export function lanAddresses() {
  const out = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const ni of os.networkInterfaces()[name] ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push(ni.address);
    }
  }
  return out;
}

/** 找一个可用的 openssl */
export function findOpenSSL() {
  if (config.opensslPath) {
    if (!fs.existsSync(config.opensslPath)) {
      throw new Error(`OPENSSL_PATH 指向的文件不存在: ${config.opensslPath}`);
    }
    return config.opensslPath;
  }

  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
  ];

  for (const c of candidates) {
    if (c.includes('\\') || c.startsWith('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      // PATH 里的:实际跑一下确认能用
      const r = spawnSync(c, ['version'], { encoding: 'utf8', shell: false });
      if (r.status === 0) return c;
    }
  }
  return null;
}

function buildSubjectAltName() {
  const dns = new Set(['localhost']);
  const ips = new Set(['127.0.0.1']);

  const host = os.hostname();
  if (host) dns.add(host);
  for (const ip of lanAddresses()) ips.add(ip);
  for (const name of config.certNames) {
    // 形如 192.168.1.20 的当 IP,其余当域名
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) ips.add(name);
    else dns.add(name);
  }

  const parts = [];
  for (const d of dns) parts.push(`DNS:${d}`);
  for (const ip of ips) parts.push(`IP:${ip}`);
  return parts.join(',');
}

function generateSelfSigned(certPath, keyPath) {
  const openssl = findOpenSSL();
  if (!openssl) {
    throw new Error(
      [
        '找不到 openssl,无法自动生成自签证书。三个办法挑一个:',
        '  1) 装 openssl(Windows: winget install ShiningLight.OpenSSL;Linux: apt install openssl)',
        '  2) 用学校内网 CA 签发的证书,设置 CERT_FILE / KEY_FILE 环境变量',
        '  3) 手动生成后放进 ' + paths.cert + ' 目录,文件名固定为 server.crt / server.key',
      ].join('\n'),
    );
  }

  fs.mkdirSync(paths.cert, { recursive: true });

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '825',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    `/CN=${os.hostname() || 'doorwatch'}`,
    '-addext',
    `subjectAltName=${buildSubjectAltName()}`,
  ];

  const r = spawnSync(openssl, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`openssl 生成证书失败:\n${r.stderr || r.stdout || '(无输出)'}`);
  }
  return 'openssl 自签';
}

/**
 * 拿到可用的证书。返回 {key, cert, source}
 */
export function ensureCert() {
  // 1) 自带证书
  if (config.certFile && config.keyFile) {
    if (!fs.existsSync(config.certFile) || !fs.existsSync(config.keyFile)) {
      throw new Error('CERT_FILE / KEY_FILE 指向的文件不存在');
    }
    return {
      key: fs.readFileSync(config.keyFile, 'utf8'),
      cert: fs.readFileSync(config.certFile, 'utf8'),
      source: '外部证书(CERT_FILE/KEY_FILE)',
    };
  }

  // 2) 复用已生成的
  if (fs.existsSync(paths.certKey) && fs.existsSync(paths.certCrt)) {
    return {
      key: fs.readFileSync(paths.certKey, 'utf8'),
      cert: fs.readFileSync(paths.certCrt, 'utf8'),
      source: '复用 data/cert 下的证书',
    };
  }

  // 3) 现生成
  const source = generateSelfSigned(paths.certCrt, paths.certKey);
  return {
    key: fs.readFileSync(paths.certKey, 'utf8'),
    cert: fs.readFileSync(paths.certCrt, 'utf8'),
    source,
  };
}
