#!/usr/bin/env node
/**
 * 配置语法体检:把 YAML / JSON 全部解析一遍。
 * ESPHome 编译前就能发现 YAML 写错,总比烧录时才发现省事。
 *
 * 运行: node tools/check-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

let YAML;
try {
  YAML = require('yaml');
} catch {
  console.log('跳过:没装 yaml 解析器(npm i -D yaml)');
  process.exit(0);
}

const targets = [
  ['esphome/it-office-door.yaml', 'yaml'],
  ['esphome/it-office-door-optocoupler.yaml', 'yaml'],
  ['esphome/it-office-door-battery.yaml', 'yaml'],
  ['esphome/secrets.example.yaml', 'yaml'],
  ['deploy/docker-compose.yml', 'yaml'],
  ['ha/templates.yaml', 'yaml'],
  ['ha/automations.yaml', 'yaml'],
  ['config/doors.json', 'json'],
];

let bad = 0;
for (const [rel, kind] of targets) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${rel}  (文件不存在)`);
    continue;
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (kind === 'json') {
      JSON.parse(text);
      console.log(`OK    ${rel}  (JSON)`);
    } else {
      const doc = YAML.parseDocument(text);
      if (doc.errors.length) {
        console.log(`ERR   ${rel}`);
        for (const e of doc.errors) console.log(`        ${e.message}`);
        bad++;
      } else {
        const keys = Object.keys(doc.toJS() ?? {});
        console.log(`OK    ${rel}  (顶层键: ${keys.join(', ')})`);
      }
    }
  } catch (err) {
    console.log(`ERR   ${rel}  -> ${err.message}`);
    bad++;
  }
}

// ---------------------------------------------------------------------
//  README 锚点自检
//
//  README 里的目录和正文互链,最容易出的错是「加了一节但目录没更新」
// 或者「锚点拼错」—— GitHub 上表现为点一下跳到页面顶部,没有任何提示。
//
//  slug 算法按 GitHub 的真实规则来:
//    小写 → 去掉标点(保留字母/数字/中日韩文字/连字符/下划线)→ 空格换成连字符
//  重复的标题会追加 -1 / -2 后缀。
// ---------------------------------------------------------------------
function githubSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\-_ ]/gu, '')
    .replace(/ /g, '-');
}

const readmePath = path.join(ROOT, 'README.md');
if (fs.existsSync(readmePath)) {
  const md = fs.readFileSync(readmePath, 'utf8');
  const seen = new Map();
  const slugs = new Set();
  for (const m of md.matchAll(/^#{2,4}\s+(.+)$/gm)) {
    let s = githubSlug(m[1].replace(/[`*]/g, ''));
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    if (n > 0) s = `${s}-${n}`;
    slugs.add(s);
  }
  const links = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  const dangling = [...new Set(links.filter((a) => !slugs.has(a)))];
  if (dangling.length) {
    console.log('ERR   README.md  锚点悬空');
    for (const a of dangling) console.log(`        #${a}`);
    bad++;
  } else {
    console.log(`OK    README.md  (${slugs.size} 个标题 / ${links.length} 个内部链接,无悬空)`);
  }
}

process.exit(bad ? 1 : 0);