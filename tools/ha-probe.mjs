#!/usr/bin/env node
/**
 * HA 探针 —— 门磁接进 Home Assistant 之后,用它一次性回答三个问题:
 *
 *   1. 门磁到底是哪个实体(entity_id)?
 *      磁力门吸会同时冒出门磁、运动、人体、照度一堆实体,名字还带厂商前缀,
 *      靠猜基本猜不对。
 *   2. on / off 的方向对不对?
 *      开门时看板该显示"开着"还是"关着"。
 *   3. last_updated 和 last_reported 哪个在推进?
 *      这是门磁掉线检测的命门:HA 里这两个时间戳语义完全不同,
 *      用错了会出现"传感器好好的,看板一直显示状态未知"。
 *      (原理见 ha/templates.yaml 顶部注释)
 *
 * 用法:
 *   node tools/ha-probe.mjs --host http://homeassistant.local:8123 --token <TOKEN>
 *   node tools/ha-probe.mjs --host ... --token ... --watch 120
 *   node tools/ha-probe.mjs --host ... --token ... --entity binary_sensor.aqara_it_office
 *
 * TOKEN 怎么拿:
 *   HA 左下角头像 → 安全 → 长期访问令牌 → 创建令牌 → 复制那串字符。
 *   也可以用环境变量 HA_TOKEN / HA_URL 代替命令行参数。
 *
 * 这个脚本只读不写,不会碰你的门磁状态。
 */
import process from 'node:process';

function parseArgs(argv) {
  const out = { watch: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--entity') out.entity = argv[++i];
    else if (a === '--watch') out.watch = Number(argv[++i]) || 0;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.host ??= a;
  }
  out.host = (out.host || process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '');
  out.token = out.token || process.env.HA_TOKEN || '';
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
用法: node tools/ha-probe.mjs [选项]

  --host <url>     HA 地址(默认 http://homeassistant.local:8123,也可用环境变量 HA_URL)
  --token <tok>    长期访问令牌(也可用环境变量 HA_TOKEN)
  --entity <id>    只看这一个实体
  --watch <秒>     观察 N 秒,看时间戳有没有在推进
`);
  process.exit(0);
}

if (!args.token) {
  console.error('缺少 token。HA 里:头像 → 安全 → 长期访问令牌 → 创建。');
  console.error('也可以直接设环境变量 HA_TOKEN。');
  process.exit(2);
}

async function api(pathname) {
  const res = await fetch(`${args.host}${pathname}`, {
    headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${pathname} → HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function age(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 门磁候选:设备类型是门/窗,或者名字里带门磁关键词 */
const DOOR_CLASSES = new Set(['door', 'window', 'garage_door', 'opening', 'lock']);
const KEYWORDS = /door|magnet|contact|window|gate|shutter|门|磁/i;

function isCandidate(s) {
  if (!s.entity_id.startsWith('binary_sensor.')) return false;
  const dc = s.attributes?.device_class;
  if (dc && DOOR_CLASSES.has(dc)) return true;
  return KEYWORDS.test(s.entity_id) || KEYWORDS.test(s.attributes?.friendly_name || '');
}

function describe(s) {
  const a = s.attributes || {};
  const bits = [`state=${s.state}`];
  if (a.device_class) bits.push(`device_class=${a.device_class}`);
  if (a.friendly_name) bits.push(`「${a.friendly_name}」`);
  if (a.battery_level !== undefined) bits.push(`电量=${a.battery_level}%`);
  return bits.join('  ');
}

function stampLines(s) {
  return [
    `      last_changed  ${age(s.last_changed)}`,
    `      last_updated  ${age(s.last_updated)}   ← 状态/属性变化才动`,
    `      last_reported ${age(s.last_reported)}   ← 集成每轮写一次就动`,
  ];
}

async function snapshot() {
  const states = await api('/api/states');
  const map = new Map(states.map((s) => [s.entity_id, s]));
  return map;
}

async function main() {
  console.log(`HA: ${args.host}`);
  let version = '未知';
  try {
    const cfg = await api('/api/config');
    version = cfg.version || '未知';
  } catch {
    /* 拿不到就跳过 */
  }
  console.log(`版本: ${version}`);

  if (!/^20\d\d\.\d/.test(version)) {
    console.log('提示:拿不到版本号,下面的时间戳结论仍然可用。');
  }

  let map = await snapshot();

  const doorwatchSensors = [
    'sensor.doorwatch_it_office_door_state',
    'sensor.doorwatch_it_office_door_readable',
  ];

  console.log('\n=== doorwatch 自己的模板实体 ===');
  let anyTemplate = false;
  for (const id of doorwatchSensors) {
    const s = map.get(id);
    if (!s) {
      console.log(`  ${id}  —— 不存在(还没装 templates.yaml?或者实体名对不上)`);
      continue;
    }
    anyTemplate = true;
    console.log(`  ${id} = ${s.state}`);
  }
  if (!anyTemplate) {
    console.log('  (都不存在 —— 说明 ha/templates.yaml 还没装进 HA,或者 YAML 里有语法错误)');
  }

  let candidates = [...map.values()].filter(isCandidate);
  if (args.entity) {
    candidates = candidates.filter((s) => s.entity_id === args.entity);
    if (!candidates.length && map.has(args.entity)) candidates = [map.get(args.entity)];
  }

  console.log(`\n=== 门磁候选实体(${candidates.length} 个)===\n`);
  if (!candidates.length) {
    console.log('没找到。可能是关键词没覆盖到,去掉筛选看看全部:');
    console.log('  curl -s -H "Authorization: Bearer <TOKEN>" http://<HA>/api/states | jq -r ".[]|select(.entity_id|startswith(\\"binary_sensor\\"))|.entity_id"');
  }

  for (const s of candidates) {
    console.log(`  ${s.entity_id}`);
    console.log(`      ${describe(s)}`);
    console.log(...stampLines(s));
    console.log('');
  }

  if (args.watch > 0) {
    console.log(`--- 观察 ${args.watch} 秒,看哪些时间戳在推进 ---\n`);
    const before = new Map(candidates.map((s) => [s.entity_id, s]));
    await new Promise((r) => setTimeout(r, args.watch * 1000));
    const after = await snapshot();

    for (const id of before.keys()) {
      const b = before.get(id);
      const a = after.get(id);
      if (!a) {
        console.log(`${id}: 实体消失了`);
        continue;
      }
      const d = (k) => Date.parse(a[k]) - Date.parse(b[k]);
      const du = d('last_updated');
      const dr = d('last_reported');
      const fmt = (v) => (v > 0 ? `+${Math.round(v / 1000)} 秒` : '没动');
      console.log(`${id}`);
      console.log(`   状态        ${b.state} → ${a.state}`);
      console.log(`   last_updated  ${fmt(du)}   ${du > 0 ? '在动' : '冻住了(门没动时正常)'}`);
      console.log(`   last_reported ${fmt(dr)}   ${dr > 0 ? '在动 ✅ 新鲜度判据用这个' : '没动 ❌ 传感器可能真的失联了'}`);
      console.log('');
    }
  }

  console.log('下一步:把确认下来的 entity_id 填进 ha/templates.yaml 的 binary_sensor.aqara_it_office。');
}

main().catch((err) => {
  console.error(`探针失败: ${err.message}`);
  console.error('排查:① HA 地址对不对 ② token 是不是过期了 ③ HA 和这台机器通不通');
  process.exit(1);
});
