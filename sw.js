// 投手情蒐系統 - Service Worker
// 更新版本號可強制所有裝置重新快取
const CACHE_NAME = 'pitcher-scout-v553';

// 同源核心資源（必快取，cache.add 可靠）
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 外部 CDN 函式庫（離線 PDF / 圖表 / Firebase 需要）
// 預先快取，讓「全新裝置安裝後直接離線」也能用 PDF 匯出與統計圖表
const EXTERNAL_ASSETS = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js'
];

// ====== 安裝：快取靜態資源，由 app.js 決定何時接管 ======
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 核心檔：逐檔快取，部分失敗不影響其他檔案（避免全或無導致快取不完整）
      const core = Promise.allSettled(
        CORE_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
      // CDN：跨來源用 no-cors 抓取後手動 put（cache.add 對 opaque 回應會失敗）
      // 全部 best-effort，任何失敗都不影響安裝與核心快取
      const external = Promise.allSettled(
        EXTERNAL_ASSETS.map(url =>
          fetch(url, { mode: 'no-cors' })
            .then(resp => cache.put(url, resp))
            .catch(() => {})
        )
      );
      return Promise.all([core, external]);
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

// ====== 攔截請求 ======
self.addEventListener('fetch', event => {
  // 只處理 GET，跳過 chrome-extension 等非 http 請求
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const isExternal = !event.request.url.includes(self.location.hostname);

  // ── 外部資源（CDN / Google Fonts）：Cache First，背景補快取 ──
  if (isExternal) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // 同源 200 與跨來源 opaque(status 0) 都存起來，確保離線可用
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // ── 本地資源：Stale-While-Revalidate ──
  // 有快取就「秒回」（弱訊號/離線都不卡），同時背景抓新版更新快取，下次開啟即最新。
  // 跨版本更新仍由 SW 生命週期（新 CACHE_NAME → 更新 Modal → SKIP_WAITING）處理，不受影響。
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(new Request(event.request, { cache: 'no-cache' }))
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => null);
      // 有快取：立即回快取，網路在背景更新；無快取：等網路（離線且無快取才會失敗）
      return cached || networkFetch.then(r => r || caches.match(event.request));
    })
  );
});
