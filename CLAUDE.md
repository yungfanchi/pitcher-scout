# 棒壘球投手情蒐系統 · CLAUDE.md

> 這個檔案是給 Claude Code 看的專案說明。每次開新 session 都會自動讀取。
> 更新這個檔案 = 幫 Claude 建立長期記憶，省大量 token。

---

## 專案基本資訊

- **專案名稱**：情蒐系統（Chinese Taipei Pitcher Scouting）
- **目標用戶**：國小到國家隊的棒壘球教練、情蒐員 運動選手家長
- **架構**：單頁 PWA，所有邏輯在 `index.html` 內（目前約 5000 行）
- **部署**：GitHub Pages（HTTPS），已可安裝到手機/平板桌面
- **資料庫**：Firebase Realtime Database（雲端同步）+ localStorage（本機備份）

---

## 技術棧

| 項目 | 內容 |
|------|------|
| 前端 | 純 HTML + CSS + 原生 JavaScript（無框架） |
| 資料庫 | Firebase 9.23.0 Compat SDK（Realtime Database） |
| 字體 | Bebas Neue、Oswald、Noto Sans TC（Google Fonts） |
| 工具 | html2canvas 1.4.1、jsPDF 2.5.1（用於報表輸出） |
| PWA | manifest.json + sw.js（Service Worker） |
| 版控 | Git（需確認 repo 位置） |

---

## 資料結構

```javascript
// 主要資料物件
allData = {
  teams: [
    {
      gameName: '2026 世界盃青棒賽',  // 賽事名稱（用於分組）
      name: '中華台北',               // 我方球隊
      opponent: '日本',               // 對手
      date: '2026-05-10',
      pitchers: [
        {
          name: '王大明',
          number: '21',
          hand: '右投',               // 右投 / 左投
          role: '先發',               // 先發 / 中繼 / 終結
          style: '速球型',
          pitches: [                  // 每球記錄
            {
              type: '快速球',          // 球種
              zone: '5',              // 好球帶 1-9，壞球 B1-B16
              result: '好球',          // 好球 / 壞球
              speed: 132,             // 球速 km/h
              swing: false,
              wild: false,
              foul: false,
              batterHand: '右打',
              batterNumber: 21,
              batterOrder: 3,
              outcomes: ['三振'],      // 打席結果（可為空）
              balls: 2,
              strikes: 1,
              runnersOn: false,
              timestamp: 1234567890
            }
          ],
          score: { home: 2, away: 5, inning: 7, half: '下' }
        }
      ]
    }
  ],
  pitcherDB: {}  // 跨場次同名投手彙整（由 rebuildPitcherDB() 產生）
}

// 當前情蒐槽位
slotA = { team: null, pitcher: null }  // A 槽
slotB = { team: null, pitcher: null }  // B 槽
```

---

## 角色系統

- **情蒐員（Scout）**：可新增/編輯資料，有完整側邊欄操作
- **觀看者（Viewer）**：唯讀模式，只能看統計分析，無法輸入
- 登入邏輯在 `loginTeamCode`（球隊代碼）+ 密碼驗證
- Firebase DB key 格式：`chineseTaipei_{teamCode}`

---

## 主要功能模組

### 1. 側邊欄
- 新增球隊/賽事
- 投手選擇（點擊 tag 分配到 A/B 槽）
- 按賽事名稱分組顯示
- 快速備份/還原/雲端同步

### 2. 雙投手槽位（A/B）
- A 槽：深藍底（中華台北主色）
- B 槽：深灰底（對手用）
- 點擊切換當前情蒐對象
- 切換時自動儲存

### 3. 記錄分頁（recordTab）
- 即時記分板（比分、局數、上下局）
- 壘上狀況（壘包圖示）
- 球數顯示（好壞球燈號）
- 打者資訊（背號、打序、慣用手）
- 5x5 投球落點九宮格（3x3 好球帶 + 周邊壞球區）
- 球種選擇（6種）
- 球速輸入（快捷鍵 + 手動）
- 揮棒/觸身球/暴投 checkbox
- 打席結果記錄
- 確認記錄按鈕

### 4. 統計分頁（stats）
- 投球數、好球率、各球種使用率
- 球速統計（平均/最高/最低）
- 好球帶熱區圖（3x3 格）
- 壞球分佈圖（5x5 格）

### 5. 分析分頁（analysis）
- 投球傾向（領先/落後球數時的選球）
- 壘上狀況分析
- 對陣左右打者差異
- 跨場次同名投手彙整比對

### 6. 對比分頁（compare）
- A vs B 槽投手數據並列比較
- 跨賽事歷史對戰記錄（historyModal）

---

## CSS 設計規範

```css
/* 主色系 */
--ct-blue-dark: #003d79   /* 主背景深藍 */
--ct-blue: #0051a5        /* 側邊欄漸層 */
--ct-red: #dc0000         /* 強調色（border、按鈕） */
--ct-gold: #ffd700        /* 金色（活躍狀態、標題） */
--ct-white: #ffffff
--ct-gray: #f5f5f5
--ct-green: #10b981       /* 壞球顏色 */
--ct-yellow: #fbbf24      /* 記分板數字 */
```

字體優先序：`'Oswald'` 用於標題/數據，`'Noto Sans TC'` 用於中文內容，`'Bebas Neue'` 用於大標題。

---

## 響應式斷點

| 斷點 | 說明 |
|------|------|
| > 1024px | 側邊欄 300px，正常桌面版 |
| ≤ 1024px | 側邊欄縮至 280px |
| ≤ 768px | 側邊欄隱藏，手機模式，大觸控按鈕 |
| ≤ 480px | 小手機，最精簡排版 |

---

## 重要函式（快速索引）

| 函式 | 功能 |
|------|------|
| `init()` | 初始化，載入 localStorage → Firebase |
| `injectDemoData()` | 注入測試資料（⚠️ 上線前要移除！） |
| `saveToFirebase()` | 寫入 Firebase |
| `saveToLocalStorage()` | 備份到 localStorage |
| `updateTeamList()` | 重繪側邊欄球隊列表 |
| `updateSlotDisplay()` | 更新 A/B 槽卡片顯示 |
| `updatePitchLog()` | 更新投球記錄列表 |
| `updateStats()` | 重算並重繪統計 |
| `recordPitch()` | 記錄一球（核心函式） |
| `activateSlot('A'/'B')` | 切換當前情蒐槽位 |
| `rebuildPitcherDB()` | 重建跨場次投手DB |
| `refreshData()` | 從 Firebase 拉取最新資料 |

---

## 已知待優化項目（按優先序）

### 🔴 高優先
- [ ] `injectDemoData()` 在每次 init 都會強制覆蓋真實資料，**上線前必須移除或加條件判斷**
- [ ] 所有 CSS、JS 塞在一個 5000 行的 index.html → 需拆分為獨立檔案
- [ ] 密碼以明文存在前端 → 需改為 Firebase Auth 或後端驗證

### 🟡 中優先
- [ ] 球種可讓使用者自訂（不只固定 6 種）
- [ ] 報表匯出（PDF/截圖）目前尚未完整串接 jsPDF
- [ ] 離線模式：Service Worker 快取策略尚未最佳化
- [ ] 側邊欄在手機橫置時操作不便

### 🟢 低優先（功能擴充）
- [ ] 打者資料庫（目前只記錄打者編號，無歷史彙整）
- [ ] 多使用者即時協作（目前只有單一情蒐員寫入）
- [ ] 圖表匯出為圖片
- [ ] 深色模式

---

## 開發注意事項

1. **不要動 Firebase config**：在 HTML 最上方的 `firebaseConfig` 物件
2. **測試時用 `injectDemoData()`**：真實資料不要放進 commit
3. **改 CSS 時注意**：手機版按鈕最小點擊區要維持 44px 以上（無障礙）
4. **觸控事件**：有些按鈕同時用了 `onclick` 和 `ontouchend`，改動時兩者都要顧到
5. **Firebase 寫入頻率**：`saveToFirebase()` 在每次記球後都會觸發，注意 quota

---

## 檔案結構

```
/
├── index.html      ← 目前所有邏輯都在這（5014 行）
├── manifest.json   ← PWA manifest
├── sw.js           ← Service Worker
└── icons/          ← PWA 圖示（各尺寸）
```

---

## 販售計畫

- 目標：授權給國小到國家隊各層級球隊
- 需求：多球隊獨立帳號、資料隔離、管理員後台（尚未開發）
- 未來架構方向：考慮改為多租戶 SaaS，每隊有獨立 Firebase 路徑

---

*最後更新：2026-05*
