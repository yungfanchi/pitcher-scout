// 投手情蒐系統 - Service Worker
// 更新版本號可強制所有裝置重新快取
const CACHE_NAME = 'pitcher-scout-v511';

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

// ====== 安裝：快取靜態資源，由 app.js 決定何時接管 ======
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 逐檔快取，部分失敗不影響其他檔案（避免全或無導致快取不完整）
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url).catch(() => {}))
      );
    })
    // skipWaiting 由 app.js 發送 SKIP_WAITING 訊息觸發，避免輪詢造成重載迴圈
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

  // 本地資源：Network First，加 no-cache 確保更新後 reload 不抓瀏覽器 HTTP 快取
  const noCache = new Request(event.request, { cache: 'no-cache' });
  event.respondWith(
    fetch(noCache)
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