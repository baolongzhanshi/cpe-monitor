/// CPEye PWA：页面与静态资源优先缓存，API 响应只走网络。

const CACHE_NAME = 'cpeye-v1';
const STATIC_ASSETS = [
  '/dashboard',
  '/manifest.json',
];

function isApiRequest(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

// 安装时预缓存页面与静态资源。
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
  self.skipWaiting();
});

// 升级时清除旧版写入的 API 数据，避免密码、短信和登录状态残留。
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(async (key) => {
        if (key !== CACHE_NAME) {
          await caches.delete(key);
          return;
        }
        const cache = await caches.open(key);
        const requests = await cache.keys();
        await Promise.all(requests
          .filter((request) => isApiRequest(new URL(request.url)))
          .map((request) => cache.delete(request)));
      }));
      await self.clients.claim();
    })(),
  );
});

// API 禁用浏览器缓存与离线回退，其余 GET 请求保留缓存优先策略。
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (isApiRequest(url)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  if (request.method !== 'GET') return;

  // 页面与静态资源继续支持离线读取。
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }),
  );
});
