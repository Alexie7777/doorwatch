/* IT 办公室看板 —— Service Worker
   目标:加到手机主屏后,断网/弱网也能秒开页面。

   策略:网络优先,缓存兜底。
   看板的页面资源很小、服务器在内网,网络优先的延迟可以忽略;
   但换来的是"改了样式/逻辑马上生效",不用等缓存过期。
   真正需要的是离线时还能打开,这个由缓存兜底保证。 */

const CACHE = 'doorwatch' + '__STAMP__'.replace(/[^\w.-]/g, '-');
/*
 * 只预缓存外壳。style.css / app.js 在 index.html 里带版本前缀,
 * 运行时按带前缀的 URL 缓存,避免同一份资源在缓存里存两份。
 * i18n.js 是 app.js 的模块依赖,同样要预缓存,离线才开得了。
 * theme.js 也是 app.js 的模块依赖 —— 少了它,离线时主题按钮就点不动了。
 * wechat-qr.jpg 也预缓存 —— 断网时同事照样能扫到值班微信。
 *
 * __STAMP__ 是占位符:服务端发这个文件时会把它换成当前这一版的版本前缀
 * (/v/<戳>)。这样每次部署,Service Worker 的内容都会变 → 浏览器会更新它,
 * activate 时把上一版的缓存整个删掉,不会越攒越多。
 */
const SHELL = [
  '/',
  '/index.html',
  '__STAMP__/icon.svg',
  '__STAMP__/manifest.webmanifest',
  '__STAMP__/i18n.js',
  '__STAMP__/theme.js',
  '__STAMP__/app.js',
  '__STAMP__/style.css',
  '__STAMP__/wechat-qr.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 逐个缓存:某一个文件 404 了,不该把整份外壳都拖下水
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // ★ SSE 绝对不经过 Service Worker。
  //   SW 只是一个中间人:浏览器回收它的时候,正在中转的响应流会跟着被掐断,
  //   页面上就变成「连接断开」—— 而网络其实好得很。
  //   移动端浏览器回收 SW 比桌面积极得多,这条特别容易踩到。
  //   而且这个接口本来就不缓存,让 SW 参与纯属多此一举。
  if (url.pathname === '/api/stream') return;

  // 接口数据不缓存,门的状态必须实时
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 页面资源:优先走网络,断网时回落到缓存
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // 单页应用的兜底:任何页面请求都回落到首页外壳
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return new Response('离线,且没有缓存', { status: 503, statusText: 'Offline' });
      }),
  );
});
