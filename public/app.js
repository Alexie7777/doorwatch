/* IT 办公室门磁看板 —— 前端
 *
 * ★ 所有面向用户的文案都走 t(key)(见 i18n.js)。
 *   模板里不许再硬编码中文 —— 英文界面下那些字会原样露出来。
 */

import { getLang, setLang, t, onLangChange, monthName } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  doors: [],
  connected: false,
  events: null,
};

/**
 * SSE 相关的三个常量/变量。
 *
 * ★ 这套东西的全部意义是「出门前扫一眼」—— 用户看到的东西必须是真的。
 *   所以连接断了以后,宁可多花点流量轮询,也不能让看板上留着一份
 *   过期数据却看起来是新的。
 */
const WATCHDOG_MS = 180_000; // 3 分钟没收到 SSE 数据 → 主动重建连接
const FALLBACK_POLL_MS = 15_000; // 连接断了之后,每 15 秒拉一次全量
let sse = null;
/** 最后一次收到 SSE 数据的时间(看门狗用) */
let sseLastEventAt = 0;
/** 兜底轮询的定时器 */
let fallbackTimer = null;

/**
 * 三种状态各自的图标和文案键。
 *
 * ★ 三态设计(open / closed / unknown)是本项目的命根子,不能简化:
 *   传感器失联时必须显示「状态未知」,不能拿过期状态充数。
 *   颜色、图标、文字三条线各自独立地表示状态,少一条都不行。
 */
const STATE_META = {
  open: { icon: '🔓', titleKey: 'stateOpen', cls: 'open' },
  closed: { icon: '🔒', titleKey: 'stateClosed', cls: 'closed' },
  unknown: { icon: '⚠️', titleKey: 'stateUnknown', cls: 'unknown' },
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * 把提示语渲染成 HTML。
 *
 * 提示语里可以写 `[值班微信](wechat)`,这一段会变成一个可点的按钮,
 * 点开弹出值班微信的二维码。写法之外的全是普通文字(一律转义)。
 *
 * 为什么用这种「方括号+圆括号」的写法,而不是一个单独的字段:
 *   ① 链接的**文字**就写在句子里,中英文各写各的,不用再加两个字段;
 *   ② 加字段就得改数据库表结构,而提示语本来就是自由文本,这里多几行解析就够。
 *
 * @param {string} hint   提示语原文
 * @param {string} qrPath 二维码图片路径;没配就当普通文字显示
 */
function renderHint(hint, qrPath) {
  const text = String(hint ?? '');
  if (!text) return '';

  const re = /\[([^\]\n]+)\]\(wechat\)/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    out += qrPath
      ? `<button type="button" class="qr-link" data-qr="${esc(qrPath)}">${esc(m[1])}</button>`
      : esc(m[1]);
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

/**
 * 值班微信二维码弹层。
 *
 * 整站就一个二维码,所以图片路径由服务端下发(door.wechatQr),
 * 换人值班时只要换掉那张图片,不用改任何代码。
 */
function openQr(src) {
  if (!src) return;
  const img = $('#qr-img');
  if (!img) return;
  img.src = src;
  img.alt = t('qrAlt');
  const cap = $('#qr-caption');
  if (cap) cap.textContent = t('qrCaption');
  const modal = $('#qr-modal');
  if (modal) modal.hidden = false;
}

function closeQr() {
  const modal = $('#qr-modal');
  if (modal) modal.hidden = true;
  const img = $('#qr-img');
  if (img) img.removeAttribute('src');
}

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 10_000) return t('relJustNow');
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('relSeconds', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('relMinutes', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('relHours', { n: h });
  const d = Math.floor(h / 24);
  if (d === 1) return t('relYesterday');
  if (d < 30) return t('relDays', { n: d });
  return fmtTime(ts);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return t('dateFull', {
    month: monthName(d.getMonth()),
    day: d.getDate(),
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  });
}

function clock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 取一扇门在当前语言下的档案。
 *
 * 服务端两套文案一起下发(door.i18n.zh / door.i18n.en),
 * 这里按当前语言挑一套;挑不到就退回原来的 door 字段。
 */
function doorLocale(door) {
  const lang = getLang();
  return door?.i18n?.[lang] ?? door ?? {};
}

/** 根据今天的事件重建 24 小时状态条 */
function buildTimeline(door) {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startMs = dayStart.getTime();
  const nowMs = now.getTime();
  const span = Math.max(nowMs - startMs, 60_000);

  const events = door.todayEvents ?? [];
  // 午夜时的状态 = 第一个事件发生前的状态
  let cur = events.length ? (events[0].from_state ?? 'unknown') : door.state;
  let t0 = startMs;
  const segs = [];

  for (const e of events) {
    if (e.at > t0) segs.push({ state: cur, from: t0, to: e.at });
    cur = e.to_state;
    t0 = e.at;
  }
  segs.push({ state: cur, from: t0, to: nowMs });

  return segs
    .map((s) => {
      const left = ((s.from - startMs) / span) * 100;
      const width = Math.max(((s.to - s.from) / span) * 100, 0.8);
      return `<div class="timeline__seg timeline__seg--${esc(s.state)}" style="width:${width.toFixed(2)}%"></div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 时间文本:数据被脱敏 → 提示隐藏;本来就没数据 → 无记录;否则相对时间 */
function timeCell(door, kind) {
  const ts = kind === 'change' ? door.lastChangeAtPublic : door.lastSeenAtPublic;
  if (door.timesHidden) return t('relHidden');
  if (!ts) return t('relNoRecord');
  return `<b data-t="${ts}">${relTime(ts)}</b>`;
}

function render() {
  const main = $('#doors');

  if (!state.doors.length) {
    main.innerHTML = `<div class="skeleton"></div>`;
    return;
  }

  main.innerHTML = state.doors
    .map((door) => {
      const meta = STATE_META[door.state] ?? STATE_META.unknown;
      const loc = doorLocale(door);
      const name = loc.name ?? door.name;
      const location = loc.location ?? door.location;
      // 提示语优先用当前语言那套,没有就退回 hints(旧数据兼容)
      const fallbackHint = meta.cls === 'unknown' ? t('unknownHint') : '';
      const hint = loc[meta.cls] ?? door.hints?.[meta.cls] ?? fallbackHint;
      const onlineBadge = door.online
        ? `<span class="badge badge--online">${t('badgeOnline')}</span>`
        : `<span class="badge badge--offline">${t('badgeOffline')}</span>`;
      const overrideBadge = door.overridden
        ? `<span class="badge badge--override">${t('badgeOverride')}</span>`
        : '';
      // 电量徽章:服务端没报过 / 读数过期就什么都不显示。
      // 低于 20% 高亮 —— 这是蓝牙门磁唯一能提前发现"要换电池了"的信号。
      const batteryBadge = door.battery != null
        ? `<span class="badge ${door.battery <= 20 ? 'badge--warn' : 'badge--battery'}">${t('battery', { n: door.battery })}</span>`
        : '';
      const stats = door.stats ?? { opens: 0, closes: 0 };

      return `
      <article class="door door--${meta.cls}" data-door="${esc(door.id)}">
        <div class="door__head">
          <h2 class="door__name">${esc(name)}
            ${location ? `<span class="door__loc">${esc(location)}</span>` : ''}
          </h2>
          <div>${onlineBadge} ${overrideBadge} ${batteryBadge}</div>
        </div>

        <div class="door__state">
          <div class="state__icon">${meta.icon}</div>
          <div>
            <div class="state__title">${t(meta.titleKey)}</div>
            <p class="state__hint">${renderHint(hint, door.wechatQr)}</p>
          </div>
        </div>

        <div class="door__meta">
          <span>${t('lastChange')}${t('colon')}${timeCell(door, 'change')}</span>
          <span>${t('heartbeat')}${t('colon')}${timeCell(door, 'seen')}</span>
          <span>${t('today', { open: `<b>${stats.opens}</b>`, close: `<b>${stats.closes}</b>` })}</span>
        </div>

        <div class="timeline">
          <div class="timeline__track">${buildTimeline(door)}</div>
          <div class="timeline__axis"><span>00:00</span><span>${t('now')}</span></div>
        </div>
      </article>`;
    })
    .join('');

  updateTitle();
}

/**
 * 每秒只刷新"X 秒前"这类相对时间。
 * 不用重绘整个列表 —— 每秒重建 innerHTML 会造成闪烁,还会把用户正在选的文字冲掉。
 * 而且只在文本真的变了时才写 DOM:手机上开着看板一整天的话,
 * "N 分钟前"其实一分钟才变一次,没必要每秒都碰 DOM(省电,也不打断用户操作)。
 */
function tick() {
  for (const el of document.querySelectorAll('[data-t]')) {
    const ts = Number(el.dataset.t);
    const next = ts ? relTime(ts) : t('relNoRecord');
    if (el.textContent !== next) el.textContent = next;
  }
}

/**
 * 更新页头标题。
 *
 * 只有一扇门时直接用它的名字;多扇门就用统称,别让标题撒谎。
 * (以前标题下面还有一行副标题,写「有人值班,可以直接过去」——
 *  那行已经删了:门卡片里本来就有这句,页头再说一遍是重复。)
 */
/**
 * 页头标题 = 应用名(品牌)。
 *
 * 以前这里会跟着门的数量变:一扇门显示门名、多扇门显示「IT 在岗状态」。
 * 品牌定了就固定下来 —— 门名在下面的卡片里写着,页头不用再重复一遍。
 */
function updateTitle() {
  const title = document.querySelector('.topbar h1');
  if (title) title.textContent = t('appTitle');
}

/* ------------------------------------------------------------------ *
 * 语言
 * ------------------------------------------------------------------ */

/**
 * 把页面上所有"静态"文案刷成当前语言。
 *
 * 卡片内容由 render() 重画,
 * 这里只管那些不随数据变的元素:标题、按钮标签、页脚。
 */
function applyLang() {
  const lang = getLang();
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh';
  document.title = t('pageTitle');

  // 切换按钮显示的是"另一种语言"的名字
  const langBtn = $('#lang-toggle');
  if (langBtn) {
    langBtn.textContent = lang === 'zh' ? 'EN' : '中';
    langBtn.setAttribute('aria-label', t('langSwitch'));
  }
  $('#refresh')?.setAttribute('aria-label', t('refresh'));
  $('#qr-close')?.setAttribute('aria-label', t('close'));

  const hint = $('#footer-hint');
  if (hint) hint.textContent = t('footerHint');
  const brand = $('#footer-brand');
  if (brand) brand.textContent = t('poweredBy');

  // 这两个是给分享/搜索结果看的,也算面向用户的文案
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', t('description'));
  const homeTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (homeTitle) homeTitle.setAttribute('content', t('homeTitle'));
}

/* ------------------------------------------------------------------ *
 * 数据获取
 * ------------------------------------------------------------------ */

async function loadDoors() {
  try {
    const res = await fetch('/api/doors', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.doors = data.doors ?? [];
    state.connected = true;
    render();
  } catch (err) {
    state.connected = false;
    updateTitle();
    $('#conn-dot')?.classList.add('dot--bad');
  }
}

/**
 * 建立 SSE 连接。
 *
 * ★ 为什么要自己盯着,而不能全靠 EventSource 自带重连:
 *   规范里 EventSource 只在「连接被中断」时自动重连;
 *   如果重连时服务器返回了非 200 或者 Content-Type 不对,
 *   浏览器会**彻底放弃**(readyState = CLOSED),再也不重试了。
 *   于是页面就再也收不到推送了(右上角的点一直是琥珀色),
 *   其实早就没人再试了。
 *   —— 这是真踩过的坑:手机锁屏再解锁、网络抖动一下,看板就再也不更新了。
 *
 *   所以这里加了两道保险:
 *   ① 看门狗:超过 WATCHDOG_MS 没收到任何数据,就主动把连接重建
 *   ② 页面重新可见时,如果断着,立刻重建
 */
function connectSSE() {
  closeSSE();

  const es = new EventSource('/api/stream');
  sse = es;

  es.addEventListener('doors', (e) => {
    state.doors = JSON.parse(e.data);
    state.connected = true;
    sseLastEventAt = Date.now();
    stopFallbackPoll();
    $('#conn-dot')?.classList.add('dot--on');
    render();
  });

  es.onopen = () => {
    state.connected = true;
    sseLastEventAt = Date.now();
    $('#conn-dot')?.classList.add('dot--on');
  };

  es.onerror = () => {
    state.connected = false;
    $('#conn-dot')?.classList.remove('dot--on');
    updateTitle();
    // EventSource 自带重连,这里只更新 UI。
    // 万一它不重试(见上面的说明),看门狗会兜底。
    startFallbackPoll();
  };
}

function closeSSE() {
  if (!sse) return;
  try {
    sse.close();
  } catch {
    /* ignore */
  }
  sse = null;
}

/**
 * 看门狗:太久没收到数据就重建连接。
 *
 * 数据多久来一次?门磁每 60 秒一个心跳,服务端收到心跳就推一次快照 ——
 * 所以 3 分钟还没动静,那就八成是连接已经死了,只是浏览器没告诉我们。
 *
 * ★ 不管 state.connected 是什么都要检查:
 *   最麻烦的情况恰恰是"浏览器自己放弃了重连" ——
 *   那时 state.connected 是 false,EventSource 也不会再试,
 *   如果看门狗也跟着 state.connected 走,就永远救不回来了。
 */
function startWatchdog() {
  setInterval(() => {
    if (Date.now() - sseLastEventAt < WATCHDOG_MS) return;
    console.warn('[doorwatch] SSE 超过', Math.round(WATCHDOG_MS / 1000), '秒没动静,重建连接');
    connectSSE();
  }, 15_000);
}

/**
 * 兜底轮询:SSE 断了的时候,定时拉一次 /api/doors。
 *
 * 为什么要这个:看板上留着「9 分钟前的门开着」,而用户没注意到右上角的
 * 灰点 —— 那就是在撒谎。轮询慢一点没关系,至少数据是真的。
 */
function startFallbackPoll() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/doors', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      state.doors = data.doors ?? [];
      render();
    } catch {
      /* 断网就断网,等下一轮 */
    }
  }, FALLBACK_POLL_MS);
}

function stopFallbackPoll() {
  if (!fallbackTimer) return;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

/**
 * 页面重新可见时立刻检查一下连接。
 *
 * 手机锁屏 / 切走 App,系统的网络栈会把这条连接悄悄掐掉,
 * 回来的时候浏览器可能已经把 EventSource 判死刑了。
 * 这里主动重建一次,用户回到页面就能看到最新状态。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - sseLastEventAt > 60_000) connectSSE();
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

$('#refresh').addEventListener('click', loadDoors);

// 点提示语里的「值班微信」→ 弹出二维码
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('.qr-link');
  if (link) {
    e.preventDefault();
    openQr(link.dataset.qr);
    return;
  }
  // 点遮罩空白处关闭
  if (e.target === $('#qr-modal')) closeQr();
});
$('#qr-close')?.addEventListener('click', closeQr);
// Esc 关闭(桌面端顺手)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeQr();
});

// 语言切换:写进 localStorage,订阅者把整页重画一遍
$('#lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
});

onLangChange(() => {
  applyLang();
  render();
});

// 先把静态文案刷成当前语言,再拉数据
applyLang();

loadDoors();
connectSSE();

// 每秒刷新"X 秒前"这类相对时间(只改文本节点,不重建 DOM)
setInterval(tick, 1000);

// 看门狗:连接被系统悄悄掐掉时自己救回来
startWatchdog();

// 注册 Service Worker(支持"添加到主屏幕")
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
