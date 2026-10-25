/* ==========================================================================
   sw.js · 小满券仓 Service Worker（M5a 离线兜底）
   —— 导航请求：网络优先，失败回退缓存首页 / 快照，断网也能浏览已缓存券。
      静态资源：缓存优先，后台更新。不拦截 API（/api/）请求，保证数据实时。
   ========================================================================== */
const CACHE = 'coupon-v3';
const CORE = [
  '/', '/index.html',
  '/assets/css/tokens.css', '/assets/css/main.css', '/assets/css/coupon.css',
  '/assets/js/tracker.js', '/assets/js/app.js', '/assets/js/store.js',
  '/assets/js/share.js', '/assets/js/qrcode.js', '/assets/js/coupon-page.js', '/assets/js/activities.js',
  '/assets/js/challenge.js',
  '/assets/js/detail-page.js', '/assets/js/drops-page.js', '/assets/js/my-alerts.js',
  '/drops.html', '/my-alerts.html',
  '/data/coupon-snapshot.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(CORE).catch(function () {}); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = req.url || '';
  // API 不进缓存策略，直接走网络（保证数据实时）
  if (url.indexOf('/api/') >= 0) return;
  // 跨域请求不拦截：缓存优先策略只适用于同源静态资源。此前未排除跨域图片/广告，
  // 其 fetch 失败后 respondWith(undefined) 会抛 "Failed to convert value to 'Response'"；
  // 交由浏览器原生处理（web-push 已下线，Service Worker 仅保留离线兜底）。
  try {
    if (new URL(url).origin !== self.location.origin) return;
  } catch (err) { return; }

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('/index.html').then(function (r) { return r || caches.match('/'); });
      })
    );
    return;
  }

  // 静态同源资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then(function (r) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () { return r; });
      return r || net;
    })
  );
});

