# 棒壘球投手情蒐系統 · CLAUDE.md

> 這個檔案是給 Claude Code 看的專案說明。每次開新 session 都會自動讀取。
> 更新這個檔案 = 幫 Claude 建立長期記憶，省大量 token。

---

## 專案基本資訊

- **專案名稱**：情蒐系統（Chinese Taipei Pitcher Scouting）
- **目標用戶**：國小到國家隊的棒壘球教練、情蒐員、運動選手家長
- **架構**：單頁 PWA，拆分為 `index.html`（HTML 結構）、`style.css`（樣式）、`app.js`（邏輯）
- **部署**：GitHub Pages（HTTPS），已可安裝到手機/平板桌面
- **資料庫**：Firebase Realtime Database（雲端同步）+ localStorage（本機備份）
- **目前版本**：v537（`APP_VERSION` 常數 = `sw.js` 的 `CACHE_NAME`，兩者必須同步）

---

## 技術棧

| 項目 | 內容 |
|------|------|
| 前端 | 純 HTML + CSS + 原生 JavaScript（無框架） |
| 資料庫 | Firebase 9.23.0 Compat SDK（Realtime Database） |
| 字體 | Bebas Neue、Oswald、Noto Sans TC（Google Fonts） |
| 工具 | html2canvas 1.4.1、jsPDF 2.5.1、Chart.js 4.4.4（統計圖表） |
| PWA | manifest.json + sw.js（Service Worker，CACHE_NAME = `pitcher-scout-v{版本號}`） |
| 版控 | Git → GitHub（yungfanchi/pitcher-scout），部署到 GitHub Pages |

---

## 資料結構

```javascript
// 主要資料物件
allData = {
  teams: [
    {
      gameId: 'uuid-xxx',              // Firebase key（唯一，自動產生）
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
              type: '快速球',          // 球種（見球種列表）
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
              runsScored: 0,          // 使用者確認的得分
              finalBases: [f,f,f],    // 使用者確認的壘況
              timestamp: 1234567890
            }
          ],
          score: { home: 2, away: 5, inning: 7, half: '下' }
        }
      ],
      lineups: {
        teamA: Array(10),  // 先攻打線
        teamB: Array(10)   // 後攻打線
      }
    }
  ],
  pitcherDB: {},   // 跨場次同名投手彙整（由 rebuildPitcherDB() 產生）
  batterData: [    // 打者資料庫（獨立節點，與 games 分開存）
    {
      name: '陳大文',
      number: '3',
      hand: '右打',
      team: '中華台北',
      atBats: [
        {
          date: '2026-05-10',
          opponent: '日本',
          pitcherName: '...',
          outcome: '一壘安打',
          direction: '左',
          isBunt: false,
          isRunAndHit: false,
          isPinch: false,
          runnersOn: true
        }
      ]
    }
  ]
}

// 當前情蒐槽位
slotA = { team: null, pitcher: null }  // A 槽
slotB = { team: null, pitcher: null }  // B 槽

// 使用模式
userMode = 'pitcher' | 'batter'  // 登入後選擇，影響整體介面
```

### Firebase 節點結構

```
teams/{teamCode}/
  config/           ← 球隊設定（scoutPw hash、viewPw hash、teamName）
  games/{gameId}    ← 每場比賽資料（per-game write）
  batterData/       ← 打者資料庫（獨立節點）
```

---

## 角色系統

- **情蒐員（Scout）**：可新增/編輯資料，有完整側邊欄操作
- **觀看者（Viewer）**：唯讀模式，只能看統計分析，無法輸入
- **管理員（Admin）**：本地驗證，可建立/管理各球隊帳號
- 登入流程：球隊代碼 + 密碼 → 本地快取驗證（SHA-256）→ Firebase 驗證
- 密碼儲存：SHA-256 雜湊，向下相容舊明文帳號
- 離線登入：首次連線後快取憑證，之後可離線登入

---

## 主要功能模組

### 1. 側邊欄
- 新增球隊/賽事
- 投手選擇（點擊 tag 分配到 A/B 槽）
- 按賽事名稱分組顯示（可展開/收折）
- 快速備份/還原/雲端同步

### 2. 雙投手槽位（A/B）
- A 槽：深藍底（中華台北主色）
- B 槽：深灰底（對手用）
- 點擊切換當前情蒐對象，切換時自動儲存

### 3. 記錄分頁（recordTab）— 投手模式
- 即時記分板（比分、局數、上下局、出局數）
- 壘上狀況（壘包圖示，含跑者身份追蹤）
- 球數顯示（好壞球燈號）
- 打者資訊（背號、打序、慣用手）+ 打線管理
- 5x5 投球落點九宮格（3x3 好球帶 + 周邊壞球區）
- 球種選擇（7 種）：快速球、上飄球、下墜球、變速球、二速球、內曲、外曲
- 球速輸入（快捷鍵按鈕 + 手動輸入）
- 揮棒/觸身球/暴投/捕逸 checkbox
- 打席結果記錄（含壘包確認、得分確認）
- 落球點記錄（安打方向）

### 4. 打者模式（userMode = 'batter'）
- 獨立的打者資料庫（batterData）
- 記錄每打席：結果、打擊方向、戰術（短打/跑打/代打）、壘上狀況
- 打者統計分頁（打擊率、各類型分布、壘上應對）
- 打者情蒐卡（歷史比對）

### 5. 統計分頁（statsTab）
- 投球數、好球率、各球種使用率（圓餅圖）
- 球速統計（平均/最高/最低、折線圖）
- 好球帶熱區圖（3x3）、壞球分佈圖（5x5）
- 支援篩選：全部場次 / 指定場次

### 6. 分析分頁（analysisTab）
- 投球傾向（領先/落後/平球數時的選球）
- 壘上狀況分析
- 對陣左右打者差異
- 配球模式、首球、兩好球分析
- 跨場次同名投手彙整比對

### 7. 對比分頁（compareTab）
- A vs B 槽投手數據並列比較
- 跨賽事歷史對戰記錄（historyModal）

### 8. PDF 報表匯出
- 入口：`exportReportPDF()` → `openPDFFilter()` → `_buildAndOpenReport()`
- 支援篩選：指定投手、全部/指定場次、左/右/全部打者
- 新開視窗顯示 HTML 報表（含統計、熱區、球種分析）
- html2canvas 截圖各分頁後合成 PDF

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
--ct-orange: #f97316
--ct-purple: #7c3aed
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
| `injectDemoData()` | 注入測試資料（console 手動呼叫，勿放進 init） |
| `saveToFirebase(gameIdx?)` | 寫入 Firebase（內建 300ms debounce，gameIdx 可指定單場） |
| `saveToLocalStorage()` | 備份到 localStorage |
| `updateTeamList()` | 重繪側邊欄球隊列表 |
| `updateSlotDisplay()` | 更新 A/B 槽卡片顯示 |
| `updatePitchLog()` | 更新投球記錄列表 |
| `updateStats()` | 重算並重繪統計 |
| `recordPitch()` | 記錄一球（核心函式） |
| `activateSlot('A'/'B')` | 切換當前情蒐槽位 |
| `rebuildPitcherDB()` | 重建跨場次投手DB（全量重算，import 後呼叫） |
| `refreshData()` | 從 Firebase 拉取最新資料 |
| `exportReportPDF()` | 開啟 PDF 報表篩選器 |
| `updateGameStateFromPitch(pitch)` | 根據一球更新比賽狀態（壘包/球數/出局） |
| `applyBaseRunning(bases, outcomes)` | 計算壘包推進與得分（返回 newBases + runsScored） |
| `_renderBmStats()` | 重繪打者統計頁（頂部隊伍頁籤＋單隊全寬表） |
| `removeBatterFromTeam(num, team)` | 從某隊移除誤掛打者（清打者標記，不動投手用球數） |
| `_buildSprayParts(locPitches, oc, opts)` | 落點圖核心：產生一般線/全壘打線/短打線（重疊錯開、越多越深） |
| `_extendToBaseLine(ex, ey)` | 內野球落點線末端延伸到壘線（純幾何） |
| `buildFieldSVG(dots, interactive, cleanFan, hrDots, buntHTML)` | 球場 SVG；靜態模式畫短打區弧帶 |
| `_pdfPickFitWidth(baseW, h0, pages, minW)` | PDF 單頁自動填滿：挑較窄截圖寬度放大字體 |
| `renderBmBatterProfile(pitches, entry, stats)` | 打者個人卡（含落點圖、刪除手動落點按鈕） |
| `_deriveBmAtBatsFromPitches(teamIdx)` | 從投球記錄推導打席（上半=name、下半=opponent 決定隊別） |

---

## 已知待優化項目

### 🟡 中優先
- [ ] 球種可讓使用者自訂（目前固定 7 種）
- [ ] 離線模式：Service Worker 快取策略尚未最佳化
- [ ] 側邊欄在手機橫置時操作不便
- [ ] 投球記錄列表無虛擬捲動（100球+時渲染偏慢）

### 🟢 低優先（功能擴充）
- [ ] 多使用者即時協作（目前只有單一情蒐員寫入）
- [ ] 圖表匯出為圖片
- [ ] 深色模式

### ✅ 已完成
- [x] `injectDemoData()` 已從 `init()` 移除，僅保留供 console 手動呼叫
- [x] CSS/JS 已拆分為獨立檔案
- [x] 密碼改用 SHA-256 雜湊儲存，向下相容舊明文帳號
- [x] Firebase 寫入已有 300ms debounce（`_fbSaveTimer`，app.js ~6140 行）
- [x] PDF 報表匯出已實作（`exportReportPDF` → `_buildAndOpenReport`）
- [x] 打者資料庫已實作（`allData.batterData`，獨立 Firebase 節點）
- [x] APP_VERSION 與 sw.js CACHE_NAME 同步（目前皆為 v537）
- [x] 統計頁打者成績改為「頂部隊伍頁籤 + 單隊全寬檢視」（取代多隊並排手風琴，避免橫滑；`_bmStatsActiveTeam`、`selectBmStatsTeam`）
- [x] 統計頁每位打者可「🗑️ 從此隊移除」（`removeBatterFromTeam`，清空本場該背號投球記錄的打者標記＋移除 bm 打席/手動落點，不動投手用球數）
- [x] 打者個人卡可「🗑️ 刪除手動落點」（`_showDelHitLocInline` / `_delDirectHitLocCard`，只刪 bm.hitLocations 手動落點）
- [x] 落點圖重新設計（靜態圖）：獨立「短打區」弧帶、一般線從短打區外緣出發、內野球末端延伸到壘線、重疊微錯開＋越多越深、短打用方向式短線（`_buildSprayParts`、`_extendToBaseLine`、`SPRAY_*` 常數、`buildFieldSVG` 第 5 參數 buntHTML）
- [x] PDF 單頁區塊「自動填滿」：依比例挑較窄截圖寬度放大字體、減少留白，只縮窄＋contain 不溢出不分頁（`_pdfPickFitWidth`）
- [x] 正在記錄橫幅並排顯示目前打者（`updateRecordBanner`）
- [x] 投球打者自動帶入移除全域打序 fallback（`allData.bm.lineupA/B`），根治「開新場次帶入上一場/別隊打者」（v537，改動 `autoFillBatterFromOrder`、`autoUpdateBatterInfoByInning`）
- [x] 落點/打席刪除鍵改 addEventListener 綁定 + timestamp 字串比對（修正手機按無反應、按確定刪不掉）

---

## 開發注意事項

1. **不要動 Firebase config**：在 `index.html` 最上方的 `firebaseConfig` 物件
2. **版本號同步**：每次更新 `sw.js` 的 `CACHE_NAME`（`pitcher-scout-vNNN`），必須同時更新 `app.js` 第一行的 `APP_VERSION`
3. **測試時用 `injectDemoData()`**：真實資料不要放進 commit
4. **改 CSS 時注意**：手機版按鈕最小點擊區要維持 44px 以上（無障礙）
5. **觸控事件**：有些按鈕同時用了 `onclick` 和 `ontouchend`，改動時兩者都要顧到
6. **Firebase 寫入**：Realtime Database 無每日寫入次數上限，限制是儲存（1GB）與下載流量（10GB/月）。寫入已有 300ms debounce，不需額外處理

---

## 檔案結構

```
/
├── index.html      ← HTML 結構（1,986 行）
├── style.css       ← 所有 CSS 樣式（1,292 行）
├── app.js          ← 所有應用邏輯（12,673 行）
├── manifest.json   ← PWA manifest
├── sw.js           ← Service Worker（CACHE_NAME = pitcher-scout-v537）
├── icon-192.png    ← PWA 圖示
└── icon-512.png    ← PWA 圖示
```

---

## 販售計畫

- 目標：授權給國小到國家隊各層級球隊
- 需求：多球隊獨立帳號、資料隔離、管理員後台（尚未開發）
- 未來架構方向：考慮改為多租戶 SaaS，每隊有獨立 Firebase 路徑

---

*最後更新：2026-06-04*
