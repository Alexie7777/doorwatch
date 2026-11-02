#!/usr/bin/env node
/**
 * 把 ha/templates.yaml 里每个模板的 state 字符串(HA 看到的原样)导出成 JSON,
 * 交给 tools/ha-template-sim.py 离线复刻 HA 的模板语义。
 *
 * 为什么需要这一步:ha/templates.yaml 里写的是 YAML 折叠标量(`>-`),
 * HA 读到的 Jinja 源码和文件里肉眼看到的并不一样 —— 折叠、空格、换行
 * 全被 YAML 改过一遍。而 HA 模板里出的每一个空格,都可能变成
 * " UNKNOWN " 这种带空格的状态值,或者让 Jinja 直接抛异常。
 *
 * 解析逻辑和 tools/doctor.mjs 共用 tools/ha-templates.mjs,
 * 保证「仿真看到的」和「现场渲染用的」是同一份文本。
 *
 * 用法: node tools/dump-ha-templates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTemplates, loadAutomationTemplates } from './ha-templates.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tools', '.ha-templates.json');
const OUT_AUTO = path.join(ROOT, 'tools', '.ha-automations.json');

const { templates, source } = loadTemplates(ROOT);

if (!templates.length) {
  console.error('❌ 没解析出任何模板(ha/templates.yaml 顶层必须是裸列表)');
  console.error('   解析自:', source ?? '(没找到可用的来源)');
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(templates, null, 2), 'utf8');

for (const t of templates) {
  console.log(`── ${t.unique_id ?? t.name}  [${t.platform}]`);
  console.log(`   HA 实际读到的模板(${t.state?.length ?? 0} 字符):`);
  console.log(
    (t.state ?? '')
      .split('\n')
      .map((l, i) => `     ${i + 1}| ${l}`)
      .join('\n'),
  );
  console.log('');
}
console.log(`已写入 ${OUT}`);

// 自动化里的「模板条件」(保险丝)也导出 —— 它们同样是 HA 会执行到的 Jinja
const fuses = loadAutomationTemplates(ROOT);
fs.writeFileSync(OUT_AUTO, JSON.stringify(fuses, null, 2), 'utf8');
console.log('');
console.log(`── 自动化里的模板条件(保险丝)${fuses.length} 条`);
for (const f of fuses) {
  console.log(`   ${f.alias ?? f.id}`);
  console.log(`   HA 实际读到的条件(${f.fuse.length} 字符):`);
  console.log(
    f.fuse
      .split('\n')
      .map((l, i) => `     ${i + 1}| ${l}`)
      .join('\n'),
  );
  console.log('');
}
console.log(`已写入 ${OUT_AUTO}`);
