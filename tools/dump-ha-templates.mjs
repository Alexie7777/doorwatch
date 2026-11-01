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
 * 用法: node tools/dump-ha-templates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'ha', 'templates.yaml');
const OUT = path.join(ROOT, 'tools', '.ha-templates.json');

const doc = YAML.parse(fs.readFileSync(SRC, 'utf8'));
if (!Array.isArray(doc)) {
  console.error('❌ ha/templates.yaml 顶层不是数组(必须是裸列表)');
  process.exit(1);
}

const templates = [];
for (const section of doc) {
  for (const [platform, list] of Object.entries(section ?? {})) {
    for (const entity of list ?? []) {
      templates.push({
        platform,
        unique_id: entity.unique_id ?? null,
        name: entity.name ?? null,
        state: entity.state ?? null,
      });
    }
  }
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
