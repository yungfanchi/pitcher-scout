// 投手情蒐系統 - Service Worker
// 更新版本號可強制所有裝置重新快取
const CACHE_NAME = 'pitcher-scout-v62';

// 需要離線快取的資源
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ====== 安裝：快取所有靜態資源（等待用戶確認才接管）======
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(ASSETS_TO_CACHE).catch(() => {
          return cache.add('./index.html');
        });
      })
    // 不呼叫 skipWaiting()，讓頁面有機會顯示更新提示
  );
});

// ====== 接收頁面的 SKIP_WAITING 指令 ======
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ====== 啟動：清除舊版快取 ======
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ====== 攔截請求：Network First，失敗走快取 ======
self.addEventListener('fetch', event => {
  // 只處理 GET，跳過 chrome-extension 等非 http 請求
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  // Google Fonts 等外部資源：Cache First（避免離線時字體失效）
  const isExternal = !event.request.url.includes(self.location.hostname);
  
  if (isExternal) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // 本地資源：Network First，有更新就用新的，離線走快取
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
