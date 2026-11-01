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

process.exit(bad ? 1 : 0);
