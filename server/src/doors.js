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
    nameEn: 'IT Office',
    location: '',
    locationEn: '',
    deviceId: 'it-office-door',
    openHint: 'IT 有人在,直接过来就行',
    openHintEn: 'Someone from IT is in — just come over',
    closedHint: '门已关，IT 暂时不在，可联系[值班微信](wechat)',
    closedHintEn: 'Door closed, IT is temporarily away. Contact [the on-duty WeChat](wechat).',
    unknownHint: '传感器没上线,状态未知 —— 请先联系 IT',
    unknownHintEn: 'Sensor offline, status unknown — please contact IT',
  },
];

/**
 * 把登记表里的一条原始配置整理成内部用的形状。
 *
 * ★ 英文那一套(*En)全是**可选**的:
 *   没填就留空字符串,后面(toPublic)再回退到中文那份 ——
 *   绝不能因为漏配英文就让界面上出现空白。
 *   门名和位置也一样:locationEn 缺了就用 location。
 */
function normalize(raw, index) {
  const id = String(raw.id ?? '').trim();
  if (!id) throw new Error(`doors[${index}] 缺少 id`);
  const deviceId = String(raw.deviceId ?? raw.device_id ?? `door-${id}`).trim();
  return {
    id,
    name: String(raw.name ?? id).trim(),
    nameEn: String(raw.nameEn ?? raw.name_en ?? '').trim(),
    location: String(raw.location ?? '').trim(),
    locationEn: String(raw.locationEn ?? raw.location_en ?? '').trim(),
    deviceId,
    openHint: String(raw.openHint ?? '门开着,可以过来').trim(),
    openHintEn: String(raw.openHintEn ?? raw.open_hint_en ?? '').trim(),
    closedHint: String(raw.closedHint ?? '门已关，IT 暂时不在，可联系[值班微信](wechat)').trim(),
    closedHintEn: String(raw.closedHintEn ?? raw.closed_hint_en ?? '').trim(),
    // unknown 提示语以前是写死在 state.js 里的,挪到这里每扇门都能定制;
    // 不填就沿用以前那一句(见 state.js 的 DEFAULT_UNKNOWN_HINT)。
    unknownHint: String(raw.unknownHint ?? raw.unknown_hint ?? '').trim(),
    unknownHintEn: String(raw.unknownHintEn ?? raw.unknown_hint_en ?? '').trim(),
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
