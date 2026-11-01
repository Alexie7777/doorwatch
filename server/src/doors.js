import fs from 'node:fs';
import { config } from './config.js';

/**
 * 门禁登记表。
 *
 * 这里只放"静态档案"(门叫什么、在哪、传感器是哪台),
 * 运行时状态(开/关/在线)一律存在 SQLite 里,两者分开。
 *
 * 配置来源优先级:DOORS_JSON 环境变量 > DOORS_FILE 文件。
 */

const DEFAULT_DOORS = [
  {
    id: 'it-office',
    name: 'IT 办公室',
    location: '',
    deviceId: 'it-office-door',
    openHint: 'IT 有人在,直接过来就行',
    closedHint: '门已关,IT 暂时不在,先别跑一趟',
  },
];

function normalize(raw, index) {
  const id = String(raw.id ?? '').trim();
  if (!id) throw new Error(`doors[${index}] 缺少 id`);
  const deviceId = String(raw.deviceId ?? raw.device_id ?? `door-${id}`).trim();
  return {
    id,
    name: String(raw.name ?? id).trim(),
    location: String(raw.location ?? '').trim(),
    deviceId,
    openHint: String(raw.openHint ?? '门开着,可以过来').trim(),
    closedHint: String(raw.closedHint ?? '门已关,先别跑一趟').trim(),
  };
}

export function loadDoorRegistry() {
  let parsed;

  if (config.doorsJson) {
    try {
      parsed = JSON.parse(config.doorsJson);
    } catch (err) {
      throw new Error(`DOORS_JSON 不是合法 JSON: ${err.message}`);
    }
  } else if (fs.existsSync(config.doorsFile)) {
    const text = fs.readFileSync(config.doorsFile, 'utf8');
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${config.doorsFile} 不是合法 JSON: ${err.message}`);
    }
  } else {
    console.warn(`[doorwatch] 找不到 ${config.doorsFile},使用默认门禁配置`);
    parsed = { doors: DEFAULT_DOORS };
  }

  const list = Array.isArray(parsed) ? parsed : parsed.doors;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('门禁配置为空,至少要有一扇门');
  }

  const doors = list.map(normalize);

  // deviceId 必须唯一,否则 MQTT 消息会串门
  const seen = new Set();
  for (const d of doors) {
    if (seen.has(d.deviceId)) {
      throw new Error(`deviceId 重复: ${d.deviceId}(门 ${d.id})`);
    }
    seen.add(d.deviceId);
  }

  return doors;
}
