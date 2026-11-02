/* IT 办公室门磁看板 —— 前端 */

const $ = (sel) => document.querySelector(sel);

const state = {
  doors: [],
  connected: false,
  adminKey: localStorage.getItem('dw_admin_key') ?? '',
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

const STATE_META = {
  open: { icon: '🔓', title: '门开着', cls: 'open' },
  closed: { icon: '🔒', title: '门关着', cls: 'closed' },
  unknown: { icon: '⚠️', title: '状态未知', cls: 'unknown' },
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

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 10_000) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return fmtTime(ts);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
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
  let t = startMs;
  const segs = [];

  for (const e of events) {
    if (e.at > t) segs.push({ state: cur, from: t, to: e.at });
    cur = e.to_state;
    t = e.at;
  }
  segs.push({ state: cur, from: t, to: nowMs });

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
  if (door.timesHidden) return '已隐藏';
  if (!ts) return '无记录';
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
      const hint = door.hints?.[meta.cls] ?? '';
      const onlineBadge = door.online
        ? '<span class="badge badge--online">传感器在线</span>'
        : '<span class="badge badge--offline">传感器离线</span>';
      const overrideBadge = door.overridden
        ? '<span class="badge badge--override">人工置顶</span>'
        : '';
      // 电量徽章:服务端没报过 / 读数过期就什么都不显示。
      // 低于 20% 高亮 —— 这是蓝牙门磁唯一能提前发现"要换电池了"的信号。
      const batteryBadge = door.battery != null
        ? `<span class="badge ${door.battery <= 20 ? 'badge--warn' : 'badge--battery'}">电量 ${door.battery}%</span>`
        : '';
      const stats = door.stats ?? { opens: 0, closes: 0 };

      return `
      <article class="door door--${meta.cls}" data-door="${esc(door.id)}">
        <div class="door__head">
          <h2 class="door__name">${esc(door.name)}
            ${door.location ? `<span class="door__loc">${esc(door.location)}</span>` : ''}
          </h2>
          <div>${onlineBadge} ${overrideBadge} ${batteryBadge}</div>
        </div>

        <div class="door__state">
          <div class="state__icon">${meta.icon}</div>
          <div>
            <div class="state__title">${meta.title}</div>
            <p class="state__hint">${esc(hint)}</p>
          </div>
        </div>

        <div class="door__meta">
          <span>最后变化:${timeCell(door, 'change')}</span>
          <span>心跳:${timeCell(door, 'seen')}</span>
          <span>今天:开 <b>${stats.opens}</b> 次 / 关 <b>${stats.closes}</b> 次</span>
        </div>

        <div class="timeline">
          <div class="timeline__track">${buildTimeline(door)}</div>
          <div class="timeline__axis"><span>00:00</span><span>现在</span></div>
        </div>
      </article>`;
    })
    .join('');

  updateSubtitle();
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
    const next = ts ? relTime(ts) : '无记录';
    if (el.textContent !== next) el.textContent = next;
  }
}

function updateSubtitle() {
  const sub = $('#subtitle');
  const title = document.querySelector('.topbar h1');

  // 只有一扇门时直接用它的名字;多扇门就用统称,别让标题撒谎
  if (title) {
    title.textContent =
      state.doors.length === 1 ? state.doors[0].name : state.doors.length > 1 ? 'IT 在岗状态' : 'IT 状态';
  }

  if (!state.connected) {
    sub.textContent = '连接断开,正在重试…';
    return;
  }
  const open = state.doors.filter((d) => d.state === 'open').length;
  const unknown = state.doors.filter((d) => d.state === 'unknown').length;
  if (unknown > 0) sub.textContent = `${unknown} 个门状态未知`;
  else if (open > 0) sub.textContent = '有人值班,可以直接过去';
  else sub.textContent = '暂无人在办公室';
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
    updateSubtitle();
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
 *   于是页面就一直挂在「连接断开,正在重试…」,其实早就没人再试了。
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
    updateSubtitle();
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
 * 管理面板
 * ------------------------------------------------------------------ */

async function apiCall(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': state.adminKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function renderManageBody() {
  const body = $('#manage-body');

  if (!state.adminKey) {
    body.innerHTML = `
      <p>输入管理密钥(服务器 data/ADMIN_KEY.txt 里那个)以解锁写操作。</p>
      <input id="key-input" type="password" placeholder="管理密钥" autocomplete="off" />
      <div class="btn-row"><button class="btn btn--primary" id="key-verify">解锁</button></div>
      <div class="msg" id="manage-msg"></div>
    `;

    $('#key-verify').addEventListener('click', async () => {
      const key = $('#key-input').value.trim();
      const msg = $('#manage-msg');
      if (!key) {
        msg.className = 'msg msg--err';
        msg.textContent = '请输入密钥';
        return;
      }
      // 先拿这个密钥去问服务端:对就留下,不对就丢掉
      state.adminKey = key;
      try {
        await apiCall('GET', '/api/admin/verify');
        localStorage.setItem('dw_admin_key', key);
        msg.className = 'msg msg--ok';
        msg.textContent = '已解锁';
        renderManageBody();
      } catch (err) {
        state.adminKey = '';
        localStorage.removeItem('dw_admin_key');
        msg.className = 'msg msg--err';
        msg.textContent = err.message.includes('密钥') ? '密钥不正确' : err.message;
      }
    });
    return;
  }

  body.innerHTML = `
    <p>已解锁。置顶用于特殊情况(如全员出差),会覆盖传感器状态。</p>
    ${state.doors
      .map(
        (d) => `
      <div class="door-admin">
        <div class="door-admin__name">${esc(d.name)}</div>
        <div class="btn-row">
          <button class="btn" data-act="closed" data-id="${esc(d.id)}">置顶为关门 4 小时</button>
          <button class="btn" data-act="open" data-id="${esc(d.id)}">置顶为开门 4 小时</button>
          <button class="btn" data-act="clear" data-id="${esc(d.id)}">取消置顶</button>
        </div>
      </div>`,
      )
      .join('')}
    <div class="msg" id="manage-msg"></div>
  `;

  body.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const msg = $('#manage-msg');
      const { act, id } = btn.dataset;
      try {
        if (act === 'clear') await apiCall('DELETE', `/api/doors/${id}/override`);
        else await apiCall('POST', `/api/doors/${id}/override`, { state: act, hours: 4 });
        msg.className = 'msg msg--ok';
        msg.textContent = '已生效';
        await loadDoors();
      } catch (err) {
        msg.className = 'msg msg--err';
        msg.textContent = err.message;
      }
    });
  });
}

function openManage() {
  $('#manage-sheet').hidden = false;
  renderManageBody();
}

function closeManage() {
  $('#manage-sheet').hidden = true;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

$('#refresh').addEventListener('click', loadDoors);
$('#manage-btn').addEventListener('click', openManage);
$('#manage-close').addEventListener('click', closeManage);
$('#manage-sheet').addEventListener('click', (e) => {
  if (e.target === $('#manage-sheet')) closeManage();
});

loadDoors();
connectSSE();

// 每秒刷新"X 秒前"这类相对时间(只改文本节点,不重建 DOM)
setInterval(tick, 1000);

// 看门狗:连接被系统悄悄掐掉时自己救回来
startWatchdog();

// 版本号
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    $('#version').textContent = `v${h.version}`;
  })
  .catch(() => {});

// 注册 Service Worker(支持"添加到主屏幕")
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
