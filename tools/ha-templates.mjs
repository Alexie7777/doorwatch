/**
 * 读 ha/templates.yaml,吐出「HA 实际会看到的」模板列表。
 *
 * 为什么单独抽一个模块:
 *   · tools/dump-ha-templates.mjs 要把它导出成 JSON,交给 Python 仿真器
 *   · tools/doctor.mjs 要把同一份模板 POST 给 HA 的 /api/template 现场渲染
 *   两边必须看到**完全一样**的模板文本,否则仿真结论对不上现场。
 *
 * 依赖降级:
 *   yaml 是 devDependency。生产镜像里可能没装 devDeps,
 *   这时退回到 tools/.ha-templates.json(由 dump 工具生成)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * @param {string} root 仓库根目录
 * @returns {{templates: Array<{platform: string, unique_id: string|null, name: string|null, state: string|null}>, source: string|null}}
 */
export function loadTemplates(root) {
  const yamlPath = path.join(root, 'ha', 'templates.yaml');

  // ① 首选:直接用 yaml 库解析(最准,不会和文件不同步)
  try {
    const YAML = require('yaml');
    const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
    if (Array.isArray(doc)) {
      const out = [];
      for (const section of doc) {
        for (const [platform, list] of Object.entries(section ?? {})) {
          for (const entity of list ?? []) {
            out.push({
              platform,
              unique_id: entity.unique_id ?? null,
              name: entity.name ?? null,
              state: entity.state ?? null,
            });
          }
        }
      }
      if (out.length) return { templates: out, source: 'ha/templates.yaml' };
    }
  } catch {
    // yaml 没装或文件有问题 → 走下面的 JSON 兜底
  }

  // ② 兜底:用 dump 工具导出的 JSON
  const jsonPath = path.join(root, 'tools', '.ha-templates.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length) {
        return { templates: parsed, source: 'tools/.ha-templates.json' };
      }
    } catch {
      // 落到下面
    }
  }

  return { templates: [], source: null };
}

/**
 * 读 ha/automations.yaml,抽出每条自动化里的「模板条件」(保险丝)。
 *
 * 为什么需要它:
 *   保险丝是判定「传感器还活着吗」的那段 Jinja。
 *   它写对了没、在这台 HA 上算出来是 True 还是 False,
 *   只有让 HA 自己算一遍才知道 —— 这就是 doctor 的「保险丝现场求值」。
 *
 * @returns {Array<{id: string, alias: string|null, fuse: string}>}
 */
export function loadAutomationTemplates(root) {
  const yamlPath = path.join(root, 'ha', 'automations.yaml');
  let YAML;
  try {
    YAML = require('yaml');
  } catch {
    return [];
  }
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];

  const out = [];
  for (const auto of doc) {
    // ★ 只认「会推门状态」的自动化 —— 它的模板条件才是保险丝。
    //   电量上报那条自动化也有一个模板条件,但它推的是 /battery,
    //   跟"传感器还活着吗"没关系,混进来会让体检误报「保险丝不通过」。
    const actionsText = JSON.stringify(auto?.actions ?? []);
    if (!/\/state"/.test(actionsText)) continue;

    for (const action of auto?.actions ?? []) {
      const branches = [action?.if].flat().filter(Boolean);
      for (const cond of branches) {
        if (cond?.condition === 'template' && typeof cond.value_template === 'string') {
          out.push({
            id: auto.id ?? null,
            alias: auto.alias ?? null,
            fuse: cond.value_template,
          });
        }
      }
    }
  }
  return out;
}
