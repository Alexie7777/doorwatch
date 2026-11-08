/* IT 办公室门磁看板 —— 主题(日间 / 夜间 / 跟随系统)
 *
 * 为什么单独一个文件:
 *   主题跟语言一样是「用户偏好」—— 要存 localStorage、要能被别的模块读、
 *   变了要通知别人。i18n.js 已经把这套跑通了,这里照着抄一遍形状,
 *   两个模块互不依赖,谁也不用迁就谁。
 *
 * ★ 两个属性分工,别混:
 *   <html data-theme-mode="auto|light|dark">  用户**选**的是哪一种
 *   <html data-theme="light|dark">            实际**生效**的是哪一种
 *
 *   选 auto 时,生效的那个要问系统(matchMedia)。分成两个属性,
 *   按钮图标才能显示"我选的是哪一种",而配色只管"现在是亮是暗",
 *   两件事互不干扰 —— 系统半夜自动切深色时,按钮图标仍然显示"跟随系统"。
 *
 * ★ 首屏不许闪:
 *   主题必须在第一帧渲染**之前**定下来,否则刷新时先闪一下深色再变浅色。
 *   所以 index.html 的 <head> 里有一段同步内联脚本先把这个属性写好,
 *   本模块是第二道保险(把内联脚本的结果同步过来,并处理之后的切换)。
 */

export const THEMES = ['auto', 'light', 'dark'];
export const DEFAULT_THEME = 'auto';

/** localStorage 里的键名 */
const STORAGE_KEY = 'dw_theme';

/** 两种主题各自的背景色 —— 手机的地址栏/状态栏要跟页面底色一致 */
const THEME_COLOR = { light: '#f1f4f8', dark: '#0b0f14' };

/** 订阅主题变化的回调 */
const listeners = new Set();

/**
 * 系统是不是浅色主题。
 * matchMedia 在很老的浏览器里不存在,这时候一律当深色(看板一直就是深色的)。
 */
const mq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

/**
 * 用户选的是哪一种主题。
 * 读不出来(隐私模式 / localStorage 被禁)就退回「跟随系统」。
 */
export function getThemeMode() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * 实际生效的是哪一种:'light' | 'dark'。
 * 选 auto 时问系统,其余按用户说的来。
 */
export function resolveTheme(mode = getThemeMode()) {
  if (mode === 'light' || mode === 'dark') return mode;
  return mq?.matches ? 'light' : 'dark';
}

/**
 * 把主题写到 <html> 上,并同步手机浏览器的 theme-color。
 *
 * 只改属性、不碰 localStorage —— 存不存是 setTheme() 的事。
 *
 * @param {string} mode 用户选的模式
 * @returns {'light'|'dark'} 实际生效的主题
 */
function apply(mode) {
  const el = document.documentElement;
  const eff = resolveTheme(mode);
  el.setAttribute('data-theme-mode', mode);
  el.setAttribute('data-theme', eff);

  // 手机浏览器的地址栏/状态栏会拿这个颜色当底色。
  // 不跟着换的话,浅色页面上会留一条黑色的地址栏,很难看。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[eff]);

  return eff;
}

/**
 * 切换主题:写 localStorage,应用,通知所有订阅者。
 * @param {string} mode 'auto' | 'light' | 'dark'
 */
export function setTheme(mode) {
  const next = THEMES.includes(mode) ? mode : DEFAULT_THEME;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 存不了就算了,本次会话内照样生效 */
  }
  const eff = apply(next);
  for (const fn of listeners) {
    try {
      fn(next, eff);
    } catch (err) {
      console.error('[theme] 主题变更回调出错:', err);
    }
  }
  return next;
}

/**
 * 下一个模式 —— 按钮循环用:跟随系统 → 日间 → 夜间 → 跟随系统。
 */
export function nextTheme(mode = getThemeMode()) {
  const i = THEMES.indexOf(THEMES.includes(mode) ? mode : DEFAULT_THEME);
  return THEMES[(i + 1) % THEMES.length];
}

/**
 * 订阅主题变化。
 * @param {(mode: string, effective: 'light'|'dark') => void} fn
 * @returns {() => void} 退订函数
 */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 启动主题逻辑。
 *
 * index.html 的内联脚本已经把属性写好了,这里再跑一遍是为了:
 *   ① 拿 localStorage 里的值跟 <html> 上的属性对齐(以 localStorage 为准);
 *   ② 挂上「系统主题变了」的监听 —— auto 模式下,系统切了看板就得跟着切。
 */
export function initTheme() {
  const mode = getThemeMode();
  apply(mode);

  mq?.addEventListener?.('change', () => {
    // 用户手动定过主题就别跟着系统变
    if (getThemeMode() !== 'auto') return;
    const eff = apply('auto');
    for (const fn of listeners) {
      try {
        fn('auto', eff);
      } catch (err) {
        console.error('[theme] 主题变更回调出错:', err);
      }
    }
  });

  return mode;
}
