/* IT 办公室门磁看板 —— 中英文案与语言状态
 *
 * 为什么单独一个文件:
 *   看板的外籍老师多,页面上每一句面向用户的话都得能换成英文。
 *   文案集中放在这里,加一门语言只要加一个字典 + 一个语言代码,
 *   不用满仓库去搜中文字符串。
 *
 * ★ 一条硬规矩:模板里不允许再硬编码中文。
 *   所有面向用户的文案都走 t(key),取不到就回退到中文,再取不到
 *   宁可显示 key 本身(一眼能看出漏配了),也不显示空白。
 */

export const LANGS = ['zh', 'en'];
export const DEFAULT_LANG = 'zh';

/** localStorage 里的键名 */
const STORAGE_KEY = 'dw_lang';

const DICT = {
  zh: {
    /* ---- 页面主体 ---- */
    pageTitle: 'IT 办公室状态',
    appTitle: 'IT 办公室',
    statusTitle: 'IT 在岗状态',
    stateOpen: '门开着',
    stateClosed: '门关着',
    stateUnknown: '状态未知',
    badgeOnline: '传感器在线',
    badgeOffline: '传感器离线',
    badgeOverride: '人工置顶',
    battery: '电量 {n}%',
    lastChange: '最后变化',
    heartbeat: '心跳',
    today: '今天:开 {open} 次 / 关 {close} 次',
    now: '现在',
    footerHint: '一眼知门况，免跑空一趟。',
    poweredBy: 'Powered By IT Dept',

    /* ---- 相对时间 ---- */
    relJustNow: '刚刚',
    relSeconds: '{n} 秒前',
    relMinutes: '{n} 分钟前',
    relHours: '{n} 小时前',
    relYesterday: '昨天',
    relDays: '{n} 天前',
    relNoRecord: '无记录',
    relHidden: '已隐藏',

    /* ---- 绝对时间 ---- */
    dateFull: '{month}{day}日 {time}',

    /* ---- 值班微信二维码 ---- */
    qrCaption: '扫码加值班微信,门关着的时候直接问 TA',
    qrAlt: '值班微信二维码',
    close: '关闭',
    langSwitch: '切换语言',

    /* ---- 杂项 ---- */
    refresh: '刷新',
    requestFailed: '请求失败',
    description: '查看 IT 办公室是否关门,不用白跑一趟',
    // 标签和值之间的冒号 —— 英文那边要留个空格
    colon: ':',
    // 服务端连提示语都没下发时的最后兜底
    unknownHint: '传感器没上线,状态未知 —— 请先联系 IT',

    /* ---- 服务端错误(errorKey,和 server/src/index.js 一一对应)---- */
    need_admin_key: '需要管理密钥',
    bad_admin_key: '管理密钥不正确',
    bad_json: '请求体不是合法 JSON',
    bad_state: 'state 必须是 open 或 closed',
    no_such_door: '没有这扇门',
    api_not_found: '接口不存在',
    server_error: '服务器内部错误',
    bad_path: '非法路径',
    page_not_found: '页面不存在',
  },

  en: {
    /* ---- 页面主体 ---- */
    pageTitle: 'IT Office Status',
    appTitle: 'IT Office',
    statusTitle: 'IT Office Status',
    stateOpen: 'Door Open',
    stateClosed: 'Door Closed',
    stateUnknown: 'Unknown',
    badgeOnline: 'Sensor Online',
    badgeOffline: 'Sensor Offline',
    badgeOverride: 'Manual Override',
    battery: 'Battery {n}%',
    lastChange: 'Last change',
    heartbeat: 'Heartbeat',
    today: 'Today: {open} open / {close} closed',
    now: 'Now',
    footerHint: 'Glance before you leave, no need to grieve.',
    poweredBy: 'Powered By IT Dept',

    /* ---- 相对时间 ---- */
    relJustNow: 'just now',
    relSeconds: '{n}s ago',
    relMinutes: '{n}m ago',
    relHours: '{n}h ago',
    relYesterday: 'yesterday',
    relDays: '{n}d ago',
    relNoRecord: 'no record',
    relHidden: 'hidden',

    /* ---- 绝对时间 ---- */
    dateFull: '{month} {day}, {time}',

    /* ---- 值班微信二维码 ---- */
    qrCaption: 'Scan to add the on-duty WeChat contact',
    qrAlt: 'On-duty WeChat QR code',
    close: 'Close',
    langSwitch: 'Switch language',

    /* ---- 杂项 ---- */
    refresh: 'Refresh',
    requestFailed: 'Request failed',
    description: 'See whether the IT office is open before you walk over.',
    colon: ': ',
    unknownHint: 'Sensor offline, status unknown — please contact IT',

    /* ---- 服务端错误(errorKey,和 server/src/index.js 一一对应)---- */
    need_admin_key: 'Admin key required',
    bad_admin_key: 'Incorrect admin key',
    bad_json: 'Request body is not valid JSON',
    bad_state: 'state must be open or closed',
    no_such_door: 'No such door',
    api_not_found: 'Endpoint not found',
    server_error: 'Internal server error',
    bad_path: 'Invalid path',
    page_not_found: 'Page not found',
  },
};

/** 月份名 —— 日期格式化成"11月3日" / "Nov 3"要用 */
const MONTHS = {
  zh: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  en: [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ],
};

/** 订阅语言变化的回调 */
const listeners = new Set();

/** 当前语言。读不出来(隐私模式 / localStorage 被禁)就退回默认中文 */
export function getLang() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGS.includes(v) ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

/**
 * 切换语言:写 localStorage,然后通知所有订阅者重画。
 * @param {string} lang 'zh' | 'en'
 */
export function setLang(lang) {
  const next = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 存不了就算了,本次会话内照样生效 */
  }
  for (const fn of listeners) {
    try {
      fn(next);
    } catch (err) {
      console.error('[i18n] 语言变更回调出错:', err);
    }
  }
  return next;
}

/**
 * 取当前语言的文案。
 *
 * 回退链:当前语言 → 中文 → key 本身。
 * 宁可显示 key(一眼看出漏配了),也不要空白。
 *
 * @param {string} key  文案键
 * @param {object} [vars] 变量替换,{name} 会被替换成 vars.name
 */
export function t(key, vars) {
  const lang = getLang();
  let s = DICT[lang]?.[key];
  if (s == null) s = DICT[DEFAULT_LANG]?.[key];
  if (s == null) return key;
  if (!vars) return s;

  return String(s).replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] == null ? '' : String(vars[name]),
  );
}

/**
 * 订阅语言变化。
 * @param {(lang: string) => void} fn
 * @returns {() => void} 退订函数
 */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 当前语言的月份名(日期格式化用) */
export function monthName(monthIndex) {
  const lang = getLang();
  const list = MONTHS[lang] ?? MONTHS[DEFAULT_LANG];
  return list[monthIndex] ?? String(monthIndex + 1);
}

/** 供测试用:看看某个键在指定语言下长什么样 */
export function peek(key, lang = DEFAULT_LANG) {
  return DICT[lang]?.[key];
}
