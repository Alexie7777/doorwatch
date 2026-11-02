#!/usr/bin/env node
/**
 * doorwatch 链路体检 —— 一条命令回答「现在能不能看到真实门态」。
 *
 * 为什么需要它:
 *   整条链路有 5 环 ——
 *     ① HA 模板实体  ② HA 自动化  ③ MQTT  ④ doorwatch 服务端  ⑤ 手机看板
 *   断在哪一环,现象都是同一个:看板一直显示「状态未知」。
 *   靠猜很浪费时间,这个脚本把每一环都查一遍,并明确告诉你断在哪。
 *
 * 只读,不写任何东西。
 *
 * 用法:
 *   node tools/doctor.mjs --doorwatch https://it-server-bak:8443
 *   node tools/doctor.mjs --doorwatch https://it-server-bak:8443 --insecure
 *   node tools/doctor.mjs --doorwatch https://it-server-bak:8443 \
 *        --ha http://10.37.2.208:8123 --token <TOKEN>
 *
 * 环境变量也可以:DOORWATCH_URL / HA_URL / HA_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { loadTemplates } from './ha-templates.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const MARK = { ok: '✅', bad: '❌', warn: '⚠️', info: '·' };

let problems = 0;
/** 传输层降级提示(https→http、自签证书) */
let transportNote = null;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doorwatch') out.doorwatch = argv[++i];
    else if (a === '--ha') out.ha = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--insecure') out.insecure = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  out.doorwatch = (out.doorwatch || process.env.DOORWATCH_URL || 'http://127.0.0.1:8443')
    .replace(/\/+$/, '');
  out.ha = (out.ha || process.env.HA_URL || '').replace(/\/+$/, '');
  out.token = out.token || process.env.HA_TOKEN || '';
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
用法: node tools/doctor.mjs [选项]

  --doorwatch <url>   doorwatch 地址(默认 http://127.0.0.1:8443,可用 DOORWATCH_URL)
  --ha <url>          Home Assistant 地址(可选,可用 HA_URL)
  --token <tok>       HA 长期访问令牌(可选,可用 HA_TOKEN)
  --insecure          跳过 TLS 证书校验(自签证书用)
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * HTTP:用 node:http/https 而不是 fetch,是为了能单独控制 rejectUnauthorized
 * ------------------------------------------------------------------ */
function httpRequest(url, {
  method = 'GET',
  headers = {},
  body = null,
  insecure = false,
  timeout = 8000,
} = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = lib.request(
      u,
      {
        method,
        headers: payload
          ? { ...headers, 'Content-Length': payload.length }
          : headers,
        timeout,
        rejectUnauthorized: !insecure,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* 不是 JSON,留给调用方处理 */ }
          resolve({ status: res.statusCode, json, body: text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeout}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 发一个请求,两种常见情况会自动降级重试:
 *   ① 自签证书 → 关掉证书校验再试一次
 *   ② 把 http 写成 https(HA 默认是 http)→ 换回 http 再试一次
 *      典型报错:wrong version number / EPROTO / not a TLS / packet length too long
 *
 * ★ 所有对 HA / doorwatch 的请求都得走这里 ——
 *   降级逻辑分散在各调用点的时候,一定会漏掉某几个。
 *   (踩过一次:模板接口 POST 和错误日志 GET 漏了降级,直接 EPROTO。)
 */
async function requestWithFallback(url, opts = {}) {
  let res;
  try {
    res = await httpRequest(url, opts);
  } catch (err) {
    const msg = err?.message ?? '';
    // ① 先判「https 写成了 http」—— 它和 ② 的报错都带 "SSL" 字样,
    //    但特征是 TLS 握手阶段的 wrong version number / EPROTO。
    if (/wrong version number|EPROTO|not a TLS|packet length too long/i.test(msg)
        && url.startsWith('https:')) {
      const plain = url.replace(/^https:/, 'http:');
      const retry = await httpRequest(plain, opts);
      retry.downgraded = true;
      transportNote = '地址写成了 https,已自动改用 http 重试';
      res = retry;
    } else if (/certificate|self[- ]signed|unable to verify/i.test(msg) && !opts.insecure) {
      const retry = await httpRequest(url, { ...opts, insecure: true });
      retry.selfSigned = true;
      transportNote = '证书是自签的,已跳过校验(生产环境建议换成正式证书)';
      res = retry;
    } else {
      throw err;
    }
  }
  return res;
}

/**
 * 拿 JSON。返回的不是 JSON 或状态码不对 → 抛错。
 */
async function getJson(url, opts = {}) {
  const res = await requestWithFallback(url, opts);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  if (!res.json) throw new Error('返回的不是 JSON');
  return res.json;
}

/**
 * POST 一个 JSON 到 HA(模板接口、动作接口都用得上)。
 * 不走 getJson —— 模板接口出错时返回的是 HTTP 400 + 错误正文,
 * 那正是我们最想要的东西,不能被当成异常吞掉。
 */
async function postJson(url, payload, opts = {}) {
  return requestWithFallback(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(payload),
  });
}

function age(ms) {
  if (!ms) return '从未';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

function line(mark, text, extra = '') {
  console.log(`  ${mark} ${text}${extra ? `  ${extra}` : ''}`);
  if (mark === MARK.bad) problems += 1;
}

/** 降级提示只打印一次,免得同一句话在输出里刷屏 */
const shownNotes = new Set();
function reportTransportNote() {
  if (!transportNote || shownNotes.has(transportNote)) return;
  shownNotes.add(transportNote);
  line(MARK.info, transportNote);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ================================================================== *
 * ① doorwatch 服务端
 * ================================================================== */
let health = null;
let doors = [];

section('[1/5] doorwatch 服务端');
try {
  health = await getJson(`${args.doorwatch}/api/health`, { insecure: args.insecure });
  line(MARK.ok, '服务可达', args.doorwatch);
  const mqtt = health.mqtt ?? {};
  line(MARK.ok, `版本 ${health.version ?? '?'},已运行 ${Math.floor((health.uptimeSec ?? 0) / 60)} 分钟`);
  line(
    mqtt.clients > 0 ? MARK.ok : MARK.warn,
    `MQTT broker:${mqtt.embedded ? '内置' : '外部'},端口 ${mqtt.brokerPort ?? '?'}`,
    `当前 ${mqtt.clients ?? 0} 个客户端连着(含 doorwatch 自己那 1 个)`,
  );
  if (!mqtt.clients) {
    console.log('     ↳ 一个客户端都没有 —— HA 还没连上 MQTT,或者没部署 HA 那套自动化');
  }
} catch (err) {
  line(MARK.bad, '连不上 doorwatch', `${err.message}`);
  console.log('     ↳ 先把服务端拉起来:');
  console.log('       cd /srv/doorwatch && docker compose -f deploy/docker-compose.yml up -d');
  console.log('       docker compose -f deploy/docker-compose.yml logs -f doorwatch');
}

/* ================================================================== *
 * ② 看板上的门
 * ================================================================== */
section('[2/5] 看板上的门');
if (health) {
  try {
    const snap = await getJson(`${args.doorwatch}/api/doors`, { insecure: args.insecure });
    doors = snap.doors ?? [];
    line(MARK.ok, `登记了 ${doors.length} 扇门`);
    let onlineCount = 0;
    for (const d of doors) {
      const stateZh = { open: '门开着', closed: '门关着', unknown: '状态未知' }[d.state] ?? d.state;
      const ok = d.online && d.state !== 'unknown';
      if (ok) onlineCount += 1;
      line(
        ok ? MARK.ok : MARK.warn,
        `${d.name ?? d.id}`,
        `状态=${stateZh}  在线=${d.online ? '是' : '否'}  最后收到 ${age(d.lastSeenAt)}`,
      );
    }
    if (doors.length && !onlineCount) {
      console.log('     ↳ 没有一扇门是「在线且有明确开/关」—— 数据没从 HA 流过来');
    }
  } catch (err) {
    line(MARK.bad, '读 /api/doors 失败', err.message);
  }
} else {
  line(MARK.info, '跳过(服务端连不上)');
}

/* ================================================================== *
 * ③ HA 侧模板实体
 * ================================================================== */
section('[3/5] HA 侧模板实体');
if (!args.ha) {
  line(MARK.info, '跳过(没给 --ha / HA_URL)');
  console.log('     ↳ 想连 HA 一起查:加 --ha http://<HA>:8123 --token <TOKEN>');
} else {
  const haHeaders = { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' };
  try {
    transportNote = null;
    const states = await getJson(`${args.ha}/api/states`, { headers: haHeaders, timeout: 10000 });
    reportTransportNote();
    const map = new Map(states.map((s) => [s.entity_id, s]));

    const st = map.get('sensor.doorwatch_it_office_door_state');
    if (!st) {
      line(MARK.bad, 'sensor.doorwatch_it_office_door_state 不存在', 'HA 的 templates.yaml 没生效');
    } else if (st.state === 'unavailable') {
      // ⚠️ 这一支必须排在「值不对」前面 —— 否则永远走不到这里,
      //    「模板渲染抛异常了」这个最有用的提示就丢了。
      line(MARK.bad, '门状态模板 = unavailable', '模板渲染抛异常了,原因见下面的错误日志');
    } else if (!['OPEN', 'CLOSED', 'UNKNOWN'].includes(st.state)) {
      line(MARK.bad, `门状态模板的值不对: "${st.state}"`, '只能是 OPEN / CLOSED / UNKNOWN');
    } else {
      line(MARK.ok, `门状态模板 = ${st.state}`);
    }

    const rd = map.get('binary_sensor.doorwatch_it_office_door_readable');
    if (!rd) {
      line(MARK.bad, 'binary_sensor.doorwatch_it_office_door_readable 不存在',
        'templates.yaml 里可读性模板要放在 binary_sensor: 下面');
    } else if (!['on', 'off'].includes(rd.state)) {
      line(MARK.bad, `可读性模板的值不对: "${rd.state}"`, 'binary_sensor 只能是 on / off');
    } else {
      line(MARK.ok, `可读性模板 = ${rd.state}`, rd.state === 'on' ? '(传感器在正常上报)' : '(读不到传感器)');
    }

    const raw = map.get('binary_sensor.isa_dw2hl_b95b_magnet_sensor');
    if (raw) {
      line(MARK.info, `原始门磁实体 = ${raw.state}`,
        `last_reported ${age(Date.parse(raw.last_reported ?? ''))}`);
    }

    // ---- 现场渲染:把仓库里的模板直接 POST 给 HA 的 /api/template ----
    // 意义:不用「先改配置,再回头猜为什么炸」。
    // 这份模板在**这台** HA 上此刻会渲染成什么,直接问 HA 自己;
    // 渲染报错的话,HA 会把 TemplateError 原文还回来。
    const { templates, source } = loadTemplates(ROOT);
    if (!templates.length) {
      line(MARK.info, '拿不到仓库里的模板', '先跑 node tools/dump-ha-templates.mjs');
    } else {
      for (const t of templates) {
        const label = t.unique_id ?? t.name ?? '(未命名)';
        if (!t.state) {
          line(MARK.warn, `模板 ${label} 没有 state 字段`);
          continue;
        }
        let res;
        try {
          res = await postJson(`${args.ha}/api/template`, { template: t.state }, {
            headers: haHeaders,
            timeout: 15000,
          });
        } catch (err) {
          line(MARK.bad, `现场渲染 ${label} 失败`, err.message);
          continue;
        }
        if (res.status === 200 && res.json && res.json.result !== undefined) {
          const rawOut = String(res.json.result).trim();
          // binary_sensor 平台会用 result_as_boolean() 把结果转成 on/off
          const shown = t.platform === 'binary_sensor'
            ? (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(rawOut.toLowerCase()) ? 'on' : 'off')
            : rawOut;
          line(MARK.ok, `现场渲染 ${label}`, `→ ${shown}`);
        } else {
          const msg = res.json?.message ?? String(res.body ?? '').slice(0, 400) ?? `HTTP ${res.status}`;
          line(MARK.bad, `现场渲染 ${label} 失败`, String(msg).replace(/\s+/g, ' ').trim());
        }
      }
      reportTransportNote();
    }

    // ---- HA 错误日志:unavailable 的真正原因通常就写在这里 ----
    try {
      const logRes = await requestWithFallback(`${args.ha}/api/error_log`, { headers: haHeaders, timeout: 15000 });
      const hits = String(logRes.body ?? '')
        .split('\n')
        .filter((l) => /doorwatch/i.test(l) || /Error rendering template/i.test(l) || /TemplateError/i.test(l));
      const ours = hits.filter((l) => /doorwatch/i.test(l));
      if (ours.length) {
        line(MARK.bad, `HA 错误日志里有 ${ours.length} 条 doorwatch 相关的报错`, '看最后一条:');
        for (const l of ours.slice(-3)) {
          console.log(`     ↳ ${l.trim().slice(0, 300)}`);
        }
      } else if (hits.length) {
        line(MARK.info, `错误日志里有 ${hits.length} 条模板报错,但都跟 doorwatch 无关`);
      } else {
        line(MARK.ok, 'HA 错误日志里没有模板相关的报错');
      }
    } catch (err) {
      line(MARK.info, '读 HA 错误日志失败', err.message);
    }

    // 自动化加载了没、在不在跑 —— 这决定了「没消息」的两种可能:
    //   自动化没加载 → 什么都不推
    //   自动化在跑但门磁读不到 → 每分钟推 offline
    const autos = states.filter((s) => s.entity_id.startsWith('automation.'));
    const ours = autos.filter((s) =>
      /doorwatch/i.test(s.entity_id)
      || /doorwatch|门磁|体检|每分钟/i.test(s.attributes?.friendly_name ?? ''));
    if (!ours.length) {
      line(MARK.bad, 'HA 里没有 doorwatch 相关的自动化',
        'automations.yaml 没加载 —— configuration.yaml 里少了 automation: !include automations.yaml');
    } else {
      for (const a of ours) {
        const last = a.attributes?.last_triggered;
        const when = last && last !== 'unknown' ? age(Date.parse(last)) : '从未触发过';
        line(MARK.info, `${a.attributes?.friendly_name ?? a.entity_id}`,
          `state=${a.state}  上次触发 ${when}`);
      }
      const never = ours.filter((a) => !a.attributes?.last_triggered
        || a.attributes.last_triggered === 'unknown');
      if (never.length) {
        console.log('     ↳ 有自动化从来没触发过 —— 先去 HA 的「设置 → 自动化」看它是不是报错了');
      }
    }
  } catch (err) {
    line(MARK.bad, '连不上 HA', err.message);
  }
}

/* ================================================================== *
 * ④ 主题与 deviceId 对齐(读仓库里的静态配置)
 * ================================================================== */
section('[4/5] 主题与 deviceId 对齐');
try {
  const doorsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'doors.json'), 'utf8'));
  const registered = new Set((doorsJson.doors ?? []).map((d) => d.deviceId));
  const automations = fs.readFileSync(path.join(ROOT, 'ha', 'automations.yaml'), 'utf8');
  const topics = [...new Set([...automations.matchAll(/topic:\s*"doorwatch\/([^/"]+)\//g)].map((m) => m[1]))];

  line(MARK.ok, `doorwatch 登记的 deviceId: ${[...registered].join(', ')}`);
  line(MARK.ok, `自动化发布用的 deviceId: ${topics.join(', ')}`);
  const missing = topics.filter((t) => !registered.has(t));
  if (missing.length) {
    line(MARK.bad, `这些 deviceId 服务端没登记: ${missing.join(', ')}`, '消息会被直接丢弃');
  } else {
    line(MARK.ok, '两边对得上');
  }
} catch (err) {
  line(MARK.warn, '读仓库里的配置失败', err.message);
}

/* ================================================================== *
 * ⑤ 结论
 * ================================================================== */
section('[5/5] 结论');
const anyLive = doors.some((d) => d.online && d.state !== 'unknown');
if (!health) {
  problems += 1;
  console.log('  ❌ 服务端没起来 —— 看板当然什么都看不到。');
} else if (!anyLive) {
  problems += 1;
  console.log('  ❌ 服务端活着,但没有一扇门拿到有效状态。顺着这条查:');
  console.log('     1. HA 里:设置 → 工具 → 配置(YAML)→ 检查配置,确认 templates.yaml 无红叉');
  console.log('     2. HA 里:设置 → 工具 → 动作,调一次 homeassistant.update_entity');
  console.log('     3. HA 里:设置 → 自动化,看「每分钟体检」那条在不在、有没有报错');
  console.log('     4. HA 的 MQTT 集成要指向 doorwatch 的 1883 端口(不是 8123)');
} else {
  console.log('  ✅ 链路已通 —— 门开着的话,看板会显示「门开着」。');
  console.log('     手机上打开看板地址,加到主屏幕就能像 App 一样用。');
}

if (problems) console.log(`\n  (${problems} 项检查未通过)`);
console.log('');
process.exit(problems ? 1 : 0);
