#!/usr/bin/env node
/**
 * HA 接入套件的静态体检。
 *
 * 这里钉住的是"配置文件层面"的坑 —— 它们不会在服务端测试里暴露,
 * 但每一个都足以让整条链路哑火:
 *
 *   1. states('x') 只返回状态文本,拿时间戳必须写 states.x.last_reported
 *      → 写错的话自动化每分钟抛模板错误,「每分钟体检」直接哑火,
 *        看板永远收不到状态,也收不到心跳
 *   2. 新鲜度判据必须用 last_reported 而不是 last_updated
 *      → last_updated 在"状态和属性都没变"时不会推进,门关着不动就一直冻住,
 *        用它当判据会出现"传感器好好的,看板一直显示状态未知"
 *   3. 自动化里的 deviceId 必须和 config/doors.json 对得上
 *      → 对不上服务端会直接丢弃消息,看板永远不动
 *   4. 自动化引用的模板实体必须在 templates.yaml 里真的存在
 *      → 不存在的话 update_entity 打空气,保险丝失效
 *
 * 运行: node test/ha-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = path.resolve(import.meta.dirname, '..');
const TEMPLATES = path.join(ROOT, 'ha', 'templates.yaml');
const AUTOMATIONS = path.join(ROOT, 'ha', 'automations.yaml');
const DOORS = path.join(ROOT, 'config', 'doors.json');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
}

const templatesText = fs.readFileSync(TEMPLATES, 'utf8');
const automationsText = fs.readFileSync(AUTOMATIONS, 'utf8');
const doorsText = fs.readFileSync(DOORS, 'utf8');

console.log('\n[test] YAML 语法');
let templatesDoc = null;
let automationsDoc = null;
let doorsDoc = null;
try {
  templatesDoc = YAML.parse(templatesText);
  check('ha/templates.yaml 能解析', Boolean(templatesDoc));
} catch (e) {
  check('ha/templates.yaml 能解析', false, e.message);
}
try {
  automationsDoc = YAML.parse(automationsText);
  check('ha/automations.yaml 能解析', Array.isArray(automationsDoc));
} catch (e) {
  check('ha/automations.yaml 能解析', false, e.message);
}
try {
  doorsDoc = JSON.parse(doorsText);
  check('config/doors.json 能解析', Array.isArray(doorsDoc.doors));
} catch (e) {
  check('config/doors.json 能解析', false, e.message);
}

console.log('\n[test] HA 模板语法坑:states(\'x\') 只返回文本');
/**
 * 只看真正的代码行 —— 注释里故意写了反例做说明,不能算命中。
 * (整行注释 + 行尾注释都剔掉)
 */
function codeLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, ''))
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}
const templatesCode = codeLines(templatesText);
const automationsCode = codeLines(automationsText);

// states('entity.id').last_updated  → 文本没有这个属性 → 模板直接报错
const badCallForm = [...templatesCode.matchAll(/states\('[^']+'\)\s*\.\s*last_/g)];
check('templates.yaml 里没有 states(\'x\').last_* 的写法', badCallForm.length === 0,
  badCallForm.length ? `发现 ${badCallForm.length} 处` : '');

const badCallFormAuto = [...automationsCode.matchAll(/states\('[^']+'\)\s*\.\s*last_/g)];
check('automations.yaml 里没有 states(\'x\').last_* 的写法', badCallFormAuto.length === 0,
  badCallFormAuto.length ? `发现 ${badCallFormAuto.length} 处` : '');

check('两个文件里没有 states(\'x\').attributes 之类的属性误用',
  !/states\('[^']+'\)\s*\.\s*attributes/.test(automationsCode + templatesCode));

console.log('\n[test] 新鲜度判据用 last_reported');
check('templates.yaml 用了 last_reported', templatesText.includes('last_reported'));
check('templates.yaml 用 last_reported 优先、last_updated 兜底',
  /last_reported\s*\|\s*default\(\s*src\.last_updated/.test(templatesText));
check('automations.yaml 的保险丝用 last_reported', automationsText.includes('last_reported'));
check('templates.yaml 没有把 last_updated 当唯一判据',
  !/as_timestamp\(src\.last_updated\)/.test(templatesText));

console.log('\n[test] 保险丝的存活判据(模板实体的时间戳是冻结的)');
/**
 * ★ 这组断言挡的是 2026-11 那次线上事故。
 *
 *   保险丝(自动化里「传感器还活着吗」那段 Jinja)曾经拿
 *   **模板实体**的 last_reported 判死活。
 *   而 HA 只在渲染结果**变化**时才把状态写回 state machine:
 *       helpers/event.py → TrackTemplateResultInfo._render_template_if_ready
 *           if result == last_result and template in self._last_result:
 *               return True       # ← 结果没变,连 update 都不产生
 *   结果没变 → 不写状态 → **last_reported 永远不动**。
 *
 *   于是保险丝两分钟后必然判「过期」→ 每分钟推 offline
 *   → 看板永远显示「状态未知」,而门磁明明好好的。
 *
 *   原始门磁就不一样:xiaomi_miot 每轮轮询都写一次状态,
 *   值没变时 HA 走 async_set_internal 的「提前返回」分支,只更新 last_reported
 *   —— 它的 last_reported 是真在推进的,那才是可信的存活信号。
 */
const fuseTemplates = [];
for (const auto of automationsDoc ?? []) {
  // ★ 只认「会推门状态」的自动化 —— 它的模板条件才是保险丝。
  //   电量上报那条也有一个模板条件,但它推的是 /battery,
  //   跟"传感器还活着吗"没关系,混进来会让这些断言误判。
  if (!/\/state"/.test(JSON.stringify(auto?.actions ?? []))) continue;
  for (const action of auto?.actions ?? []) {
    for (const cond of [action?.if].flat().filter(Boolean)) {
      if (cond?.condition === 'template') fuseTemplates.push(cond.value_template ?? '');
    }
  }
}
check('能抠出自动化里的保险丝条件', fuseTemplates.length > 0, `${fuseTemplates.length} 条`);
for (const fuse of fuseTemplates) {
  check('★ 保险丝不拿模板实体的 last_reported 判死活',
    !/r\.last_reported/.test(fuse),
    '模板实体的 last_reported 不推进,用它会让保险丝永远不通过');
  check('★ 保险丝用原始门磁的 last_reported 判死活',
    /raw\.last_reported/.test(fuse));
  check('★ 保险丝看的是可读性模板的**状态**(on/off),不是它的时间戳',
    /r\.state\s*==\s*'on'/.test(fuse));
  check('★ 保险丝要求状态模板给出明确答案(OPEN/CLOSED)',
    /actual in \['OPEN', 'CLOSED'\]/.test(fuse));
  check('★ 保险丝的算式在 {% if %} 的 body 里(不会被短路跳过)',
    /{% if [\s\S]*as_timestamp/.test(fuse) && /%}\s*{% set fresh/.test(fuse));
}

console.log('\n[test] deviceId 三处对齐');
const doorIds = new Set((doorsDoc?.doors ?? []).map((d) => d.deviceId));
check('config/doors.json 里登记了 deviceId', doorIds.size > 0, [...doorIds].join(', '));

const topics = [...automationsText.matchAll(/topic:\s*"doorwatch\/([^/"]+)\//g)].map((m) => m[1]);
check('automations.yaml 里读到了 MQTT 主题', topics.length > 0, `${topics.length} 个`);
const unknownTopics = [...new Set(topics)].filter((t) => !doorIds.has(t));
check('所有主题的 deviceId 都在 doors.json 里登记过', unknownTopics.length === 0,
  unknownTopics.length ? `未登记: ${unknownTopics.join(', ')}` : '');

console.log('\n[test] 电量上报(蓝牙方案的"传感器快没电了"唯一预警)');
const batteryTopics = [...automationsText.matchAll(/topic:\s*"doorwatch\/([^/"]+)\/battery"/g)]
  .map((m) => m[1]);
check('automations.yaml 里有电量上报这条', batteryTopics.length > 0, batteryTopics.join(', '));
check('电量 topic 的 deviceId 也登记过',
  batteryTopics.length > 0 && batteryTopics.every((t) => doorIds.has(t)));
check('电量取的是 battery_level 属性', /battery_level/.test(automationsText));
check('发之前先确认属性真的是数字(不会发出 "None")',
  /b is not none and b is number/.test(automationsText));
check('电量走的是独立 topic,没有混进状态 topic',
  !/topic:\s*"doorwatch\/[^"]+\/state"[^}]*battery_level/.test(automationsText));

console.log('\n[test] 模板实体对得上');
/**
 * ★ 两个 YAML 都必须是「裸列表」——
 *   configuration.yaml 里写的是
 *       template: !include templates.yaml
 *       automation: !include automations.yaml
 *   !include 把文件内容直接塞到 `template:` / `automation:` 这个键的位置上。
 *   所以文件里如果还有一层 `template:`,HA 会报:
 *     Invalid config for 'template' at templates.yaml, line N:
 *     'template' is an invalid option for 'template', check: template
 *   这是真实踩过的坑,必须挡住。
 */
check('templates.yaml 是裸列表(没有多包一层 template:)',
  Array.isArray(templatesDoc), `顶层类型: ${Array.isArray(templatesDoc) ? '数组' : typeof templatesDoc}`);
check('automations.yaml 是裸列表', Array.isArray(automationsDoc));
check('templates.yaml 里没有残留的 template: 包装',
  !templatesDoc?.template, templatesDoc?.template ? '文件里还有 template: 键' : '');

/**
 * ★ 照抄 HA 源码 homeassistant/components/template/config.py 的
 *   CONFIG_SECTION_SCHEMA —— `template:` 这个键的值是一个「配置段」列表,
 *   每个配置段只允许下面这些键。'template' 不在里面,
 *   所以文件里再套一层就会报:
 *     'template' is an invalid option for 'template'
 */
const HA_SECTION_KEYS = new Set([
  'actions', 'conditions', 'triggers', 'trigger_variables', 'unique_id', 'variables',
  'alarm_control_panel', 'binary_sensor', 'button', 'climate', 'cover', 'device_tracker',
  'event', 'fan', 'image', 'light', 'lock', 'media_player', 'number', 'select',
  'sensor', 'switch', 'update', 'vacuum', 'water_heater', 'weather',
]);
const badSectionKeys = [];
for (const [i, section] of (Array.isArray(templatesDoc) ? templatesDoc : []).entries()) {
  for (const k of Object.keys(section ?? {})) {
    if (!HA_SECTION_KEYS.has(k)) badSectionKeys.push(`第 ${i + 1} 段 → ${k}`);
  }
}
check('templates.yaml 每个配置段的键都在 HA 官方允许的范围内', badSectionKeys.length === 0,
  badSectionKeys.length ? `非法键: ${badSectionKeys.join(', ')}` : '');

console.log('\n[test] 源实体');
/** 所有配置段里的模板实体(可能是 sensor,也可能是 binary_sensor) */
const allEntities = [];
for (const section of (Array.isArray(templatesDoc) ? templatesDoc : [])) {
  for (const [platform, list] of Object.entries(section ?? {})) {
    for (const entity of list ?? []) allEntities.push({ platform, ...entity });
  }
}
const byUniqueId = new Map(allEntities.map((e) => [e.unique_id, e]));

const srcEntities = new Set();
for (const e of allEntities) {
  const m = /states\.([a-z_]+\.[a-z0-9_]+)/.exec(String(e.state ?? ''));
  if (m) srcEntities.add(m[1]);
}
check('templates.yaml 读到的是门磁实体', srcEntities.size > 0, [...srcEntities].join(', '));
check('两个模板读的是同一个源实体(否则保险丝失效)', srcEntities.size === 1,
  srcEntities.size > 1 ? `读了 ${srcEntities.size} 个不同的实体` : '');
check('源实体已填成实际设备(不再是 aqara_it_office 占位符)',
  [...srcEntities].every((e) => e === 'binary_sensor.isa_dw2hl_b95b_magnet_sensor'),
  [...srcEntities].join(', '));
check('源实体不是 MIoT 原始属性 contact_state(极性相反)',
  ![...srcEntities].some((e) => e.endsWith('_contact_state')));

const templateSensors = allEntities.map((e) => e.unique_id);
check('templates.yaml 定义了门状态模板', templateSensors.includes('doorwatch_it_office_door_state'));
check('templates.yaml 定义了可读性模板', templateSensors.includes('doorwatch_it_office_door_readable'));

/**
 * ★★ 可读性模板必须是 binary_sensor,不是 sensor。
 *   sensor 平台会把 {{ true }} / {{ false }} 渲染成字符串 "True"/"False",
 *   而 automations.yaml 的保险丝判的是 r.state == 'on' —— 永远不成立,
 *   结果是每分钟都推 offline,看板永远显示"状态未知"。
 *   (HA 源码: components/template/binary_sensor.py 用 result_as_boolean 转 on/off)
 */
check('可读性模板在 binary_sensor 平台下(状态才是 on/off)',
  byUniqueId.get('doorwatch_it_office_door_readable')?.platform === 'binary_sensor',
  `实际平台: ${byUniqueId.get('doorwatch_it_office_door_readable')?.platform ?? '无'}`);
check('门状态模板在 sensor 平台下(状态是 OPEN/CLOSED/UNKNOWN)',
  byUniqueId.get('doorwatch_it_office_door_state')?.platform === 'sensor',
  `实际平台: ${byUniqueId.get('doorwatch_it_office_door_state')?.platform ?? '无'}`);

const referenced = new Set(
  [...automationsText.matchAll(/(?:binary_)?sensor\.(doorwatch_[a-z0-9_]+)/g)].map((m) => m[1]),
);
check('automations.yaml 引用了模板实体', referenced.size > 0, [...referenced].join(', '));
const missing = [...referenced].filter((id) => !templateSensors.includes(id));
check('automation 引用的模板实体都在 templates.yaml 里定义过', missing.length === 0,
  missing.length ? `缺: ${missing.join(', ')}` : '');

/**
 * ★ 保险丝必须引用 binary_sensor 平台的那个可读性实体。
 *   写成 sensor.doorwatch_it_office_door_readable 的话,
 *   states.sensor... 的 state 是 "True"/"False" 字符串,
 *   r.state == 'on' 永远不成立 → 每分钟都推 offline → 看板永远"状态未知"。
 */
check('自动化按 binary_sensor 引用可读性实体',
  /binary_sensor\.doorwatch_it_office_door_readable/.test(automationsCode),
  '保险丝必须读 binary_sensor,状态才是 on/off');
check('自动化没有按 sensor 引用可读性实体',
  !/(?<!binary_)sensor\.doorwatch_it_office_door_readable/.test(automationsCode),
  'sensor 平台的布尔是 "True"/"False",判 == "on" 永远不成立');

console.log('\n[test] 方向开关与三态');
check('templates.yaml 有 DOOR_ON_MEANS_OPEN 开关', templatesText.includes('DOOR_ON_MEANS_OPEN'));
check('templates.yaml 会输出 UNKNOWN', templatesText.includes('UNKNOWN'));
check('templates.yaml 有 STALE_SECONDS 阈值', templatesText.includes('STALE_SECONDS'));
check('templates.yaml 只输出 OPEN/CLOSED/UNKNOWN 三种状态',
  /'OPEN'/.test(templatesText) && /'CLOSED'/.test(templatesText)
  && !/state:.*'[A-Z]{4,}'/.test(templatesCode));
check('automation 有"每分钟体检"这条', automationsText.includes('homeassistant.update_entity'));
check('automation 失联时会推 status=offline', automationsText.includes('payload: "offline"'));
check('automation 会发心跳', automationsText.includes('/heartbeat'));

console.log('\n[test] Jinja 分隔符配平');
/** 只数代码里的,注释里的示例不算 */
function jinjaBalance(text) {
  const code = codeLines(text);
  const open = (code.match(/\{%/g) || []).length;
  const close = (code.match(/%\}/g) || []).length;
  const vOpen = (code.match(/\{\{/g) || []).length;
  const vClose = (code.match(/\}\}/g) || []).length;
  return { open, close, vOpen, vClose };
}
for (const [label, text] of [['templates.yaml', templatesText], ['automations.yaml', automationsText]]) {
  const b = jinjaBalance(text);
  check(`${label} 的 {% %} 配平`, b.open === b.close, `${b.open} / ${b.close}`);
  check(`${label} 的 {{ }} 配平`, b.vOpen === b.vClose, `${b.vOpen} / ${b.vClose}`);
}

console.log(`\n${failures === 0 ? '✅ HA 接入套件配置体检全部通过' : `❌ ${failures} 项未通过`}\n`);
process.exit(failures ? 1 : 0);
