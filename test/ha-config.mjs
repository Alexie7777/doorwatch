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

console.log('\n[test] deviceId 三处对齐');
const doorIds = new Set((doorsDoc?.doors ?? []).map((d) => d.deviceId));
check('config/doors.json 里登记了 deviceId', doorIds.size > 0, [...doorIds].join(', '));

const topics = [...automationsText.matchAll(/topic:\s*"doorwatch\/([^/"]+)\//g)].map((m) => m[1]);
check('automations.yaml 里读到了 MQTT 主题', topics.length > 0, `${topics.length} 个`);
const unknownTopics = [...new Set(topics)].filter((t) => !doorIds.has(t));
check('所有主题的 deviceId 都在 doors.json 里登记过', unknownTopics.length === 0,
  unknownTopics.length ? `未登记: ${unknownTopics.join(', ')}` : '');

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

const templateSensors = (templatesDoc?.[0]?.sensor ?? []).map((s) => s.unique_id);
check('templates.yaml 定义了门状态模板', templateSensors.includes('doorwatch_it_office_door_state'));
check('templates.yaml 定义了可读性模板', templateSensors.includes('doorwatch_it_office_door_readable'));

const referenced = new Set(
  [...automationsText.matchAll(/sensor\.(doorwatch_[a-z0-9_]+)/g)].map((m) => m[1]),
);
check('automations.yaml 引用了模板实体', referenced.size > 0, [...referenced].join(', '));
const missing = [...referenced].filter((id) => !templateSensors.includes(id));
check('automation 引用的模板实体都在 templates.yaml 里定义过', missing.length === 0,
  missing.length ? `缺: ${missing.join(', ')}` : '');

console.log('\n[test] 方向开关与三态');
check('templates.yaml 有 DOOR_ON_MEANS_OPEN 开关', templatesText.includes('DOOR_ON_MEANS_OPEN'));
check('templates.yaml 会输出 UNKNOWN', templatesText.includes('UNKNOWN'));
check('templates.yaml 有 STALE_SECONDS 阈值', templatesText.includes('STALE_SECONDS'));
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
