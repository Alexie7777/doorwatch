#!/usr/bin/env node
/**
 * 架构说明页自检:锚点是否悬空、标签是否配平。
 * 纯静态检查,不用开浏览器。
 *
 * 运行: node tools/check-page.mjs docs/architecture.html
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? 'docs/architecture.html';
const abs = path.resolve(file);
const html = fs.readFileSync(abs, 'utf8');

let bad = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'ERR '} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) bad++;
};

const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const missing = anchors.filter((a) => !ids.includes(a));

check('所有导航锚点都有对应章节', missing.length === 0, missing.length ? `悬空: ${missing.join(', ')}` : `共 ${anchors.length} 个锚点`);
console.log(`     章节: ${ids.join(' · ')}`);

for (const tag of ['svg', 'section', 'div', 'table', 'tr', 'td']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
  check(`${tag} 标签配平`, open === close, `${open} / ${close}`);
}

check('含 SVG 图', (html.match(/<svg[\s>]/g) ?? []).length >= 4, `${(html.match(/<svg[\s>]/g) ?? []).length} 张`);
check('无外部 JS 依赖', !/<script[^>]+src=/.test(html));
check('无 emoji 图标', !/[\u{1F300}-\u{1FAFF}]/u.test(html.replace(/⚠/g, '')));
check('移动端断点齐全', html.includes('@media (max-width: 560px)') && html.includes('@media (max-width: 900px)'));

process.exit(bad ? 1 : 0);
