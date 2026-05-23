    const APP_VERSION = 'v196';

    // 局數制標準：壘球 7 局、棒球 9 局
    const GAME_INNING_STANDARD = 7;

    // ====== PITCH COLOR PALETTE ======
    const PITCH_ORDER = ['快速球','上飄球','下墜球','變速球','二速球','內曲','外曲'];
    const PITCH_COLORS = {
        '快速球': '#FF2A2A',   // 正烈火紅
        '上飄球': '#2979FF',   // 皇家極致藍
        '下墜球': '#8B4513',   // 剛鐵深棕
        '變速球': '#0284c7',   // 天空藍
        '二速球': '#00E676',   // 螢光炫綠
        '內曲':   '#E040FB',   // 夢幻粉紫
        '外曲':   '#78909C',   // 時尚鋼鐵灰
    };

    // ====== DATA ======
    let allData = { teams: [], pitcherDB: {} }; // pitcherDB: key="姓名#背號", value={pitches:[{...pitch, gameKey}]}
    let currentTeam = null;
    let currentPitcher = null;
    let autoSave = false;
    let expandedTeams = new Set();
    let activeSlot = 'A';
    let slotA = { team: null, pitcher: null };
    let slotB = { team: null, pitcher: null };
    let lastSelectedSlot = 'A'; // 記錄上次記錄投球的 slot，下次自動切換到另一個
    let editingPitchIndex = null;
    let statsFilter = 'all'; // 'all' or a gameKey
    let expandedGames = new Set(); // track which game groups are expanded (pitcher mode)
    let bmExpandedGames = new Set(); // track which game groups are expanded (batter mode)
    let userMode = 'pitcher'; // 'pitcher' | 'batter'

    // ====== MULTI-TENANT AUTH ======
    let userSession = null;      // Firebase Auth user object
    let USER_TEAM_REF = null;    // db.ref('teams/{teamCode}') — locked after auth

    // Game state
    let gameState = {
        strikes: 0, balls: 0, outs: 0,
        bases: [false, false, false], // 1B, 2B, 3B
        runners: [null, null, null],  // 跑者身份 { number, order, name } | null
        half: '上', inning: 1,
        lineups: {
            teamA: Array.from({length: 10}, () => ({ number: '', name: '', hand: '右打' })),
            teamB: Array.from({length: 10}, () => ({ number: '', name: '', hand: '右打' }))
        },
        currentBatterIndex: { teamA: 0, teamB: 0 }
    };

    function getDefaultScore() {
        return { home: 0, away: 0, inning: 1, half: '上' };
    }

    // ====== PITCHER DB HELPERS ======
    function getPitcherKey(name, number) {
        const n = (name || '').trim() || '未命名';
        const num = (number !== null && number !== undefined) ? String(number).trim() : '';
        return `${n}#${num}`;
    }

    function getGameKey(teamIndex) {
        const t = allData.teams[teamIndex];
        return `${t.gameName || ''}|${t.date || ''}|${t.name}vs${t.opponent || ''}`;
    }

    function syncPitchToDB(pitch, teamIndex, pitcherName, pitcherNumber) {
        if (!allData.pitcherDB) allData.pitcherDB = {};
        const key = getPitcherKey(pitcherName, pitcherNumber);
        if (!allData.pitcherDB[key]) {
            allData.pitcherDB[key] = { name: pitcherName, number: pitcherNumber, pitches: [] };
        }
        // Add gameKey to pitch for filtering
        const pitchWithGame = { ...pitch, gameKey: getGameKey(teamIndex) };
        allData.pitcherDB[key].pitches.push(pitchWithGame);
    }

    function rebuildPitcherDB() {
        // Rebuild full DB from all team pitchers (for import/data repair)
        allData.pitcherDB = {};
        allData.teams.forEach((team, teamIndex) => {
            team.pitchers.forEach(pitcher => {
                const key = getPitcherKey(pitcher.name, pitcher.number);
                if (!allData.pitcherDB[key]) {
                    allData.pitcherDB[key] = { name: pitcher.name, number: pitcher.number, pitches: [] };
                }
                pitcher.pitches.forEach(pitch => {
                    allData.pitcherDB[key].pitches.push({ ...pitch, gameKey: getGameKey(teamIndex) });
                });
            });
        });
    }

    function getFilteredPitches(teamIndex, pitcherIndex) {
        const pitcher = allData.teams[teamIndex].pitchers[pitcherIndex];
        const key = getPitcherKey(pitcher.name, pitcher.number);

        if (statsFilter === 'all') {
            // Collect all pitches from all teams for same pitcher (name+number)
            let merged = [];
            allData.teams.forEach((team, ti) => {
                team.pitchers.forEach(p => {
                    if (getPitcherKey(p.name, p.number) === key) {
                        const gk = getGameKey(ti);
                        p.pitches.forEach(pitch => merged.push({...pitch, gameKey: gk}));
                    }
                });
            });
            return merged.length > 0 ? merged : pitcher.pitches;
        }

        // Filter by specific game
        let result = [];
        allData.teams.forEach((team, ti) => {
            if (getGameKey(ti) === statsFilter) {
                team.pitchers.forEach(p => {
                    if (getPitcherKey(p.name, p.number) === key) {
                        result = result.concat(p.pitches);
                    }
                });
            }
        });
        return result;
    }

    function getAvailableGames(teamIndex, pitcherIndex) {
        const pitcher = allData.teams[teamIndex].pitchers[pitcherIndex];
        const key = getPitcherKey(pitcher.name, pitcher.number);
        const games = new Map();
        allData.teams.forEach((team, ti) => {
            team.pitchers.forEach(p => {
                if (getPitcherKey(p.name, p.number) === key && p.pitches.length > 0) {
                    const gk = getGameKey(ti);
                    const label = [team.gameName, team.date, `${team.name}vs${team.opponent||''}`].filter(Boolean).join(' · ');
                    games.set(gk, label);
                }
            });
        });
        return [...games.entries()]; // [[gameKey, label], ...]
    }

    let currentPitch = {
        type: null, zone: null, speed: null, result: null,
        batterHand: null, batterNumber: null, batterOrder: null,
        outcomes: [], wild: false, foul: false, swing: false, passball: false, pinchHit: false
    };

    // ====== INIT ======
    // ====== 密碼設定（可自行修改）======
    const ADMIN_CODE = 'blue82031552'; // 管理員代碼（你專用）
    let ADMIN_PW_HASH = null;
    _sha256('foba1224').then(h => { ADMIN_PW_HASH = h; });
    let userRole = null; // 'scout' | 'view' | 'admin'
    let currentTeamCode = null; // 當前球隊代碼
    let selectedLoginRole = 'scout';
    let fieldMapEnabled = localStorage.getItem('fieldMapEnabled') === '1';

    function selectRole(role) {
        selectedLoginRole = role;
        document.getElementById('roleScout').classList.toggle('selected', role === 'scout');
        document.getElementById('roleView').classList.toggle('selected', role === 'view');
        const pwLabel = document.getElementById('pwLabel');
        if (pwLabel) pwLabel.textContent = role === 'scout' ? '情蒐員密碼' : '觀看密碼';
        document.getElementById('pwGroup').style.display = 'block'; // 兩種角色都需要密碼
        document.getElementById('loginError').textContent = '';
    }

    // 登入成功後顯示模式選擇頁（兩台平板可分別選投手 / 打者模式）
    function showModeSelectionAfterLogin(role) {
        userRole = role;
        const ls = document.getElementById('loginScreen'); if (ls) ls.style.display = 'none';
        const ao = document.getElementById('authOverlay'); if (ao) ao.style.display = 'none';
        const mss = document.getElementById('modeSelectScreen'); if (mss) mss.style.display = 'none';
        const msp = document.getElementById('modeSelectionPage');
        if (msp) {
            msp.style.display = 'flex';
            const info = document.getElementById('modeSelectionUserInfo');
            if (info) info.textContent = `${currentTeamCode || ''}　｜　${role === 'view' ? '觀看者' : '情蒐員'}`;
        } else {
            // fallback：找不到模式選擇頁時直接進系統
            enterSystem(role);
        }
    }

    async function doLogin() {
        try { document.activeElement && document.activeElement.blur(); } catch(e) {}
        const teamCodeEl = document.getElementById('loginTeamCode');
        const teamCode = teamCodeEl ? teamCodeEl.value.trim() : '';
        const pw = document.getElementById('loginPw').value.trim();

        if (!teamCode) { document.getElementById('loginError').textContent = '❌ 請輸入球隊代碼'; return; }
        if (!pw) { document.getElementById('loginError').textContent = '❌ 請輸入密碼'; return; }

        // 管理員登入（本地驗證，不需網路）
        if (teamCode === ADMIN_CODE) {
            const inputHash = await _sha256(pw);
            if (inputHash === ADMIN_PW_HASH) {
                currentTeamCode = 'ADMIN';
                await _cacheCredential(teamCode, 'scout', pw);
                showModeSelectionAfterLogin('scout');
                return;
            }
        }

        // 先嘗試本地快取驗證（離線可用）
        if (await _checkCachedCredential(teamCode, selectedLoginRole, pw)) {
            currentTeamCode = teamCode;
            try { localStorage.setItem('lastTeamCode', teamCode); } catch(e) {}
            showModeSelectionAfterLogin(selectedLoginRole);
            return;
        }

        // 無快取，需要網路查 Firebase
        if (!navigator.onLine) {
            document.getElementById('loginError').textContent = '❌ 離線中，請先有網路登入一次以啟用離線功能';
            return;
        }

        document.getElementById('loginError').textContent = '🔄 驗證中...';

        try {
            db.ref(`teams/${teamCode}/config`).once('value').then(async snap => {
                const config = snap.val();
                if (!config) {
                    document.getElementById('loginError').textContent = '❌ 球隊代碼不存在，請確認後再試';
                    return;
                }
                const stored = selectedLoginRole === 'scout' ? config.scoutPw : config.viewPw;
                // 相容舊明文密碼（尚未升級的帳號）與新 SHA-256 雜湊
                const inputHash = await _sha256(pw);
                const matches = _isHashed(stored) ? inputHash === stored : pw === stored;
                if (matches) {
                    currentTeamCode = teamCode;
                    await _cacheCredential(teamCode, selectedLoginRole, pw); // 快取供離線使用
                    try { localStorage.setItem('lastTeamCode', teamCode); } catch(e) {}
                    showModeSelectionAfterLogin(selectedLoginRole);
                } else {
                    document.getElementById('loginError').textContent = '❌ 密碼錯誤，請再試一次';
                    document.getElementById('loginPw').value = '';
                    document.getElementById('loginPw').focus();
                }
            }).catch(async e => {
                // Firebase 失敗再試快取
                if (await _checkCachedCredential(teamCode, selectedLoginRole, pw)) {
                    currentTeamCode = teamCode;
                    try { localStorage.setItem('lastTeamCode', teamCode); } catch(e2) {}
                    showModeSelectionAfterLogin(selectedLoginRole);
                } else {
                    document.getElementById('loginError').textContent = '❌ 連線失敗，且無離線快取';
                }
            });
        } catch(e) {
            document.getElementById('loginError').textContent = '❌ Firebase 未連線';
        }
    }

    // 密碼雜湊（SHA-256，Web Crypto API）
    async function _sha256(str) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function _isHashed(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }

    async function _cacheCredential(teamCode, role, pw) {
        try {
            const h = await _sha256(teamCode + pw + role);
            localStorage.setItem(`_cred_${teamCode}_${role}`, h);
        } catch(e) {}
    }
    async function _checkCachedCredential(teamCode, role, pw) {
        try {
            const cached = localStorage.getItem(`_cred_${teamCode}_${role}`);
            if (!cached) return false;
            if (_isHashed(cached)) {
                const h = await _sha256(teamCode + pw + role);
                return cached === h;
            }
            // 舊格式快取（升級前的弱 hash），清除後要求重新登入
            localStorage.removeItem(`_cred_${teamCode}_${role}`);
            return false;
        } catch(e) { return false; }
    }

    async function createTeam() {
        // 管理員建立新球隊
        const code = prompt('輸入新球隊代碼（英數字大寫，例：CTU001）：');
        if (!code) return;
        const teamCode = code.trim().toUpperCase();
        if (!/^[A-Z0-9]{3,10}$/.test(teamCode)) { alert('代碼需為 3-10 個英數字'); return; }
        const scoutPw = prompt(`設定「${teamCode}」的情蒐員密碼：`);
        if (!scoutPw || scoutPw.length < 4) { alert('密碼至少 4 個字元'); return; }
        const viewPw = prompt(`設定「${teamCode}」的觀看者密碼：`);
        if (!viewPw || viewPw.length < 4) { alert('密碼至少 4 個字元'); return; }
        const teamName = prompt(`設定「${teamCode}」的登入頁大字隊名\n（例：CHINESE TAIPEI，留空=系統預設）：`) || '';
        const teamSub  = prompt(`設定「${teamCode}」的登入頁小字副標\n（例：棒球投手情蒐系統，留空=系統預設）：`) || '';
        const [scoutHash, viewHash] = await Promise.all([_sha256(scoutPw), _sha256(viewPw)]);
        // 清除舊資料，確保新帳號乾淨
        await db.ref(`teams/${teamCode}/data`).remove().catch(() => {});
        await db.ref(`teams/${teamCode}/pitchers`).remove().catch(() => {});
        const configPayload = { scoutPw: scoutHash, viewPw: viewHash, createdAt: Date.now() };
        if (teamName.trim()) configPayload.teamName = teamName.trim();
        if (teamSub.trim())  configPayload.teamSub  = teamSub.trim();
        db.ref(`teams/${teamCode}/config`).set(configPayload)
            .then(() => alert(`✅ 球隊 ${teamCode} 建立成功！\n情蒐員密碼：${scoutPw}\n觀看密碼：${viewPw}${teamName ? '\n隊名：' + teamName : ''}`))
            .catch(e => alert('❌ 建立失敗：' + e.message));
    }

    function showModeSelect(show) {
        const ms = document.getElementById('modeSelectScreen');
        const ls = document.getElementById('loginScreen');
        if (show) {
            ls.style.display = 'none';
            ms.style.display = 'flex';
        } else {
            ms.style.display = 'none';
            ls.style.display = 'flex';
        }
    }

    function checkForUpdate(regParam) {
        if (!('serviceWorker' in navigator)) return;

        // 新 SW 就緒後：顯示 Modal 讓使用者選擇立刻更新或稍後
        const applyUpdate = (reg) => {
            const waiting = reg && reg.waiting;
            if (!waiting) return;

            const _showUpdateModal = (newVer) => {
                const curEl = document.getElementById('umCurrentVer');
                const newEl = document.getElementById('umNewVer');
                if (curEl) curEl.textContent = APP_VERSION;
                if (newEl) newEl.textContent = newVer;
                document.getElementById('updateModal').style.display = 'flex';
                // 通知 Firebase 讓其他裝置也收到提醒
                notifyUpdateToAllDevices(newVer);
                // 若 App 在背景，送瀏覽器通知
                sendPushNotification(newVer);
            };

            if ('caches' in window) {
                caches.keys().then(keys => {
                    const swCaches = keys.filter(k => k.startsWith('pitcher-scout-v'));
                    const currentKey = 'pitcher-scout-' + APP_VERSION;
                    const newKey = swCaches.find(k => k !== currentKey);
                    const newVer = newKey ? newKey.replace('pitcher-scout-', '') : '新版本';
                    _showUpdateModal(newVer);
                }).catch(() => _showUpdateModal('新版本'));
            } else {
                _showUpdateModal('新版本');
            }
        };

        const setup = (reg) => {
            if (!reg) return;

            // 頁面載入時若已有等待的新版本，直接套用
            if (reg.waiting) { applyUpdate(reg); return; }

            // 偵測到新版本安裝完成，自動套用
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                if (!nw) return;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                        applyUpdate(reg);
                    }
                });
            });

            // 切回 App / 視窗取得焦點時重新檢查
            const checkUpdate = () => {
                if (navigator.onLine) reg.update().catch(() => {});
            };
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkUpdate();
            });
            window.addEventListener('focus', checkUpdate);

            // 每 10 分鐘定期檢查
            setInterval(checkUpdate, 10 * 60 * 1000);
        };

        if (regParam) { setup(regParam); }
        else { navigator.serviceWorker.getRegistration().then(setup); }
    }

    function doForceUpdate() {
        // 離線狀態下不重新整理，避免白畫面
        if (!navigator.onLine) {
            document.getElementById('updateModal').style.display = 'none';
            alert('目前離線中，資料不受影響。\n待下次連線開啟 App 時會自動套用新版本。');
            return;
        }
        document.getElementById('updateModal').style.display = 'none';
        // 重整前儲存 session，重整後自動還原（不需重新登入、不跳資料）
        try {
            sessionStorage.setItem('_updateRestore', JSON.stringify({
                teamCode: currentTeamCode,
                role: userRole,
                mode: userMode,
                slotA: slotA,
                slotB: slotB,
                currentTeam: currentTeam,
                currentPitcher: currentPitcher,
                activeSlot: activeSlot,
                ts: Date.now()
            }));
        } catch(e) {}
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration().then(reg => {
                if (reg && reg.waiting) {
                    // SKIP_WAITING → controllerchange → reload
                    // 備援倒數：若 controllerchange 3 秒內未觸發（電腦端偶發），強制 reload
                    const fallback = setTimeout(() => window.location.reload(), 3000);
                    navigator.serviceWorker.addEventListener('controllerchange', () => {
                        clearTimeout(fallback);
                        window.location.reload();
                    }, { once: true });
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                } else {
                    window.location.reload();
                }
            }).catch(() => window.location.reload());
        } else {
            window.location.reload();
        }
    }

    // ====== 跨裝置更新通知 ======
    function notifyUpdateToAllDevices(newVer) {
        try {
            db.ref('system/appUpdate').set({
                version: newVer,
                fromVersion: APP_VERSION,
                timestamp: Date.now()
            });
        } catch(e) {}
    }

    function listenForUpdateNotifications() {
        try {
            db.ref('system/appUpdate').on('value', snap => {
                const data = snap.val();
                if (!data || !data.version) return;
                const newVerNum = parseInt(data.version.replace('v','')) || 0;
                const myVerNum  = parseInt(APP_VERSION.replace('v','')) || 0;
                if (newVerNum <= myVerNum) return;
                // 若 updateModal 已開啟則不重複顯示
                const modal = document.getElementById('updateModal');
                if (modal && modal.style.display === 'flex') return;
                const curEl = document.getElementById('umCurrentVer');
                const newEl = document.getElementById('umNewVer');
                if (curEl) curEl.textContent = APP_VERSION;
                if (newEl) newEl.textContent = data.version;
                if (modal) modal.style.display = 'flex';
                sendPushNotification(data.version);
            });
        } catch(e) {}
    }

    function sendPushNotification(newVer) {
        if (!('Notification' in window)) return;
        const doNotify = () => {
            try {
                new Notification('情蒐系統有新版本 🆕', {
                    body: `${APP_VERSION} → ${newVer}，請點擊 App 更新`,
                    icon: './icon-192.png',
                    badge: './icon-192.png',
                    tag: 'app-update'
                });
            } catch(e) {}
        };
        if (Notification.permission === 'granted') { doNotify(); }
        else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => { if (p === 'granted') doNotify(); });
        }
    }

    // ====== 截圖 PDF 共用助手 ======
    // tabIds: 要截圖的分頁 id 陣列，預設全部三頁
    async function _captureAndBuildPDF(filename, tabIds = ['statsTab', 'analysisTab', 'compareTab']) {
        if (typeof html2canvas === 'undefined') { alert('截圖套件未載入，請重新整理頁面'); return; }
        const JSPDF = window.jspdf?.jsPDF || window.jsPDF;
        if (!JSPDF) { alert('PDF 套件未載入，請重新整理頁面'); return; }

        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(0,30,80,0.92);color:white;padding:10px 16px;border-radius:8px;z-index:99999;font-size:13px;font-family:"Noto Sans TC",sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        toast.innerHTML = '📄 正在產生 PDF... <span id="_pdfToastProg" style="color:#ffd700;margin-left:6px;">準備中</span>';
        document.body.appendChild(toast);
        const setProg = (msg) => {
            const el = document.getElementById('_pdfToastProg');
            if (el) el.textContent = msg;
        };

        // A4 寬度基準（mm），頁高依內容決定
        const pageW = 210;

        const allTabs = [
            { id: 'statsTab',    label: '統計', upd: () => updateStats() },
            { id: 'analysisTab', label: '分析', upd: () => updateStats() },
            { id: 'compareTab',  label: '對比', upd: () => updateCompare() },
        ];
        const tabs = allTabs.filter(t => tabIds.includes(t.id));

        // 先截所有 tab 的 canvas，再一次組 PDF（避免頁面切到一半）
        const captures = [];
        for (let ti = 0; ti < tabs.length; ti++) {
            const tab = tabs[ti];
            setProg(`截圖 ${tab.label} (${ti+1}/${tabs.length})`);

            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            const tabEl = document.getElementById(tab.id);
            if (!tabEl) continue;
            tabEl.classList.add('active');
            tab.upd();

            // 等 Chart.js 渲染完成
            await new Promise(r => setTimeout(r, 1600));

            // 展開元素讓 scrollHeight 反映完整高度
            tabEl.style.setProperty('height', 'auto', 'important');
            tabEl.style.setProperty('overflow', 'visible', 'important');
            tabEl.style.setProperty('max-height', 'none', 'important');

            const REPORT_W = 900;
            const captureH = tabEl.scrollHeight;

            const canvas = await html2canvas(tabEl, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#f8f9fa',
                scrollX: 0,
                scrollY: 0,
                width: REPORT_W,
                height: captureH,
                windowWidth: REPORT_W,
                windowHeight: captureH + 200,
                logging: false,
                imageTimeout: 15000,
                onclone: (_doc, clonedEl) => {
                    clonedEl.style.setProperty('width', REPORT_W + 'px', 'important');
                    clonedEl.style.setProperty('max-width', 'none', 'important');
                    clonedEl.style.setProperty('height', 'auto', 'important');
                    clonedEl.style.setProperty('overflow', 'visible', 'important');
                    clonedEl.style.setProperty('max-height', 'none', 'important');
                    const clonedMain = _doc.querySelector('.main-content');
                    if (clonedMain) {
                        clonedMain.style.setProperty('width', REPORT_W + 'px', 'important');
                        clonedMain.style.setProperty('max-width', 'none', 'important');
                        clonedMain.style.setProperty('overflow', 'visible', 'important');
                        clonedMain.style.setProperty('height', 'auto', 'important');
                    }
                    const filterRow = _doc.getElementById('statsHeaderRow');
                    if (filterRow) filterRow.style.setProperty('display', 'none', 'important');
                }
            });

            tabEl.style.removeProperty('height');
            tabEl.style.removeProperty('overflow');
            tabEl.style.removeProperty('max-height');

            // 計算此 tab 在 A4 寬度下的實際高度（mm）
            const pxPerMm = canvas.width / pageW;
            const imgHeightMm = canvas.height / pxPerMm;
            captures.push({ canvas, imgHeightMm });

            await new Promise(r => setTimeout(r, 150));
        }

        if (!captures.length) { toast.remove(); return; }

        // 第一頁：以第一個 tab 內容高度建立 PDF
        setProg('組合 PDF...');
        const pdf = new JSPDF({ orientation: 'portrait', unit: 'mm', format: [pageW, captures[0].imgHeightMm] });
        captures[0].canvas && pdf.addImage(
            captures[0].canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, pageW, captures[0].imgHeightMm
        );

        // 後續頁：每頁尺寸符合該 tab 內容高度
        for (let i = 1; i < captures.length; i++) {
            pdf.addPage([pageW, captures[i].imgHeightMm]);
            pdf.addImage(
                captures[i].canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, pageW, captures[i].imgHeightMm
            );
        }

        setProg('儲存中...');
        await new Promise(r => setTimeout(r, 200));
        pdf.save(filename);
        toast.remove();
    }

    // ====== 截圖 PDF（無 Modal，直接使用當前畫面）======
    async function generateScreenshotPDF() {
        const _sd = activeSlot === 'A' ? slotA : slotB;
        const _p = (_sd.team !== null && _sd.pitcher !== null) ? allData.teams[_sd.team]?.pitchers[_sd.pitcher] : null;
        const pitcherLabel = _p?.name || '投手報告';

        const origTabEl = document.querySelector('.tab-content.active');
        const origTabId = origTabEl?.id || 'recordTab';

        try {
            const fname = `投手報告_${pitcherLabel}_${new Date().toISOString().split('T')[0]}.pdf`;
            await _captureAndBuildPDF(fname);
        } catch (err) {
            console.error('[截圖PDF]', err);
            alert('PDF 產生失敗：' + err.message);
        } finally {
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(origTabId)?.classList.add('active');
            document.querySelector('[id^="_pdfToast"]')?.parentElement?.remove();
        }
    }

    // ====== PDF EXPORT MODAL ======

    function openPDFFilter() {
        // 建立投手名單：name -> { number, games:[{ti, label}] }
        const pitcherMap = {};
        allData.teams.forEach((team, ti) => {
            (team.pitchers || []).forEach(p => {
                if (!p.name) return;
                if (!pitcherMap[p.name]) pitcherMap[p.name] = { number: p.number, games: [] };
                const label = [team.date, team.gameName, team.opponent ? 'vs ' + team.opponent : ''].filter(Boolean).join(' ');
                pitcherMap[p.name].games.push({ ti, label });
            });
        });

        const sel = document.getElementById('pdfPitcherSelect');
        sel.innerHTML = '<option value="">— 請選擇投手 —</option>';
        Object.entries(pitcherMap).forEach(([name, info]) => {
            const gameCount = info.games.length;
            sel.innerHTML += `<option value="${name}">${name}${info.number ? ' #' + info.number : ''} (${gameCount} 場)</option>`;
        });

        // 自動帶入當前情蒐投手
        const activeS = activeSlot === 'A' ? slotA : slotB;
        const activePitcher = (activeS.team !== null && activeS.pitcher !== null)
            ? allData.teams[activeS.team]?.pitchers[activeS.pitcher] : null;
        const autoSelected = activePitcher?.name && pitcherMap[activePitcher.name];
        if (autoSelected) sel.value = activePitcher.name;

        // 重置 UI 狀態
        document.getElementById('pdfScopeSection').style.display = 'none';
        document.getElementById('pdfGameSelectWrap').style.display = 'none';
        document.getElementById('pdfGenerateBtn').style.display = 'none';
        const allRadio = document.querySelector('input[name="pdfScope"][value="all"]');
        if (allRadio) allRadio.checked = true;

        const allHandRadio = document.querySelector('input[name="pdfHand"][value="all"]');
        if (allHandRadio) allHandRadio.checked = true;
        const handSec = document.getElementById('pdfHandSection');
        if (handSec) handSec.style.display = 'none';

        document.getElementById('pdfFilterModal').style.display = 'flex';

        // 若自動帶入投手，觸發選單連動讓 Step 2 顯示
        if (autoSelected) onPDFPitcherChange();
    }

    function closePDFFilter() {
        document.getElementById('pdfFilterModal').style.display = 'none';
    }

    // 當投手選單改變時：顯示 Step 2
    function onPDFPitcherChange() {
        const name = document.getElementById('pdfPitcherSelect').value;
        const scopeSection = document.getElementById('pdfScopeSection');
        const generateBtn = document.getElementById('pdfGenerateBtn');

        if (!name) {
            scopeSection.style.display = 'none';
            generateBtn.style.display = 'none';
            const handSection = document.getElementById('pdfHandSection');
            if (handSection) handSection.style.display = 'none';
            return;
        }

        // 重置 scope
        const allRadio = document.querySelector('input[name="pdfScope"][value="all"]');
        if (allRadio) allRadio.checked = true;
        document.getElementById('pdfGameSelectWrap').style.display = 'none';

        // 動態填入該投手的場次選單
        _populatePDFGameSelect(name);

        scopeSection.style.display = 'block';
        generateBtn.style.display = 'block';
        const handSection2 = document.getElementById('pdfHandSection');
        if (handSection2) handSection2.style.display = 'block';
    }

    // 填入場次下拉選單（只列出該投手有參與的場次）
    function _populatePDFGameSelect(pitcherName) {
        const gameSel = document.getElementById('pdfGameSelect');
        gameSel.innerHTML = '<option value="">— 請選擇場次 —</option>';
        allData.teams.forEach((team, ti) => {
            const hasPitcher = (team.pitchers || []).some(p => p.name === pitcherName);
            if (!hasPitcher) return;
            const label = [
                team.date || '',
                team.gameName || '未命名賽事',
                team.opponent ? 'vs ' + team.opponent : ''
            ].filter(Boolean).join('  ');
            gameSel.innerHTML += `<option value="${ti}">${label}</option>`;
        });
    }

    // Radio 切換：「單一場次」時顯示場次選單
    function onPDFScopeChange() {
        const scope = document.querySelector('input[name="pdfScope"]:checked');
        const isSingle = scope && scope.value === 'single';
        document.getElementById('pdfGameSelectWrap').style.display = isSingle ? 'block' : 'none';
    }

    // 點擊「產生 PDF」按鈕 — 走截圖流程
    async function generatePDF() {
        const pitcherName = document.getElementById('pdfPitcherSelect').value;
        const scopeEl = document.querySelector('input[name="pdfScope"]:checked');
        const scope = scopeEl ? scopeEl.value : 'all';
        const gameIndex = scope === 'single' ? document.getElementById('pdfGameSelect').value : 'all';
        const handEl = document.querySelector('input[name="pdfHand"]:checked');
        const handFilter = handEl ? handEl.value : 'all';

        if (!pitcherName) { alert('請選擇投手'); return; }
        if (scope === 'single' && !gameIndex) { alert('請選擇場次'); return; }

        // 1. 收集該投手符合條件的所有球
        let refPitcher = null;
        const aggregated = [];
        allData.teams.forEach((team, ti) => {
            if (gameIndex !== 'all' && String(ti) !== String(gameIndex)) return;
            (team.pitchers || []).forEach(p => {
                if (p.name !== pitcherName) return;
                if (!refPitcher) refPitcher = p;
                (p.pitches || []).forEach(pitch => aggregated.push(pitch));
            });
        });
        const filtered = handFilter === 'left' ? aggregated.filter(p => p.batterHand === '左打') :
                         handFilter === 'right' ? aggregated.filter(p => p.batterHand === '右打') :
                         aggregated;
        if (!filtered.length) { alert('所選條件無投球數據'); return; }

        closePDFFilter();

        // 2. 建立合成投手放到 allData.teams
        const handSuffix = handFilter === 'left' ? ' (對左打)' : handFilter === 'right' ? ' (對右打)' : '';
        const syntheticTeam = {
            gameName: '📄 PDF 報告',
            name: refPitcher?.name || pitcherName,
            opponent: handSuffix.trim() || '全部打者',
            date: new Date().toISOString().split('T')[0],
            pitchers: [{
                name: pitcherName + handSuffix,
                number: refPitcher?.number || '',
                hand: refPitcher?.hand || '',
                role: refPitcher?.role || '',
                style: refPitcher?.style || '',
                pitches: filtered,
                score: { home:0, away:0, inning:1, half:'上' }
            }]
        };

        // 3. 保存狀態
        const origSlotA = { ...slotA };
        const origSlotB = { ...slotB };
        const origActive = activeSlot;
        const origCurrentTeam = currentTeam;
        const origCurrentPitcher = currentPitcher;
        const origTabEl = document.querySelector('.tab-content.active');
        const origTabId = origTabEl?.id || 'recordTab';

        const tempIndex = allData.teams.length;
        allData.teams.push(syntheticTeam);

        // 4. 設定 slotA + currentTeam/currentPitcher 指向合成投手
        slotA = { team: tempIndex, pitcher: 0 };
        activeSlot = 'A';
        currentTeam = tempIndex;
        currentPitcher = 0;
        if (typeof updateSlotDisplay === 'function') updateSlotDisplay();

        const fileBase = `投手報告_${pitcherName}${handSuffix}_${new Date().toISOString().split('T')[0]}.pdf`;

        try {
            await _captureAndBuildPDF(fileBase, ['statsTab', 'analysisTab']);
        } catch (e) {
            console.error('[PDF]', e);
            alert('PDF 產生失敗：' + e.message);
        } finally {
            // 5. 清理：移除合成投手，還原狀態
            allData.teams.splice(tempIndex, 1);
            slotA = origSlotA;
            slotB = origSlotB;
            activeSlot = origActive;
            currentTeam = origCurrentTeam;
            currentPitcher = origCurrentPitcher;
            if (typeof updateSlotDisplay === 'function') updateSlotDisplay();
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(origTabId)?.classList.add('active');
            if (origTabId === 'statsTab' || origTabId === 'analysisTab') updateStats();
            else if (origTabId === 'compareTab') updateCompare();
        }
    }

    // ===== 核心過濾函式（PDF 實體導出預留殼） =====
    // pitcherName: 投手姓名字串
    // gameId: 'all' | teamIndex 字串（對應 allData.teams 索引）
    function exportToPDF(pitcherName, gameId, handFilter = 'all') {
        const sections = [];

        allData.teams.forEach((team, ti) => {
            if (gameId !== 'all' && String(ti) !== String(gameId)) return;
            (team.pitchers || []).forEach(pitcher => {
                if (pitcher.name !== pitcherName) return;
                const pitches = pitcher.pitches || [];
                if (!pitches.length) return;

                const filteredPitches = handFilter === 'left' ? pitches.filter(p => p.batterHand === '左打') :
                                        handFilter === 'right' ? pitches.filter(p => p.batterHand === '右打') :
                                        pitches;
                if (!filteredPitches.length) return;

                // 計算摘要統計
                const total = filteredPitches.length;
                const strikes = filteredPitches.filter(p => p.result === '好球').length;
                const speeds = filteredPitches.filter(p => p.speed).map(p => p.speed);
                const avgSpd = speeds.length ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : '--';
                const maxSpd = speeds.length ? Math.max(...speeds) : '--';
                const ks = filteredPitches.filter(p => (p.outcomes || []).some(o => o === '三振' || o === '不死三振')).length;
                const walks = filteredPitches.filter(p => (p.outcomes || []).some(o => o === '保送' || o === '觸身球')).length;
                const typeMap = {};
                filteredPitches.forEach(p => { if (p.type) typeMap[p.type] = (typeMap[p.type] || 0) + 1; });
                const topTypes = Object.entries(typeMap).sort((a, b) => b[1] - a[1]);

                sections.push({ team, pitcher, pitches: filteredPitches, total, strikes, avgSpd, maxSpd, ks, walks, topTypes });
            });
        });

        // 預留殼：console 呈現過濾結果，PDF 實體導出待接套件
        console.log(`[exportToPDF] 投手: ${pitcherName} | 場次: ${gameId === 'all' ? '全部場次' : '第 ' + gameId + ' 場'} | 打者篩選: ${handFilter}`);
        console.log('[exportToPDF] 過濾結果 sections:', sections);

        if (!sections.length) { alert('所選條件無投球數據'); return; }

        closePDFFilter();
        _buildAndOpenReport(sections, pitcherName, gameId, handFilter);
    }

    // ===== 統計計算輔助（供 PDF 報告使用）=====
    function _calcPitcherStats(pitches) {
        const total = pitches.length;
        if (!total) return null;
        const oc = (p) => p.outcomes && p.outcomes.length ? p.outcomes : (p.outcome ? [p.outcome] : []);
        const strikes = pitches.filter(p => p.result === '好球').length;
        const swings  = pitches.filter(p => p.swing).length;
        const wilds   = pitches.filter(p => p.wild).length;
        const speeds  = pitches.filter(p => p.speed).map(p => p.speed);
        const avgSpd  = speeds.length ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : '--';
        const maxSpd  = speeds.length ? Math.max(...speeds) : '--';
        const minSpd  = speeds.length ? Math.min(...speeds) : '--';
        const ks      = pitches.filter(p => oc(p).some(o=>o==='三振'||o==='不死三振')).length;
        const walks   = pitches.filter(p => oc(p).some(o=>o==='保送'||o==='觸身球')).length;
        const hits    = pitches.filter(p => oc(p).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
        const hrs     = pitches.filter(p => oc(p).some(o=>o==='全壘打')).length;
        // Ball type breakdown
        const typeMap = {};
        pitches.forEach(p => {
            if (!p.type) return;
            if (!typeMap[p.type]) typeMap[p.type] = { n:0, k:0, spd:[] };
            typeMap[p.type].n++;
            if (p.result==='好球') typeMap[p.type].k++;
            if (p.speed) typeMap[p.type].spd.push(p.speed);
        });
        const typeSorted = Object.entries(typeMap).sort((a,b)=>b[1].n-a[1].n);
        // Zone 1-9 count
        const zoneMap = {1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0};
        pitches.forEach(p => { const z=parseInt(p.zone); if(z>=1&&z<=9) zoneMap[z]++; });
        const zoneMax = Math.max(...Object.values(zoneMap), 1);
        // L/R split
        const side = (sp) => {
            const t=sp.length, s=sp.filter(p=>p.result==='好球').length;
            const h=sp.filter(p=>oc(p).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
            const ab=sp.filter(p=>oc(p).some(o=>o&&(o.includes('安打')||o==='全壘打'||o.includes('出局')||o==='三振'))).length;
            const k=sp.filter(p=>oc(p).some(o=>o==='三振'||o==='不死三振')).length;
            const bb=sp.filter(p=>oc(p).some(o=>o==='保送'||o==='觸身球')).length;
            return { t, sr:t?((s/t)*100).toFixed(1):'0', h, avg:ab?(h/ab).toFixed(3):'.000', k, bb };
        };
        const L = side(pitches.filter(p=>p.batterHand==='左打'));
        const R = side(pitches.filter(p=>p.batterHand==='右打'));
        // Count tendency (count BEFORE this pitch)
        const grp = (ps) => {
            const t=ps.length;
            const m={};
            ps.forEach(p=>{if(p.type)m[p.type]=(m[p.type]||0)+1;});
            const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
            return { t, sr:t?((ps.filter(p=>p.result==='好球').length/t)*100).toFixed(1):'0', top:top?top[0]:'--' };
        };
        const ahead  = pitches.filter(p=>(p.strikes||0)>(p.balls||0));
        const behind = pitches.filter(p=>(p.balls||0)>(p.strikes||0));
        const even   = pitches.filter(p=>(p.balls||0)===(p.strikes||0));
        // Outcome summary
        const outcomeMap={};
        pitches.forEach(p=>oc(p).forEach(o=>{if(o)outcomeMap[o]=(outcomeMap[o]||0)+1;}));
        return { total, strikes, swings, wilds, avgSpd, maxSpd, minSpd, ks, walks, hits, hrs,
                 typeSorted, zoneMap, zoneMax, L, R,
                 count:{ ahead:grp(ahead), behind:grp(behind), even:grp(even) },
                 outcomeMap };
    }

    // 好球帶熱區 HTML（3x3 彩色格）
    function _zoneHtml(zoneMap, zoneMax) {
        const bg=(n)=>{
            if(!n) return '#f0f0ee';
            const r=n/zoneMax;
            if(r<0.25) return '#fef9c3';
            if(r<0.5)  return '#fde047';
            if(r<0.75) return '#f97316';
            return '#dc2626';
        };
        const fg=(n)=>{ const r=n/zoneMax; return r>=0.75?'#fff':'#1e3a5f'; };
        const cell=(z)=>`<td style="width:56px;height:52px;text-align:center;vertical-align:middle;font-weight:900;font-size:15px;background:${bg(zoneMap[z]||0)};color:${fg(zoneMap[z]||0)};border:2px solid #d1d5db;border-radius:4px;">${zoneMap[z]||0}</td>`;
        return `<div style="text-align:center;margin:10px 0;">
            <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">← 外角（投手視角）　內角 →</div>
            <table style="border-collapse:separate;border-spacing:3px;margin:0 auto;"><tr>${cell(1)}${cell(2)}${cell(3)}</tr><tr>${cell(4)}${cell(5)}${cell(6)}</tr><tr>${cell(7)}${cell(8)}${cell(9)}</tr></table>
            <div style="font-size:10px;color:#9ca3af;margin-top:4px;">數字 = 投球次數　顏色深淺 = 相對密度</div>
        </div>`;
    }

    // ===== 主要報告產生函式 =====
    function _buildAndOpenReport(sections, pitcherName, gameId, handFilter = 'all') {
        const isAll = gameId === 'all';
        const pitcher = sections[0].pitcher;
        const allPitches = sections.flatMap(s => s.pitches);
        const handLabel = handFilter === 'left' ? '👈 對左打專項報告' : handFilter === 'right' ? '👉 對右打專項報告' : null;
        const st = _calcPitcherStats(allPitches);
        if (!st) { alert('無投球數據'); return; }

        const scopeLabel = isAll
            ? `生涯累計（共 ${sections.length} 場）`
            : [sections[0].team.date, sections[0].team.gameName, sections[0].team.opponent ? 'vs '+sections[0].team.opponent : ''].filter(Boolean).join(' ');

        // ERA / WHIP / IP
        const totalOuts = computeTotalOuts(allPitches);
        const earnedRuns = allPitches.reduce((sum, p) => {
            if (p.runsScored !== undefined && p.runsScored !== null) return sum + p.runsScored;
            const outs = p.outcomes && p.outcomes.length ? p.outcomes : (p.outcome ? [p.outcome] : []);
            if (!outs.length) return sum;
            return sum + applyBaseRunning(p.basesSnapshot || [false,false,false], outs).runsScored;
        }, 0);
        const era  = totalOuts === 0 ? (earnedRuns === 0 ? '0.00' : '-.--') : ((earnedRuns * GAME_INNING_STANDARD * 3) / totalOuts).toFixed(2);
        const whip = totalOuts === 0 ? (earnedRuns === 0 ? '0.00' : '-.--') : (((st.hits + allPitches.filter(p=>(p.outcomes||[]).some(o=>o==='保送')).length) * 3) / totalOuts).toFixed(2);
        const ipDisplay = `${Math.floor(totalOuts/3)}${totalOuts%3?'.'+totalOuts%3:''}`;
        const swingRate = st.total ? ((st.swings/st.total)*100).toFixed(1) : '0';
        const wildRate  = st.total ? ((st.wilds/st.total)*100).toFixed(1) : '0';

        // 首球習慣
        const firstPitches = allPitches.filter(p => (p.balls||0)===0 && (p.strikes||0)===0);
        const fpMap = {};
        firstPitches.forEach(p => { if(p.type) fpMap[p.type]=(fpMap[p.type]||0)+1; });
        const fpSorted = Object.entries(fpMap).sort((a,b)=>b[1]-a[1]);
        const fpTotal = firstPitches.length;

        // 兩好球決勝球
        const twoStrike = allPitches.filter(p => (p.strikes||0)===2);
        const tsSection = (ps, label, color) => {
            if (!ps.length) return `<div style="border:2px solid ${color};border-radius:8px;padding:10px;background:${color}10;"><div style="font-weight:700;color:${color};margin-bottom:6px;">${label} <span style="font-weight:400;font-size:11px;color:#6b7280;">(0球)</span></div><div style="color:#9ca3af;font-size:12px;">尚無資料</div></div>`;
            const tc={}, zc={};
            ps.forEach(p=>{ if(p.type) tc[p.type]=(tc[p.type]||0)+1; if(p.zone) zc[p.zone]=(zc[p.zone]||0)+1; });
            const topTypes = Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,3);
            const topZones = Object.entries(zc).sort((a,b)=>b[1]-a[1]).slice(0,3);
            const pct = n => ((n/ps.length)*100).toFixed(1);
            return `<div style="border:2px solid ${color};border-radius:8px;padding:10px;background:${color}10;">
                <div style="font-weight:700;color:${color};margin-bottom:8px;">${label} <span style="font-weight:400;font-size:11px;color:#6b7280;">(${ps.length}球)</span></div>
                <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px;">常用球種</div>
                ${topTypes.map(([t,n],i)=>`<div style="display:flex;justify-content:space-between;padding:4px 6px;background:${i===0?'#fef3c7':'#f9fafb'};border-radius:4px;margin-bottom:2px;font-size:12px;"><span style="font-weight:700;">${i===0?'🥇 ':''}${t}</span><span style="color:#dc2626;font-weight:700;">${n}球 ${pct(n)}%</span></div>`).join('')}
                <div style="font-size:11px;font-weight:700;color:#374151;margin:8px 0 4px;">常用位置</div>
                ${topZones.map(([z,n],i)=>`<div style="display:flex;justify-content:space-between;padding:4px 6px;background:${i===0?'#dbeafe':'#f9fafb'};border-radius:4px;margin-bottom:2px;font-size:12px;"><span style="font-weight:700;">位置 ${z}</span><span style="color:#dc2626;font-weight:700;">${n}球 ${pct(n)}%</span></div>`).join('')}
            </div>`;
        };

        // 壘上情境
        const calcBase = (ps) => {
            const total = ps.length; if (!total) return null;
            const strike = ps.filter(p=>!String(p.zone).startsWith('B'));
            const upper = strike.filter(p=>['1','2','3'].includes(String(p.zone))).length;
            const lower = strike.filter(p=>['7','8','9'].includes(String(p.zone))).length;
            const mid = strike.length - upper - lower;
            const st2 = strike.length||1;
            const hits = ps.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
            const ab   = ps.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'||o.includes('出局')||o==='三振'))).length;
            const k    = ps.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='三振'||o==='不死三振')).length;
            const bb   = ps.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='保送'||o==='觸身球')).length;
            const sr   = ((ps.filter(p=>p.result==='好球').length/total)*100).toFixed(1);
            return { total, upperPct:((upper/st2)*100).toFixed(1), midPct:((mid/st2)*100).toFixed(1), lowerPct:((lower/st2)*100).toFixed(1), hits, ab, avg: ab?(hits/ab).toFixed(3):'.000', k, bb, sr };
        };
        const bWith = calcBase(allPitches.filter(p=>p.runnersOn));
        const bNo   = calcBase(allPitches.filter(p=>!p.runnersOn));

        // 壘上差異對比表
        const baseCompareHtml = (() => {
            if (!bWith && !bNo) return '<p style="color:#9ca3af;padding:8px;">尚無壘包狀況記錄（需記錄壘包狀態）</p>';
            const fmtDiff = (va, vb, isAvg) => {
                if (va == null || vb == null) return { str:'--', color:'#6b7280' };
                const d = parseFloat(va) - parseFloat(vb);
                const str = (d > 0 ? '+' : '') + (isAvg ? d.toFixed(3) : d.toFixed(1) + '%');
                return { str, color: d > 0 ? '#dc2626' : d < 0 ? '#2563eb' : '#6b7280' };
            };
            const rows = [
                ['好球率',      bWith?.sr,       bNo?.sr,       '%',  false],
                ['高球帶(1-3)', bWith?.upperPct,  bNo?.upperPct, '%',  false],
                ['中間(4-6)',   bWith?.midPct,    bNo?.midPct,   '%',  false],
                ['低球帶(7-9)', bWith?.lowerPct,  bNo?.lowerPct, '%',  false],
                ['被打擊率',    bWith?.avg,        bNo?.avg,      '',   true],
                ['三振',        bWith?.k,          bNo?.k,        '',   false],
                ['保送/觸身',   bWith?.bb,         bNo?.bb,       '',   false],
            ];
            let insight = '';
            if (bWith && bNo) {
                const highDiff = parseFloat(bWith.upperPct) - parseFloat(bNo.upperPct);
                const avgDiff  = parseFloat(bWith.avg) - parseFloat(bNo.avg);
                if (Math.abs(highDiff) >= 5)
                    insight += `💡 壘上有人時高球帶${highDiff>0?'增加':'減少'} ${Math.abs(highDiff).toFixed(1)}%`;
                if (Math.abs(avgDiff) >= 0.020)
                    insight += (insight?'　':'💡 ') + `被打擊率${avgDiff>0?'上升':'下降'} ${Math.abs(avgDiff).toFixed(3)}`;
                if (!insight) insight = '✅ 壘上有無人時進壘點與被打擊率差異不大';
            }
            return `<table>
                <tr>
                    <th style="text-align:left;min-width:80px;">指標</th>
                    <th style="background:#7f1d1d;min-width:90px;">🏃 壘上有人<br><span style="font-weight:400;font-size:10px;">${bWith?bWith.total+'球':'無資料'}</span></th>
                    <th style="background:#1e3a5f;min-width:90px;">⬜ 壘上無人<br><span style="font-weight:400;font-size:10px;">${bNo?bNo.total+'球':'無資料'}</span></th>
                    <th style="min-width:60px;">差異<br><span style="font-weight:400;font-size:10px;">有人−無人</span></th>
                </tr>
                ${rows.map(([label,va,vb,unit,isAvg])=>{
                    const da = va!=null ? va+unit : '--';
                    const db = vb!=null ? vb+unit : '--';
                    const {str:dStr,color:dColor} = fmtDiff(va,vb,isAvg);
                    return `<tr>
                        <td class="left" style="font-weight:700;">${label}</td>
                        <td style="background:#fff5f5;font-weight:700;">${da}</td>
                        <td style="background:#eff6ff;font-weight:700;">${db}</td>
                        <td style="font-weight:900;color:${dColor};">${dStr}</td>
                    </tr>`;
                }).join('')}
            </table>
            ${insight?`<div style="margin-top:8px;padding:8px 12px;background:#fffbeb;border:1px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e;font-weight:700;">${insight}</div>`:''}`;
        })();

        const css = `
            *{box-sizing:border-box;margin:0;padding:0;}
            body{font-family:'Noto Sans TC',Arial,sans-serif;padding:24px;color:#1e3a5f;max-width:980px;margin:0 auto;font-size:13px;}
            h1{font-size:22px;font-weight:900;color:#003d79;border-bottom:4px solid #d4af37;padding-bottom:8px;margin-bottom:12px;}
            .section-title{font-size:14px;font-weight:900;color:#003d79;border-left:4px solid #d4af37;padding:5px 10px;background:#f0f4ff;border-radius:0 6px 6px 0;margin:20px 0 10px;break-after:avoid;page-break-after:avoid;}
            .section-block{break-inside:avoid;page-break-inside:avoid;}
            .pitcher-header{background:linear-gradient(135deg,#003d79,#0051a5);color:white;border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;}
            .ph-name{font-size:26px;font-weight:900;letter-spacing:2px;}
            .ph-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}
            .ph-badge{background:rgba(255,255,255,0.18);padding:3px 10px;border-radius:20px;font-size:12px;}
            .ph-badge-gold{background:rgba(255,215,0,0.25);color:#fde68a;}
            .scope-chip{background:rgba(255,255,255,0.15);font-size:12px;padding:4px 12px;border-radius:20px;border:1px solid rgba(255,255,255,0.3);white-space:nowrap;}
            .stats-row{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:8px;}
            .stat-box{background:#f0f4ff;border:1px solid #c7d7f0;border-radius:8px;padding:10px;text-align:center;}
            .stat-val{font-size:20px;font-weight:900;color:#003d79;line-height:1.1;}
            .stat-lbl{font-size:10px;color:#6b7280;margin-top:3px;}
            table{width:100%;border-collapse:collapse;margin:6px 0;}
            th{background:#003d79;color:white;padding:7px 8px;text-align:center;font-size:11px;font-weight:700;}
            td{padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:11px;}
            td.left{text-align:left;}
            tr:nth-child(even) td{background:#f9fafb;}
            .count-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;}
            .count-box{border:2px solid;border-radius:8px;padding:10px;text-align:center;}
            .count-ahead{border-color:#16a34a;background:#f0fdf4;}
            .count-even{border-color:#d4af37;background:#fffbeb;}
            .count-behind{border-color:#dc2626;background:#fef2f2;}
            .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px;}
            .sep{border:none;border-top:2px dashed #d4af37;margin:22px 0;}
            .footer{margin-top:20px;font-size:10px;color:#9ca3af;text-align:right;border-top:1px solid #e5e7eb;padding-top:8px;}
            @media print{body{padding:12px;}.section-title{break-after:avoid;page-break-after:avoid;}.section-block{break-inside:avoid;page-break-inside:avoid;}}`;

        // 球種詳細分析 table（含壞球率/揮空率/暴投率/三振率/被打擊率）
        const typeTable = st.typeSorted.length ? `
            <table><tr><th>球種</th><th>球數</th><th>佔比</th><th>好球率</th><th>壞球率</th><th>揮空率</th><th>暴投率</th><th>均速</th><th>最高速</th><th>三振率</th><th>被打率</th></tr>
            ${st.typeSorted.map(([t,v])=>{
                const n=v.n, pct=((n/st.total)*100).toFixed(1);
                const sr=n?((v.k/n)*100).toFixed(1):'0';
                const br=n?(((n-v.k)/n)*100).toFixed(1):'0';
                const tp=allPitches.filter(p=>p.type===t);
                const sw=tp.filter(p=>p.swing||p.result==='揮空').length;
                const wd=tp.filter(p=>p.wild).length;
                const ks=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='三振'||o==='不死三振')).length;
                const ab=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'||o.includes('出局')||o==='三振'))).length;
                const ht=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
                const avg=v.spd.length?(v.spd.reduce((a,b)=>a+b,0)/v.spd.length).toFixed(1):'--';
                const mx=v.spd.length?Math.max(...v.spd):'--';
                const ballAlert=parseFloat(br)>=35, wildAlert=parseFloat(((wd/n)*100).toFixed(1))>=5;
                return `<tr><td class="left" style="font-weight:700;">${t}</td><td>${n}</td><td>${pct}%</td>
                    <td style="color:#b45309;">${sr}%</td>
                    <td style="color:${ballAlert?'#dc2626':'#065f46'};font-weight:${ballAlert?'700':'400'};">${br}%${ballAlert?' ⚠':''}</td>
                    <td>${n?((sw/n)*100).toFixed(1):'0'}%</td>
                    <td style="color:${wildAlert?'#dc2626':'inherit'};font-weight:${wildAlert?'700':'400'};">${n?((wd/n)*100).toFixed(1):'0'}%${wildAlert?' ⚠':''}</td>
                    <td>${avg}</td><td>${mx}</td>
                    <td>${ab?((ks/ab)*100).toFixed(1):'0'}%</td>
                    <td>${ab?(ht/ab).toFixed(3):'.000'}</td></tr>`;
            }).join('')}</table>` : '<p style="color:#9ca3af;padding:8px;">尚無球種記錄</p>';

        // 左右打者分析
        const splitTable = `
            <table><tr><th>指標</th><th>對左打者 (${st.L.t}球)</th><th>對右打者 (${st.R.t}球)</th></tr>
            <tr><td class="left">好球率</td><td>${st.L.sr}%</td><td>${st.R.sr}%</td></tr>
            <tr><td class="left">被安打</td><td>${st.L.h}</td><td>${st.R.h}</td></tr>
            <tr><td class="left">打擊率</td><td>${st.L.avg}</td><td>${st.R.avg}</td></tr>
            <tr><td class="left">三振</td><td>${st.L.k}</td><td>${st.R.k}</td></tr>
            <tr><td class="left">保送/觸身</td><td>${st.L.bb}</td><td>${st.R.bb}</td></tr>
            </table>`;

        // 球數傾向
        const countHtml = `
            <div class="count-row">
                <div class="count-box count-ahead">
                    <div style="font-size:11px;color:#16a34a;font-weight:700;margin-bottom:4px;">🟢 領先球數</div>
                    <div style="font-size:20px;font-weight:900;color:#15803d;">${st.count.ahead.t}球</div>
                    <div style="font-size:11px;color:#6b7280;margin-top:4px;">好球率 ${st.count.ahead.sr}%</div>
                    <div style="font-size:11px;color:#6b7280;">主投 ${st.count.ahead.top}</div>
                </div>
                <div class="count-box count-even">
                    <div style="font-size:11px;color:#92400e;font-weight:700;margin-bottom:4px;">🟡 平均球數</div>
                    <div style="font-size:20px;font-weight:900;color:#92400e;">${st.count.even.t}球</div>
                    <div style="font-size:11px;color:#6b7280;margin-top:4px;">好球率 ${st.count.even.sr}%</div>
                    <div style="font-size:11px;color:#6b7280;">主投 ${st.count.even.top}</div>
                </div>
                <div class="count-box count-behind">
                    <div style="font-size:11px;color:#dc2626;font-weight:700;margin-bottom:4px;">🔴 落後球數</div>
                    <div style="font-size:20px;font-weight:900;color:#dc2626;">${st.count.behind.t}球</div>
                    <div style="font-size:11px;color:#6b7280;margin-top:4px;">好球率 ${st.count.behind.sr}%</div>
                    <div style="font-size:11px;color:#6b7280;">主投 ${st.count.behind.top}</div>
                </div>
            </div>`;

        // 打擊結果完整統計
        const allOutcomeRows = Object.entries(st.outcomeMap).sort((a,b)=>b[1]-a[1])
            .map(([o,n])=>`<tr><td class="left">${o}</td><td style="color:#003d79;font-weight:900;">${n}</td><td>${st.total?((n/st.total)*100).toFixed(1)+'%':'--'}</td></tr>`).join('');

        // 常用球種與配球模式
        const typeCount = {};
        allPitches.forEach(p => { if(p.type) typeCount[p.type] = (typeCount[p.type]||0)+1; });
        const sortedTypes = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
        // 配球序列 top5
        const seqMap = {};
        for (let i = 1; i < allPitches.length; i++) {
            if (!allPitches[i-1].type || !allPitches[i].type) continue;
            const k = `${allPitches[i-1].type} → ${allPitches[i].type}`;
            seqMap[k] = (seqMap[k]||0)+1;
        }
        const topSeqs = Object.entries(seqMap).sort((a,b)=>b[1]-a[1]).slice(0,5);

        const patternHtml = `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
    <div>
        <div style="font-size:12px;font-weight:700;color:#003d79;margin-bottom:6px;border-left:3px solid #d4af37;padding-left:6px;">常用球種</div>
        <table><tr><th>球種</th><th>球數</th><th>佔比</th></tr>
        ${sortedTypes.map(([t,n],i)=>`<tr><td class="left" style="font-weight:700;">${i===0?'🥇 ':i===1?'🥈 ':i===2?'🥉 ':''}${t}</td><td>${n}</td><td>${((n/allPitches.length)*100).toFixed(1)}%</td></tr>`).join('')}
        </table>
    </div>
    <div>
        <div style="font-size:12px;font-weight:700;color:#003d79;margin-bottom:6px;border-left:3px solid #d4af37;padding-left:6px;">配球序列 Top5</div>
        ${topSeqs.length?`<table><tr><th>配球模式</th><th>次數</th></tr>
        ${topSeqs.map(([seq,n],i)=>`<tr><td class="left" style="font-weight:700;">${i===0?'🥇 ':i===1?'🥈 ':i===2?'🥉 ':''}${seq}</td><td style="font-weight:700;color:#dc2626;">${n}</td></tr>`).join('')}
        </table>`:'<p style="color:#9ca3af;padding:8px;">需至少 2 球資料</p>'}
    </div>
</div>`;

        // 內外角分析
        const buildInnerOuterHtml = (ps, innerZones, outerZones, label) => {
            if (!ps.length) return `<div style="color:#9ca3af;padding:8px;">${label}: 尚無資料</div>`;
            const total = ps.length;
            const strPs = ps.filter(p => !String(p.zone).startsWith('B'));
            const inner = strPs.filter(p => innerZones.includes(String(p.zone))).length;
            const outer = strPs.filter(p => outerZones.includes(String(p.zone))).length;
            const mid = strPs.length - inner - outer;
            const pct = n => strPs.length ? ((n/strPs.length)*100).toFixed(1) : '0';
            const tCount = {};
            ps.forEach(p => { if(p.type) tCount[p.type]=(tCount[p.type]||0)+1; });
            const topT = Object.entries(tCount).sort((a,b)=>b[1]-a[1]).slice(0,3);
            return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
                <div style="font-size:12px;font-weight:700;color:#003d79;margin-bottom:6px;">${label} (${total}球)</div>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px;">
                    <div style="text-align:center;background:#dbeafe;border-radius:6px;padding:8px;">
                        <div style="font-size:18px;font-weight:900;color:#1d4ed8;">${inner}</div>
                        <div style="font-size:10px;color:#6b7280;">內角 ${pct(inner)}%</div>
                    </div>
                    <div style="text-align:center;background:#f0fdf4;border-radius:6px;padding:8px;">
                        <div style="font-size:18px;font-weight:900;color:#15803d;">${mid}</div>
                        <div style="font-size:10px;color:#6b7280;">中間 ${pct(mid)}%</div>
                    </div>
                    <div style="text-align:center;background:#fef3c7;border-radius:6px;padding:8px;">
                        <div style="font-size:18px;font-weight:900;color:#b45309;">${outer}</div>
                        <div style="font-size:10px;color:#6b7280;">外角 ${pct(outer)}%</div>
                    </div>
                </div>
                <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px;">常用球種</div>
                ${topT.map(([t,n])=>`<div style="display:flex;justify-content:space-between;padding:3px 6px;font-size:11px;border-bottom:1px solid #f0f0f0;">
                    <span style="font-weight:700;">${t}</span>
                    <span>${n}球 ${((n/total)*100).toFixed(1)}%</span>
                </div>`).join('')}
            </div>`;
        };

        let innerOuterHtml;
        if (handFilter === 'all') {
            const rhb = allPitches.filter(p => p.batterHand === '右打');
            const lhb = allPitches.filter(p => p.batterHand === '左打');
            innerOuterHtml = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                ${buildInnerOuterHtml(lhb, ['3','6','9'], ['1','4','7'], '👈 對左打 (LHB)')}
                ${buildInnerOuterHtml(rhb, ['1','4','7'], ['3','6','9'], '👉 對右打 (RHB)')}
            </div>
            <p style="font-size:11px;color:#9ca3af;margin-top:6px;">內角定義：對RHB為1/4/7區，對LHB為3/6/9區。</p>`;
        } else {
            const innerZones = handFilter === 'left' ? ['3','6','9'] : ['1','4','7'];
            const outerZones = handFilter === 'left' ? ['1','4','7'] : ['3','6','9'];
            const ioLabel = handFilter === 'left' ? '👈 對左打 (LHB)' : '👉 對右打 (RHB)';
            innerOuterHtml = buildInnerOuterHtml(allPitches, innerZones, outerZones, ioLabel);
        }

        // 首球習慣 HTML
        const firstPitchHtml = fpTotal === 0
            ? '<p style="color:#9ca3af;padding:8px;">尚無首球資料（需記錄球數）</p>'
            : `<p style="font-size:11px;color:#6b7280;margin-bottom:6px;">共 ${fpTotal} 個打席首球</p>
               <table><tr><th>球種</th><th>次數</th><th>佔比</th></tr>
               ${fpSorted.map(([t,n],i)=>`<tr><td class="left" style="font-weight:700;">${i===0?'🥇 ':i===1?'🥈 ':''}${t}</td><td>${n}</td><td>${((n/fpTotal)*100).toFixed(1)}%</td></tr>`).join('')}
               </table>`;

        // ===== 對比區（slotA vs slotB 若兩者都已設定）=====
        let compareSection = '';
        const hasCompare = slotA.team !== null && slotA.pitcher !== null &&
                           slotB.team !== null && slotB.pitcher !== null;
        if (hasCompare) {
            const teamA = allData.teams[slotA.team];
            const teamB = allData.teams[slotB.team];
            const pA = teamA?.pitchers[slotA.pitcher];
            const pB = teamB?.pitchers[slotB.pitcher];
            const psA = (pA?.pitches || []);
            const psB = (pB?.pitches || []);
            const stA = _calcPitcherStats(psA);
            const stB = _calcPitcherStats(psB);
            if (stA && stB && pA && pB) {
                const totA = stA.total, totB = stB.total;
                const typeMapA = Object.fromEntries(stA.typeSorted);
                const typeMapB = Object.fromEntries(stB.typeSorted);
                const allCmpTypes = [...new Set([...Object.keys(typeMapA), ...Object.keys(typeMapB)])];

                const basicRows = [
                    ['總球數',   totA,                                         totB,                                          '球',   false],
                    ['好球率',   totA?((stA.strikes/totA)*100).toFixed(1):0,   totB?((stB.strikes/totB)*100).toFixed(1):0,   '%',    false],
                    ['平均球速', stA.avgSpd,                                    stB.avgSpd,                                    'km/h', false],
                    ['最高球速', stA.maxSpd,                                    stB.maxSpd,                                    'km/h', false],
                    ['三振',     stA.ks,                                        stB.ks,                                        '',     false],
                    ['保送/觸身',stA.walks,                                      stB.walks,                                     '',     false],
                    ['被安打',   stA.hits,                                       stB.hits,                                      '',     false],
                    ['揮空率',   totA?((stA.swings/totA)*100).toFixed(1):0,    totB?((stB.swings/totB)*100).toFixed(1):0,    '%',    false],
                    ['暴投率',   totA?((stA.wilds/totA)*100).toFixed(1):0,     totB?((stB.wilds/totB)*100).toFixed(1):0,     '%',    false],
                    ['對左打好球率', stA.L.sr,  stB.L.sr, '%', false],
                    ['對右打好球率', stA.R.sr,  stB.R.sr, '%', false],
                ];

                const typeRows = allCmpTypes.map(type => {
                    const vA = typeMapA[type], vB = typeMapB[type];
                    const tpA = psA.filter(p=>p.type===type);
                    const tpB = psB.filter(p=>p.type===type);
                    const pctA = vA ? ((vA.n/totA)*100).toFixed(1)+'%' : '—';
                    const srA  = tpA.length ? ((tpA.filter(p=>p.result==='好球').length/tpA.length)*100).toFixed(1)+'%' : '—';
                    const swA  = tpA.length ? ((tpA.filter(p=>p.swing).length/tpA.length)*100).toFixed(1)+'%' : '—';
                    const pctB = vB ? ((vB.n/totB)*100).toFixed(1)+'%' : '—';
                    const srB  = tpB.length ? ((tpB.filter(p=>p.result==='好球').length/tpB.length)*100).toFixed(1)+'%' : '—';
                    const swB  = tpB.length ? ((tpB.filter(p=>p.swing).length/tpB.length)*100).toFixed(1)+'%' : '—';
                    const color = PITCH_COLORS[type] || '#1e3a5f';
                    return `<tr><td class="left" style="font-weight:700;color:${color};">${type}</td>
                        <td>${pctA}</td><td>${srA}</td><td>${swA}</td>
                        <td>${pctB}</td><td>${srB}</td><td>${swB}</td></tr>`;
                }).join('');

                // 首球對比
                const fpA = psA.filter(p=>(p.balls||0)===0&&(p.strikes||0)===0);
                const fpB = psB.filter(p=>(p.balls||0)===0&&(p.strikes||0)===0);
                const fpMapA = {}; fpA.forEach(p=>{if(p.type)fpMapA[p.type]=(fpMapA[p.type]||0)+1;});
                const fpMapB = {}; fpB.forEach(p=>{if(p.type)fpMapB[p.type]=(fpMapB[p.type]||0)+1;});
                const fpTop = (m,t) => Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([tp,n])=>`${tp} ${t?((n/t)*100).toFixed(0)+'%':''}`).join('、') || '—';

                compareSection = `
                <hr class="sep">
                <div class="section-title">⚔️ A vs B 投手對比</div>
                <div class="section-block">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                    <div style="background:linear-gradient(135deg,#003d79,#0051a5);color:white;border-radius:8px;padding:10px 14px;">
                        <div style="font-size:15px;font-weight:900;">🅐 ${pA.name}${pA.number?' #'+pA.number:''}</div>
                        <div style="font-size:11px;opacity:0.75;margin-top:3px;">${teamA.name}　${teamA.gameName||''}　${teamA.date||''}</div>
                        <div style="font-size:11px;opacity:0.6;margin-top:2px;">${pA.hand||''} ${pA.role||''}</div>
                    </div>
                    <div style="background:linear-gradient(135deg,#374151,#4b5563);color:white;border-radius:8px;padding:10px 14px;">
                        <div style="font-size:15px;font-weight:900;">🅑 ${pB.name}${pB.number?' #'+pB.number:''}</div>
                        <div style="font-size:11px;opacity:0.75;margin-top:3px;">${teamB.name}　${teamB.gameName||''}　${teamB.date||''}</div>
                        <div style="font-size:11px;opacity:0.6;margin-top:2px;">${pB.hand||''} ${pB.role||''}</div>
                    </div>
                </div>
                <div style="font-size:12px;font-weight:700;color:#003d79;margin:8px 0 4px;border-left:3px solid #d4af37;padding-left:6px;">📊 核心數據對比</div>
                <table>
                    <tr><th style="text-align:left;">指標</th><th style="color:#fde68a;">A · ${pA.name}</th><th style="color:#d1d5db;">B · ${pB.name}</th><th>差異 (A−B)</th></tr>
                    ${basicRows.map(([label, vA, vB, unit]) => {
                        const dNum = parseFloat(vA) - parseFloat(vB);
                        const dStr = isNaN(dNum) ? '—' : (dNum > 0 ? '+' : '') + (Number.isInteger(dNum) ? dNum : dNum.toFixed(1)) + unit;
                        const dColor = dNum > 0 ? '#dc2626' : dNum < 0 ? '#2563eb' : '#6b7280';
                        return `<tr><td class="left" style="font-weight:700;">${label}</td><td>${vA}${unit}</td><td>${vB}${unit}</td><td style="font-weight:900;color:${dColor};">${dStr}</td></tr>`;
                    }).join('')}
                </table>
                </div>
                <div class="section-block" style="margin-top:12px;">
                <div style="font-size:12px;font-weight:700;color:#003d79;margin:8px 0 4px;border-left:3px solid #d4af37;padding-left:6px;">⚾ 球種比例與效果對比</div>
                <table>
                    <tr><th style="text-align:left;">球種</th>
                        <th style="color:#fde68a;">A 佔比</th><th style="color:#fde68a;">A 好球%</th><th style="color:#fde68a;">A 揮空%</th>
                        <th style="color:#d1d5db;">B 佔比</th><th style="color:#d1d5db;">B 好球%</th><th style="color:#d1d5db;">B 揮空%</th></tr>
                    ${typeRows}
                </table>
                </div>
                <div class="section-block" style="margin-top:12px;">
                <div style="font-size:12px;font-weight:700;color:#003d79;margin:8px 0 4px;border-left:3px solid #d4af37;padding-left:6px;">🏁 首球習慣對比</div>
                <table>
                    <tr><th style="text-align:left;">投手</th><th>打席首球數</th><th>常用首球 Top3</th></tr>
                    <tr><td class="left" style="font-weight:700;color:#003d79;">A · ${pA.name}</td><td>${fpA.length}</td><td class="left">${fpTop(fpMapA, fpA.length)}</td></tr>
                    <tr><td class="left" style="font-weight:700;color:#4b5563;">B · ${pB.name}</td><td>${fpB.length}</td><td class="left">${fpTop(fpMapB, fpB.length)}</td></tr>
                </table>
                </div>`;
            }
        }

        // 各場次摘要（生涯模式才顯示）
        let gamesBlock = '';
        if (isAll && sections.length > 1) {
            gamesBlock = `<div class="section-title">📅 各場次摘要</div>
            <table><tr><th>日期</th><th>賽事</th><th>對手</th><th>球數</th><th>好球率</th><th>均速</th><th>最速</th><th>三振</th><th>保送</th><th>被安打</th></tr>
            ${sections.map(s=>{
                const ps=s.pitches, t=ps.length; if(!t) return '';
                const sp=ps.filter(p=>p.result==='好球').length;
                const spd=ps.filter(p=>p.speed).map(p=>p.speed);
                const av=spd.length?(spd.reduce((a,b)=>a+b,0)/spd.length).toFixed(1):'--';
                const mx=spd.length?Math.max(...spd):'--';
                const k=ps.filter(p=>(p.outcomes||[]).some(o=>o==='三振'||o==='不死三振')).length;
                const bb=ps.filter(p=>(p.outcomes||[]).some(o=>o==='保送'||o==='觸身球')).length;
                const h=ps.filter(p=>(p.outcomes||[]).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
                return `<tr><td>${s.team.date||'--'}</td><td class="left">${s.team.gameName||''}</td><td>${s.team.opponent||''}</td><td>${t}</td><td>${t?((sp/t)*100).toFixed(1)+'%':'--'}</td><td>${av}</td><td>${mx}</td><td>${k}</td><td>${bb}</td><td>${h}</td></tr>`;
            }).join('')}</table>`;
        }

        const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8">
            <title>投手情蒐報告 — ${pitcherName}</title>
            <style>${css}</style></head><body>
            <h1>⚾ 投手情蒐報告</h1>

            <div class="pitcher-header">
                <div>
                    <div class="ph-name">${pitcher.name}${pitcher.number?' <span style="font-size:18px;opacity:0.7;">#'+pitcher.number+'</span>':''}</div>
                    <div class="ph-badges">
                        ${pitcher.hand?`<span class="ph-badge">${pitcher.hand}</span>`:''}
                        ${pitcher.role?`<span class="ph-badge ph-badge-gold">${pitcher.role}</span>`:''}
                        <span class="ph-badge">${allPitches.length} 球</span>
                        <span class="ph-badge">IP ${ipDisplay}</span>
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
                    <div class="scope-chip">📊 ${scopeLabel}</div>
                    ${handLabel ? `<div class="scope-chip" style="background:rgba(255,165,0,0.25);border-color:rgba(255,165,0,0.5);">${handLabel}</div>` : ''}
                </div>
            </div>

            <div class="section-block">
            <div class="section-title">📊 核心統計</div>
            <div class="stats-row">
                <div class="stat-box"><div class="stat-val">${st.total}</div><div class="stat-lbl">總球數</div></div>
                <div class="stat-box"><div class="stat-val">${st.total?((st.strikes/st.total)*100).toFixed(1):'0'}%</div><div class="stat-lbl">好球率</div></div>
                <div class="stat-box"><div class="stat-val">${st.avgSpd}</div><div class="stat-lbl">平均球速 km/h</div></div>
                <div class="stat-box"><div class="stat-val">${st.maxSpd}</div><div class="stat-lbl">最高球速</div></div>
                <div class="stat-box"><div class="stat-val">${st.minSpd}</div><div class="stat-lbl">最低球速</div></div>
            </div>
            <div class="stats-row">
                <div class="stat-box"><div class="stat-val">${st.ks}</div><div class="stat-lbl">三振</div></div>
                <div class="stat-box"><div class="stat-val">${st.walks}</div><div class="stat-lbl">保送/觸身</div></div>
                <div class="stat-box"><div class="stat-val">${st.hits}</div><div class="stat-lbl">被安打</div></div>
                <div class="stat-box"><div class="stat-val">${swingRate}%</div><div class="stat-lbl">揮空率</div></div>
                <div class="stat-box"><div class="stat-val">${wildRate}%</div><div class="stat-lbl">暴投率</div></div>
            </div>
            <div class="stats-row">
                <div class="stat-box"><div class="stat-val">${era}</div><div class="stat-lbl">ERA</div></div>
                <div class="stat-box"><div class="stat-val">${whip}</div><div class="stat-lbl">WHIP</div></div>
                <div class="stat-box"><div class="stat-val">${ipDisplay}</div><div class="stat-lbl">投球局數</div></div>
                <div class="stat-box"><div class="stat-val">${earnedRuns}</div><div class="stat-lbl">自責分</div></div>
                <div class="stat-box"><div class="stat-val">${st.hrs}</div><div class="stat-lbl">全壘打</div></div>
            </div>
            </div>

            <div class="section-block">
            <div class="section-title">⚾ 球種詳細分析</div>
            ${typeTable}
            </div>

            <div class="section-block">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:0;">
                <div>
                    <div class="section-title">🎯 好球帶熱區</div>
                    ${_zoneHtml(st.zoneMap, st.zoneMax)}
                </div>
                <div>
                    <div class="section-title">📐 打擊結果完整統計</div>
                    <table><tr><th>結果</th><th>次數</th><th>佔比</th></tr>${allOutcomeRows||'<tr><td colspan="3" style="color:#9ca3af;">尚無記錄</td></tr>'}</table>
                </div>
            </div>
            </div>

            <div class="section-block">
            <div class="section-title">🎲 常用球種與配球模式</div>
            ${patternHtml}
            </div>

            <div class="section-block">
            <div class="section-title">📈 球數傾向分析</div>
            ${countHtml}
            </div>

            ${handFilter === 'all' ? `
            <div class="section-block">
            <div class="section-title">👥 左右打者分析</div>
            ${splitTable}
            </div>` : `
            <div class="section-block">
            <div class="section-title">👥 左右打者分析</div>
            <div style="padding:10px 12px;background:#fffbeb;border:1px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e;font-weight:700;">
                ${handLabel} — 本報告已篩選特定打者手別，左右打者比較不適用。
            </div>
            </div>`}

            <div class="section-block">
            <div class="section-title">🏁 首球（First Pitch）習慣</div>
            ${firstPitchHtml}
            </div>

            <div class="section-block">
            <div class="section-title">🎯 兩好球決勝球傾向（2 Strikes）</div>
            ${handFilter === 'all' ? `
            <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">共 ${twoStrike.length} 球兩好球紀錄（左打 ${twoStrike.filter(p=>p.batterHand==='左打').length} / 右打 ${twoStrike.filter(p=>p.batterHand==='右打').length}）</div>
            <div class="two-col">
                ${tsSection(twoStrike.filter(p=>p.batterHand==='左打'), '👈 對左打兩好球 (LHB)', '#2563eb')}
                ${tsSection(twoStrike.filter(p=>p.batterHand==='右打'), '👉 對右打兩好球 (RHB)', '#dc2626')}
            </div>` : `
            <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">共 ${twoStrike.length} 球兩好球紀錄</div>
            ${tsSection(twoStrike, handFilter==='left'?'👈 對左打兩好球 (LHB)':'👉 對右打兩好球 (RHB)', handFilter==='left'?'#2563eb':'#dc2626')}`}
            </div>

            <div class="section-block">
            <div class="section-title">↔️ 內外角分析</div>
            ${innerOuterHtml}
            </div>

            <div class="section-block">
            <div class="section-title">🏃 壘上情境分析（有人 vs 無人差異）</div>
            ${baseCompareHtml}
            </div>

            ${compareSection}

            ${gamesBlock}

            <div class="footer">產生時間：${new Date().toLocaleString('zh-TW')} ｜ 中華台北投手情蒐系統</div>
            </body></html>`;

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (w) { setTimeout(() => URL.revokeObjectURL(url), 2000); }
        else { triggerDownload(url, `投手報告_${pitcherName}_${new Date().toISOString().split('T')[0]}.html`); }
    }

    function enterSystem(role) {
        userRole = role;
        DB_KEY = currentTeamCode === 'ADMIN' ? 'pitcherScoutData' : `teams/${currentTeamCode}/data`;
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('modeSelectScreen').style.display = 'none';
        const msp = document.getElementById('modeSelectionPage');
        if (msp) msp.style.display = 'none';
        const ao = document.getElementById('authOverlay');
        if (ao) ao.style.display = 'none';
        // 每次登入重置資料 + 清 localStorage 快取，防止舊資料污染新帳號
        allData = { teams: [], pitcherDB: {} };
        if (currentTeamCode !== 'ADMIN') {
            try { localStorage.removeItem('chineseTaipeiPitcherData'); } catch(e) {}
            try { localStorage.removeItem('pitcherScoutSlotState'); } catch(e) {}
        }
        // 管理員：顯示後台面板；買家：確保隱藏
        const adminPanel = document.getElementById('adminPanel');
        const createBtn = document.getElementById('createTeamBtn');
        const injectWrap = document.getElementById('adminInjectWrap');
        if (currentTeamCode === 'ADMIN') {
            if (adminPanel) {
                adminPanel.style.display = 'block';
                adminLoadTeams();
                const wrap = document.getElementById('adminTeamListWrap');
                const btn  = document.getElementById('adminListToggleBtn');
                if (wrap) wrap.style.display = 'none';
                if (btn) { btn.textContent = '▶ 帳號管理'; btn.style.background = 'rgba(255,215,0,0.1)'; btn.style.borderColor = 'rgba(255,215,0,0.25)'; }
            }
            if (createBtn) createBtn.style.display = 'block';
            if (injectWrap) injectWrap.style.display = 'block';
        } else {
            if (adminPanel) adminPanel.style.display = 'none';
            if (createBtn) createBtn.style.display = 'none';
            if (injectWrap) injectWrap.style.display = 'none';
        }
        loadTeamHeader(currentTeamCode);
        // 登入後顯示一鍵切換模式列
        const msBar = document.getElementById('modeSwitchBar');
        if (msBar) msBar.style.display = '';
        _updateModeToggleBtn();
        listenFirebase();
        if (role === 'view') {
            document.getElementById('viewOnlyBanner').style.display = 'block';
            document.body.style.paddingTop = '36px';
            applyViewOnlyMode();
        }
        init();
    }

    async function changePassword() {
        if (userRole !== 'scout') { alert('只有情蒐員可以修改密碼'); return; }
        if (!currentTeamCode || currentTeamCode === 'ADMIN') { alert('請使用 Firebase Console 修改管理員密碼'); return; }
        const oldScout = prompt('請輸入目前情蒐員密碼：');
        if (!oldScout) return;
        db.ref(`teams/${currentTeamCode}/config`).once('value').then(async snap => {
            const config = snap.val() || {};
            const oldHash = await _sha256(oldScout);
            // 相容舊明文與新雜湊
            const oldMatches = _isHashed(config.scoutPw) ? oldHash === config.scoutPw : oldScout === config.scoutPw;
            if (!oldMatches) { alert('❌ 舊密碼錯誤'); return; }
            const newScout = prompt('請輸入新的情蒐員密碼（至少4位）：');
            if (!newScout || newScout.length < 4) { alert('密碼至少需要4個字元'); return; }
            const newView = prompt('請輸入新的觀看者密碼（至少4位，可與情蒐員不同）：');
            if (!newView || newView.length < 4) { alert('密碼至少需要4個字元'); return; }
            const [newScoutHash, newViewHash] = await Promise.all([_sha256(newScout), _sha256(newView)]);
            db.ref(`teams/${currentTeamCode}/config`).update({ scoutPw: newScoutHash, viewPw: newViewHash })
                .then(() => alert('✅ 密碼已更新！下次登入請使用新密碼'))
                .catch(e => alert('❌ 更新失敗：' + e.message));
        });
    }

    function toggleDevOptions() {
        const panel = document.getElementById('devOptionsPanel');
        const arrow = document.getElementById('devOptionsArrow');
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
        arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
    }

    function logout() {
        if (!confirm('確定要登出嗎？')) return;
        userRole = null;
        userSession = null;
        USER_TEAM_REF = null;
        if (activeFirebaseRef) { try { activeFirebaseRef.off(); } catch(e) {} activeFirebaseRef = null; }
        firebaseListening = false;
        // Reset state
        currentTeam = null; currentPitcher = null;
        slotA = { team: null, pitcher: null };
        slotB = { team: null, pitcher: null };
        activeSlot = 'A';
        // Hide view-only banner
        document.getElementById('viewOnlyBanner').style.display = 'none';
        document.body.style.paddingTop = '';
        // Reset login form
        document.getElementById('loginPw').value = '';
        document.getElementById('loginError').textContent = '';
        selectRole('scout');
        // Firebase Auth sign-out (new flow) — onAuthStateChanged will show authOverlay
        try { firebase.auth().signOut(); } catch(e) {}
        // 重置 header 隊名
        loadTeamHeader(null);
        // 重置資料
        allData = { teams: [], pitcherDB: {} };
        // If legacy admin was logged in (no Firebase Auth session), show authOverlay directly
        const ao = document.getElementById('authOverlay');
        if (ao) ao.style.display = 'flex';
        const msp = document.getElementById('modeSelectionPage');
        if (msp) msp.style.display = 'none';
        // 隱藏模式切換列
        const msBar = document.getElementById('modeSwitchBar');
        if (msBar) msBar.style.display = 'none';
        // 重置至投手模式
        userMode = 'pitcher';
        setTimeout(loadRememberedLogin, 80);
    }

    function applyViewOnlyMode() {
        // Switch to stats tab by default for viewers
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        // Will be applied after init() renders tabs
        setTimeout(() => {
            // Hide record tab button, default to stats
            const tabs = document.querySelectorAll('.tab-btn');
            tabs.forEach(t => {
                if (t.textContent.includes('記錄')) {
                    t.style.display = 'none';
                }
            });
            // Auto-switch to stats
            const statsBtn = Array.from(tabs).find(t => t.textContent.includes('統計'));
            if (statsBtn) statsBtn.click();
            // Disable all input/button in record tab
            document.querySelectorAll('#recordTab input, #recordTab button, #recordTab select').forEach(el => {
                el.disabled = true;
                el.style.opacity = '0.5';
                el.style.pointerEvents = 'none';
            });
            // Hide sidebar management sections
            const mgmt = document.querySelector('.team-management');
            if (mgmt) mgmt.style.display = 'none';
            // Switch bottom bar: hide scout bar, show viewer bar
            const scoutBar = document.getElementById('scoutBottomBar');
            if (scoutBar) scoutBar.style.display = 'none';
            const viewerBar = document.getElementById('viewerBottomBar');
            if (viewerBar) viewerBar.style.display = 'block';
        }, 100);
    }

    // ====== 後台權限控制 ======
    function controlUserRolePermissions(role) {
        if (role === 'viewer') {
            // 延遲確保 DOM 已渲染完成
            setTimeout(() => {
                const writeSelectors = [
                    '.pitch-btn', '#confirmRecordBtn', '#btnRecord',
                    '.btn-add', '#btnSave', '.delete-btn',
                    '.score-btn', '.half-btn', '.zone-cell',
                    '#foulBtn', '#swingBtn', '#wildBtn',
                    '.outcome-btn', '.speed-btn', '.order-adj-btn',
                    '.hand-btn', '#pinchHitterBtn'
                ];
                writeSelectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.opacity = '0.3';
                        el.style.pointerEvents = 'none';
                    });
                });
                applyViewOnlyMode();
            }, 200);
        }
        // 'admin' / 'scout'：維持正常，不做限制
    }

    function refreshData(btn) {
        if (btn) { btn.textContent = '⏳ 更新中...'; btn.disabled = true; }
        getDataRef().once('value')
            .then(snap => {
                const teams = normalizeTeamsData(snap.val());
                if (teams) {
                    allData.teams = teams;
                    allData.pitcherDB = {};
                    rebuildPitcherDB();
                    saveToLocalStorage();
                }
                updateTeamList(); updateSlotDisplay(); updatePitchLog(); updateStats(); updateScoreboard();
                if (btn) {
                    const origText = btn.id === 'viewerRefreshBtn' ? '🔄 重新整理' : '🔄 重整';
                    btn.textContent = '✅ 已更新';
                    btn.style.background = 'rgba(16,185,129,0.5)';
                    btn.disabled = false;
                    setTimeout(() => { btn.textContent = origText; btn.style.background = ''; }, 1500);
                }
            })
            .catch(() => {
                updateTeamList(); updateSlotDisplay(); updatePitchLog(); updateStats(); updateScoreboard();
                if (btn) {
                    const origText = btn.id === 'viewerRefreshBtn' ? '🔄 重新整理' : '🔄 重整';
                    btn.textContent = '📵 離線更新';
                    btn.style.background = 'rgba(251,191,36,0.3)';
                    btn.disabled = false;
                    setTimeout(() => { btn.textContent = origText; btn.style.background = ''; }, 1500);
                }
            });
    }

    function init() {
        loadSiteConfig();
        loadFromLocalStorage();
        updateTeamList();
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('newTeamDate').value = today;
        updateScoreboard();
        renderCountLights();
        renderBases();
        // 顯示版本號：登入頁 + 主介面 + 側邊欄底部
        const verEl = document.getElementById('appVersionDisplay');
        if (verEl) verEl.textContent = APP_VERSION;
        const verMainEl = document.getElementById('appVersionMain');
        if (verMainEl) verMainEl.textContent = APP_VERSION;
        const verLabel = document.getElementById('appVersionLabel');
        if (verLabel) verLabel.textContent = APP_VERSION;
        // checkForUpdate 已在 SW 註冊時直接呼叫，此處不重複觸發
        updateFieldMapToggleBtn();
        listenForUpdateNotifications();

        // 從 SW 快取自動偵測實際版本號（防止 APP_VERSION 與 sw.js desync）
        if ('caches' in window) {
            caches.keys().then(keys => {
                const swKeys = keys.filter(k => k.startsWith('pitcher-scout-v'));
                if (swKeys.length === 0) return;
                // 取數字最大的版本（格式 pitcher-scout-vNNN）
                const latest = swKeys.sort((a, b) => {
                    const na = parseInt(a.replace('pitcher-scout-v', '')) || 0;
                    const nb = parseInt(b.replace('pitcher-scout-v', '')) || 0;
                    return na - nb;
                }).pop();
                const detectedVer = latest.replace('pitcher-scout-', '');
                ['appVersionDisplay', 'appVersionMain', 'appVersionLabel'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = detectedVer;
                });
            }).catch(() => {});
        }
    }

    // injectDemoData 已移除，上線版禁止自動覆蓋真實資料
    function injectDemoData() {
        console.warn('[injectDemoData] 已停用。如需測試資料請手動於 Firebase Console 新增。');
        // bm 打者模式示範資料（可從 console 呼叫此函式注入）
        const demoBm = {
            lineup: [
                { number: '5',  name: '陳傑憲', hand: '右打' },
                { number: '23', name: '林立',   hand: '右打' },
                { number: '7',  name: '鄭宗哲', hand: '右打' },
                { number: '2',  name: '曾峻岳', hand: '右打' },
                { number: '15', name: '吳念庭', hand: '左打' },
                { number: '34', name: '高宇杰', hand: '右打' },
                { number: '9',  name: '林子偉', hand: '左打' },
                { number: '18', name: '陳晨威', hand: '右打' },
                { number: '28', name: '呂彥青', hand: '右打' },
            ],
            gameIdx: 0,
            attackingTeam: 'B',
            atBats: [
                { number:'5',  name:'陳傑憲', order:1, hand:'右打', inning:1, half:'上', outs:0, bases:[false,false,false], pitcherHand:'右投', outcome:'一壘安打',  hitLocation:{x:0.22,y:0.45,zone:'3B'}, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-3600000 },
                { number:'23', name:'林立',   order:2, hand:'右打', inning:1, half:'上', outs:0, bases:[true,false,false],  pitcherHand:'右投', outcome:'三振',      hitLocation:null, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-3550000 },
                { number:'7',  name:'鄭宗哲', order:3, hand:'右打', inning:1, half:'上', outs:1, bases:[true,false,false],  pitcherHand:'右投', outcome:'二壘安打',  hitLocation:{x:0.25,y:0.2,zone:'LCF'}, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-3500000 },
                { number:'2',  name:'曾峻岳', order:4, hand:'右打', inning:1, half:'上', outs:1, bases:[false,false,true],  pitcherHand:'右投', outcome:'飛球出局',  hitLocation:{x:0.5,y:0.15,zone:'CF'}, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-3450000 },
                { number:'15', name:'吳念庭', order:5, hand:'左打', inning:2, half:'上', outs:0, bases:[false,false,false], pitcherHand:'右投', outcome:'保送',      hitLocation:null, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-3000000 },
                { number:'34', name:'高宇杰', order:6, hand:'右打', inning:2, half:'上', outs:0, bases:[false,false,false], pitcherHand:'右投', outcome:'滾地球出局', hitLocation:{x:0.55,y:0.55,zone:'2B'}, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-2950000 },
                { number:'5',  name:'陳傑憲', order:1, hand:'右打', inning:3, half:'上', outs:0, bases:[false,false,false], pitcherHand:'左投', outcome:'三振',      hitLocation:null, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-2400000 },
                { number:'23', name:'林立',   order:2, hand:'右打', inning:3, half:'上', outs:1, bases:[false,false,false], pitcherHand:'左投', outcome:'一壘安打',  hitLocation:{x:0.72,y:0.42,zone:'1B'}, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-2350000 },
                { number:'7',  name:'鄭宗哲', order:3, hand:'右打', inning:3, half:'上', outs:1, bases:[true,false,false],  pitcherHand:'左投', outcome:'全壘打',    hitLocation:{x:0.5,y:0.08,zone:'CF'}, mode:'linked', pitches:[], gameIdx:0, ts: Date.now()-2300000 },
                { number:'5',  name:'陳傑憲', order:0, hand:'右打', inning:1, half:'上', outs:0, bases:[false,false,false], pitcherHand:'左投', outcome:'三振', hitLocation:null, mode:'standalone',
                    pitches:[
                        {type:'四縫線',zone:'5',reaction:'看球',isStrike:true},
                        {type:'四縫線',zone:'2',reaction:'揮棒落空',isStrike:true},
                        {type:'滑球',zone:'B9',reaction:'看球',isStrike:false},
                        {type:'滑球',zone:'6',reaction:'揮棒落空',isStrike:true}
                    ], gameIdx:1, ts: Date.now()-1800000 },
                { number:'23', name:'林立', order:0, hand:'右打', inning:1, half:'上', outs:1, bases:[false,false,false], pitcherHand:'左投', outcome:'一壘安打', hitLocation:{x:0.68,y:0.35,zone:'RF'}, mode:'standalone',
                    pitches:[
                        {type:'四縫線',zone:'3',reaction:'看球',isStrike:true},
                        {type:'變速球',zone:'B7',reaction:'揮棒落空',isStrike:true},
                        {type:'四縫線',zone:'6',reaction:'打進場內',isStrike:true}
                    ], gameIdx:1, ts: Date.now()-1750000 },
            ]
        };
        allData.bm = demoBm;
        saveToLocalStorage();
        console.log('[injectDemoData] bm 示範資料已注入，可切換到打者模式查看');
    }
    /* ── 以下為已停用的舊測試資料產生器 ── */
    function _removedInjectDemoData_DISABLED() {
        const rnd = (a,b) => Math.floor(Math.random()*(b-a+1))+a;
        const pick = arr => arr[rnd(0,arr.length-1)];
        const types = ['快速球','上飄球','下墜球','變速球','內曲','外曲'];
        const strikeZones = ['1','2','3','4','5','6','7','8','9'];
        const ballZones = ['B1','B2','B3','B4','B5','B6','B7','B8','B9','B10','B11','B12','B13','B14','B15','B16'];
        const hands = ['右打','左打'];
        const outcomes = ['','','','','三振','保送','一壘安打','滾地球出局','飛球出局',''];

        function makePitch(balls, strikes) {
            const isStrike = Math.random() < 0.58;
            const zone = isStrike ? pick(strikeZones) : pick(ballZones);
            const type = pick(types);
            const outcome = (strikes === 2 && Math.random() < 0.3) ? pick(['三振','不死三振']) :
                            (balls === 3 && Math.random() < 0.3) ? '保送' :
                            (Math.random() < 0.08) ? pick(['一壘安打','滾地球出局','飛球出局','三振']) : '';
            return {
                type, zone,
                result: isStrike ? '好球' : '壞球',
                speed: type === '快速球' ? rnd(120,138) : type === '上飄球' ? rnd(118,132) : type === '變速球' ? rnd(104,116) : rnd(108,124),
                swing: isStrike && Math.random() < 0.35,
                wild: !isStrike && Math.random() < 0.05,
                foul: isStrike && Math.random() < 0.12,
                batterHand: pick(hands),
                batterNumber: rnd(1,35),
                batterOrder: rnd(1,9),
                outcomes: outcome ? [outcome] : [],
                balls, strikes,
                runnersOn: Math.random() < 0.4,
                timestamp: Date.now() - rnd(0, 3600000)
            };
        }

        function makePitches(count) {
            const pitches = [];
            let b = 0, s = 0;
            for (let i = 0; i < count; i++) {
                const p = makePitch(b, s);
                pitches.push(p);
                const outcome = p.outcomes[0];
                if (outcome === '三振' || outcome === '不死三振' || outcome === '保送' || outcome === '一壘安打' || outcome === '滾地球出局' || outcome === '飛球出局') { b = 0; s = 0; }
                else if (p.result === '好球') { s = Math.min(s+1, 2); }
                else { b = Math.min(b+1, 3); }
            }
            return pitches;
        }

        // 兩個賽事，同一個投手「王大明」
        allData.teams = [
            {
                gameName: '2026 世界盃青棒賽',
                name: '中華台北', opponent: '日本',
                date: '2026-05-10',
                pitchers: [
                    { name:'王大明', number:'21', hand:'右投', role:'先發', style:'速球型', pitches: makePitches(87), score: { home:2, away:5, inning:7, half:'下' } },
                    { name:'陳志豪', number:'34', hand:'左投', role:'先發', style:'軟投變化球', pitches: makePitches(65), score: { home:2, away:5, inning:7, half:'下' } }
                ]
            },
            {
                gameName: '2026 世界盃青棒賽',
                name: '中華台北', opponent: '韓國',
                date: '2026-05-12',
                pitchers: [
                    { name:'陳志豪', number:'34', hand:'左投', role:'先發', style:'軟投變化球', pitches: makePitches(72), score: { home:3, away:1, inning:9, half:'下' } },
                    { name:'王大明', number:'21', hand:'右投', role:'中繼', style:'速球型', pitches: makePitches(34), score: { home:3, away:1, inning:9, half:'下' } }
                ]
            },
            {
                gameName: '2025 亞青盃',
                name: '中華台北', opponent: '美國',
                date: '2025-09-05',
                pitchers: [
                    { name:'王大明', number:'21', hand:'右投', role:'先發', style:'速球型', pitches: makePitches(105), score: { home:4, away:2, inning:7, half:'上' } },
                    { name:'林俊傑', number:'15', hand:'右投', role:'後援', style:'火球派', pitches: makePitches(28), score: { home:4, away:2, inning:7, half:'上' } }
                ]
            },
            {
                gameName: '2025 亞青盃',
                name: '中華台北', opponent: '古巴',
                date: '2025-09-08',
                pitchers: [
                    { name:'陳志豪', number:'34', hand:'左投', role:'先發', style:'軟投變化球', pitches: makePitches(95), score: { home:1, away:0, inning:8, half:'上' } },
                    { name:'王大明', number:'21', hand:'右投', role:'後援', style:'速球型', pitches: makePitches(22), score: { home:1, away:0, inning:8, half:'上' } }
                ]
            }
        ];
        rebuildPitcherDB();
        saveToLocalStorage();
    } // end _removedInjectDemoData_DISABLED

    // ====== TAIWAN FLAG ======
    function checkTaiwanFlag(input) {
        const val = input.value;
        const isTW = /台灣|台北|中華台北|chinese taipei|taiwan/i.test(val);
        document.getElementById('twFlagHint').style.display = isTW ? 'inline' : 'none';
        document.getElementById('twFlagText').style.display = isTW ? 'inline' : 'none';
    }

    // ====== SIDEBAR ======
    function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const mainContent = document.getElementById('mainContent');
        const toggleBtn = document.getElementById('toggleSidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle('show');
            overlay.classList.toggle('show');
        } else {
            sidebar.classList.toggle('collapsed');
            mainContent.classList.toggle('expanded');
            toggleBtn.classList.toggle('moved');
        }
    }

    // ====== ADD TEAM ======
    function addTeam() {
        const teamName = document.getElementById('newTeamName').value.trim();
        const teamDate = document.getElementById('newTeamDate').value;
        const teamOpponent = document.getElementById('newTeamOpponent').value.trim();
        const gameName = document.getElementById('newTeamGameName').value.trim();
        if (!teamName) { alert('請輸入先攻隊名！'); return; }
        allData.teams.push({
            gameId: _makeGameId(),
            name: teamName, date: teamDate,
            opponent: teamOpponent, gameName: gameName,
            pitchers: []
        });
        expandedGames.add(gameName || '未分類');
        document.getElementById('newTeamName').value = '';
        document.getElementById('newTeamOpponent').value = '';
        document.getElementById('newTeamGameName').value = '';
        document.getElementById('newTeamDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('twFlagHint').style.display = 'none';
        document.getElementById('twFlagText').style.display = 'none';
        updateTeamList();
        saveToLocalStorage();
        saveToFirebase(allData.teams.length - 1);
    }

    // ====== ADD PITCHER MODAL ======
    function showAddPitcherModal() {
        if (allData.teams.length === 0) { alert('請先新增球隊！'); return; }
        const modal = document.getElementById('addPitcherModal');
        const select = document.getElementById('modalTeamSelect');
        select.innerHTML = '';
        allData.teams.forEach((team, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${team.name}${team.opponent ? ' vs ' + team.opponent : ''} ${team.date ? '(' + team.date + ')' : ''}`;
            select.appendChild(option);
        });
        modal.style.display = 'block';
    }

    function closeAddPitcherModal() {
        document.getElementById('addPitcherModal').style.display = 'none';
        ['modalPitcherNameA','modalPitcherNameB'].forEach(id => document.getElementById(id).value = '');
        ['modalPitcherNumberA','modalPitcherNumberB'].forEach(id => document.getElementById(id).value = '');
        ['modalPitchHandA','modalPitchHandB'].forEach(id => document.getElementById(id).value = '');
    }

    function confirmAddPitcher() {
        try { document.activeElement && document.activeElement.blur(); } catch(e) {}
        const teamIndex = parseInt(document.getElementById('modalTeamSelect').value);
        if (isNaN(teamIndex) || !allData.teams[teamIndex]) { alert('請先選擇場次！'); return; }

        const nameA = document.getElementById('modalPitcherNameA').value.trim();
        const numberA = document.getElementById('modalPitcherNumberA').value.trim();
        const handA = document.getElementById('modalPitchHandA').value;
        const roleA = document.getElementById('modalPitchRoleA').value;
        const styleA = document.getElementById('modalPitcherStyleA').value.trim();
        const nameB = document.getElementById('modalPitcherNameB').value.trim();
        const numberB = document.getElementById('modalPitcherNumberB').value.trim();
        const handB = document.getElementById('modalPitchHandB').value;
        const roleB = document.getElementById('modalPitchRoleB').value;
        const styleB = document.getElementById('modalPitcherStyleB').value.trim();

        if (!nameA) { alert('請輸入投手 A 姓名！'); return; }

        const pitcherA = { name: nameA, number: numberA, hand: handA, role: roleA, style: styleA, pitches: [], steals: [], score: getDefaultScore() };
        allData.teams[teamIndex].pitchers.push(pitcherA);

        if (nameB) {
            const pitcherB = { name: nameB, number: numberB, hand: handB, role: roleB, style: styleB, pitches: [], steals: [], score: getDefaultScore() };
            allData.teams[teamIndex].pitchers.push(pitcherB);
        }

        expandedTeams.add(teamIndex);
        // 同時展開該球隊所屬的賽事群組
        const gameName = allData.teams[teamIndex].gameName || '未分類';
        expandedGames.add(gameName);
        updateTeamList();
        saveToLocalStorage();
        saveToFirebase(teamIndex);
        closeAddPitcherModal();
        alert(`✅ 投手已新增！${nameB ? '（' + nameA + ' & ' + nameB + '）' : '（' + nameA + '）'}`);
    }

    function showSinglePitcherModal() {
        if (allData.teams.length === 0) { alert('請先新增球隊！'); return; }
        const select = document.getElementById('singleModalTeamSelect');
        select.innerHTML = '';
        allData.teams.forEach((team, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${team.name}${team.opponent ? ' vs ' + team.opponent : ''} ${team.date || ''}`;
            select.appendChild(option);
        });
        document.getElementById('singlePitcherModal').style.display = 'block';
    }

    function closeSinglePitcherModal() {
        document.getElementById('singlePitcherModal').style.display = 'none';
    }

    function confirmSinglePitcher() {
        try { document.activeElement && document.activeElement.blur(); } catch(e) {}
        const teamIndex = parseInt(document.getElementById('singleModalTeamSelect').value);
        if (isNaN(teamIndex) || !allData.teams[teamIndex]) { alert('請先選擇場次！'); return; }
        const name = document.getElementById('singlePitcherName').value.trim();
        const number = document.getElementById('singlePitcherNumber').value.trim();
        const hand = document.getElementById('singlePitchHand').value;
        const role = document.getElementById('singlePitcherRole').value;
        const style = document.getElementById('singlePitcherStyle').value.trim();
        if (!name) { alert('請輸入投手姓名！'); return; }
        allData.teams[teamIndex].pitchers.push({ name, number, hand, role, style, pitches: [], score: getDefaultScore() });
        expandedTeams.add(teamIndex);
        // 同時展開該球隊所屬的賽事群組
        const gameName = allData.teams[teamIndex].gameName || '未分類';
        expandedGames.add(gameName);
        updateTeamList();
        saveToLocalStorage();
        saveToFirebase(teamIndex);
        closeSinglePitcherModal();
        // 清空欄位
        document.getElementById('singlePitcherName').value = '';
        document.getElementById('singlePitcherNumber').value = '';
        document.getElementById('singlePitchHand').value = '';
        alert(`✅ 投手「${name}」已新增！`);
    }

    // ====== 編輯投手資訊 ======
    let _editPitcherTeamIdx = null;
    let _editPitcherIdx = null;

    function editPitcher(teamIndex, pitcherIndex) {
        const pitcher = allData.teams[teamIndex]?.pitchers?.[pitcherIndex];
        if (!pitcher) return;
        _editPitcherTeamIdx = teamIndex;
        _editPitcherIdx = pitcherIndex;
        document.getElementById('editPitcherName').value = pitcher.name || '';
        document.getElementById('editPitcherNumber').value = pitcher.number || '';
        document.getElementById('editPitcherHand').value = pitcher.hand || '';
        document.getElementById('editPitcherRole').value = pitcher.role || '先發';
        document.getElementById('editPitcherStyle').value = pitcher.style || '';
        document.getElementById('editPitcherModal').style.display = 'block';
    }

    function closeEditPitcherModal() {
        document.getElementById('editPitcherModal').style.display = 'none';
        _editPitcherTeamIdx = null;
        _editPitcherIdx = null;
    }

    function confirmEditPitcher() {
        try { document.activeElement && document.activeElement.blur(); } catch(e) {}
        if (_editPitcherTeamIdx === null || _editPitcherIdx === null) return;
        const pitcher = allData.teams[_editPitcherTeamIdx]?.pitchers?.[_editPitcherIdx];
        if (!pitcher) return;
        const name = document.getElementById('editPitcherName').value.trim();
        if (!name) { alert('請輸入投手姓名！'); return; }
        pitcher.name   = name;
        pitcher.number = document.getElementById('editPitcherNumber').value.trim();
        pitcher.hand   = document.getElementById('editPitcherHand').value;
        pitcher.role   = document.getElementById('editPitcherRole').value;
        pitcher.style  = document.getElementById('editPitcherStyle').value.trim();
        rebuildPitcherDB();
        updateTeamList();
        updateSlotDisplay();
        saveToLocalStorage();
        saveToFirebase(_editPitcherTeamIdx);
        closeEditPitcherModal();
    }

    // ====== TEAM LIST ======
    function toggleTeamExpand(teamIndex) {
        if (expandedTeams.has(teamIndex)) expandedTeams.delete(teamIndex);
        else expandedTeams.add(teamIndex);
        updateTeamList();
    }

    function updateTeamList() {
        const teamList = document.getElementById('teamList');
        teamList.innerHTML = '';
        if (allData.teams.length === 0) {
            teamList.innerHTML = '<p style="color:rgba(255,255,255,0.7);text-align:center;padding:16px;font-size:13px;">尚無球隊資料</p>';
            return;
        }

        // Group by gameName
        const gameGroups = {};
        allData.teams.forEach((team, teamIndex) => {
            const key = team.gameName || '未分類';
            if (!gameGroups[key]) gameGroups[key] = [];
            gameGroups[key].push({ team, teamIndex });
            // Only auto-expand on first load (if not already tracked)
            if (!expandedGames.has('__init_done__')) expandedGames.add(key);
        });
        expandedGames.add('__init_done__');

        Object.entries(gameGroups).forEach(([gameName, teams]) => {
            const isGameExpanded = expandedGames.has(gameName);
            const hasLive = teams.some(({teamIndex}) => slotA.team === teamIndex || slotB.team === teamIndex);

            const groupDiv = document.createElement('div');
            groupDiv.style.marginBottom = '6px';

            // Game header - clickable to expand/collapse
            const gameHeader = document.createElement('div');
            gameHeader.style.cssText = `
                display:flex;align-items:center;gap:6px;cursor:pointer;
                padding:7px 8px;border-radius:6px;
                background:${isGameExpanded ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.08)'};
                border:1px solid ${isGameExpanded ? 'rgba(255,215,0,0.5)' : 'rgba(255,255,255,0.1)'};
                -webkit-user-select:none;user-select:none;
            `;
            gameHeader.innerHTML = `
                <span style="font-size:11px;color:var(--ct-gold);transition:transform 0.2s;display:inline-block;transform:${isGameExpanded ? 'rotate(90deg)' : 'rotate(0)'}">▶</span>
                ${hasLive ? '<span class="live-badge">LIVE</span>' : ''}
                <span style="font-size:13px;font-weight:700;color:white;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🏟️ ${gameName}</span>
                <span style="font-size:10px;color:rgba(255,255,255,0.5);">${teams.length}隊</span>
            `;
            gameHeader.onclick = () => {
                if (expandedGames.has(gameName)) expandedGames.delete(gameName);
                else expandedGames.add(gameName);
                updateTeamList();
            };
            groupDiv.appendChild(gameHeader);

            // Teams inside game group
            if (isGameExpanded) {
                const teamsWrapper = document.createElement('div');
                teamsWrapper.style.cssText = 'margin-left:8px;margin-top:4px;';

                teams.forEach(({ team, teamIndex }) => {
                    const isLive = slotA.team === teamIndex || slotB.team === teamIndex;
                    const isExpanded = expandedTeams.has(teamIndex);

                    const teamDiv = document.createElement('div');
                    teamDiv.className = 'team-item' + (isExpanded ? ' expanded' : '') + (isLive ? ' live-scouting' : '');

                    // --- Team header ---
                    const teamHeader = document.createElement('div');
                    teamHeader.className = 'team-header';
                    teamHeader.addEventListener('click', () => toggleTeamExpand(teamIndex));

                    const headerLeft = document.createElement('div');
                    headerLeft.className = 'team-header-left';
                    const toggleIcon = document.createElement('span');
                    toggleIcon.className = 'team-toggle-icon';
                    toggleIcon.textContent = '▶';
                    headerLeft.appendChild(toggleIcon);
                    if (isLive) {
                        const liveBadge = document.createElement('span');
                        liveBadge.className = 'live-badge';
                        liveBadge.textContent = 'LIVE';
                        headerLeft.appendChild(liveBadge);
                    }
                    const teamName = document.createElement('span');
                    teamName.className = 'team-name';
                    teamName.textContent = team.name + (team.opponent ? ' vs ' + team.opponent.split(' ')[0] : '');
                    headerLeft.appendChild(teamName);
                    teamHeader.appendChild(headerLeft);

                    const deleteTeamBtn = document.createElement('button');
                    deleteTeamBtn.className = 'delete-team-btn';
                    deleteTeamBtn.textContent = '刪除';
                    deleteTeamBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTeam(teamIndex); });
                    teamHeader.appendChild(deleteTeamBtn);
                    teamDiv.appendChild(teamHeader);

                    // --- Team detail ---
                    const teamDetail = document.createElement('div');
                    teamDetail.className = 'team-detail';

                    if (team.date) {
                        const meta = document.createElement('div');
                        meta.className = 'team-meta';
                        meta.textContent = '📅 ' + formatDateFull(team.date);
                        teamDetail.appendChild(meta);
                    }

                    const pitcherTagsDiv = document.createElement('div');
                    pitcherTagsDiv.className = 'pitcher-tags';

                    if (team.pitchers.length === 0) {
                        const empty = document.createElement('small');
                        empty.style.cssText = 'color:rgba(255,255,255,0.6);font-size:11px;';
                        empty.textContent = '尚無投手';
                        pitcherTagsDiv.appendChild(empty);
                    } else {
                        team.pitchers.forEach((pitcher, pitcherIndex) => {
                            const isActive = (slotA.team === teamIndex && slotA.pitcher === pitcherIndex) ||
                                             (slotB.team === teamIndex && slotB.pitcher === pitcherIndex);

                            const tag = document.createElement('button');
                            tag.type = 'button';
                            tag.className = 'pitcher-tag' + (isActive ? ' active' : '');

                            const label = document.createTextNode(
                                pitcher.name +
                                (pitcher.number ? ' #' + pitcher.number : '') +
                                (pitcher.hand ? ' ' + pitcher.hand : '') +
                                (pitcher.role ? ' [' + pitcher.role + ']' : '') +
                                ' '
                            );
                            tag.appendChild(label);

                            const editBtn = document.createElement('span');
                            editBtn.className = 'pitcher-tag-edit';
                            editBtn.textContent = '✎';
                            editBtn.title = '編輯投手資訊';
                            editBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                editPitcher(teamIndex, pitcherIndex);
                            });
                            tag.appendChild(editBtn);

                            const delBtn = document.createElement('span');
                            delBtn.className = 'pitcher-tag-delete';
                            delBtn.textContent = '×';
                            delBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                deletePitcher(teamIndex, pitcherIndex);
                            });
                            tag.appendChild(delBtn);

                            tag.addEventListener('click', () => selectPitcherToSlot(teamIndex, pitcherIndex));

                            pitcherTagsDiv.appendChild(tag);
                        });
                    }

                    teamDetail.appendChild(pitcherTagsDiv);
                    teamDiv.appendChild(teamDetail);
                    teamsWrapper.appendChild(teamDiv);
                });
                groupDiv.appendChild(teamsWrapper);
            }

            teamList.appendChild(groupDiv);
        });
        // 同步更新打者模式場次列表（如果可見）
        if (typeof _renderBmSessionList === 'function') _renderBmSessionList();
    }

    function formatDateFull(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit' });
    }

    // ====== SLOT SYSTEM ======
    function activateSlot(slot) {
        activeSlot = slot;
        document.getElementById('slotA').classList.toggle('active-slot', slot === 'A');
        document.getElementById('slotB').classList.toggle('active-slot', slot === 'B');
        // Switch to the pitcher in that slot
        const s = slot === 'A' ? slotA : slotB;
        if (s.team !== null && s.pitcher !== null) {
            currentTeam = s.team;
            currentPitcher = s.pitcher;
            updatePitchLog();
            updateStats();
            updateScoreboard();
        }
        // 反向連動：手動點 A 槽 → 上半局（A 投）；點 B 槽 → 下半局（B 投）
        if (!_syncingSlotAndBatter) {
            const newHalf = slot === 'A' ? '上' : '下';
            gameState.half = newHalf;
            if (currentTeam !== null) {
                const score = getTeamScore();
                score.half = newHalf;
                updateScoreboard();
            }
            autoUpdateBatterInfoByInning();
        }
    }

    function selectPitcherToSlot(teamIndex, pitcherIndex) {
        // 放入目前 activeSlot
        if (activeSlot === 'A') {
            slotA = { team: teamIndex, pitcher: pitcherIndex };
        } else {
            slotB = { team: teamIndex, pitcher: pitcherIndex };
        }
        currentTeam = teamIndex;
        currentPitcher = pitcherIndex;
        statsFilter = 'all';
        _bmAnalysisTeamFilter   = null; // 切換賽事時重置篩選
        _bmAnalysisBatterFilter = null;
        expandedTeams.add(teamIndex);

        // 還原該賽事的打序（若曾儲存過）
        const _savedLineups = allData.teams[teamIndex]?.lineups;
        if (_savedLineups) {
            ['teamA','teamB'].forEach(side => {
                const arr = _savedLineups[side];
                if (!arr) return;
                const list = Array.isArray(arr) ? arr : Object.values(arr);
                list.forEach((p, i) => {
                    if (p) gameState.lineups[side][i + 1] = { number: p.number||'', name: p.name||'', hand: p.hand||'右打' };
                });
            });
            lineup = gameState.half === '上' ? gameState.lineups.teamA : gameState.lineups.teamB;
        }

        // 閃爍提示目前放入的 slot
        const slotEl = document.getElementById('slot' + activeSlot);
        if (slotEl) {
            slotEl.classList.add('auto-switch-highlight');
            setTimeout(() => slotEl.classList.remove('auto-switch-highlight'), 1000);
        }

        // 自動切換 activeSlot 到另一邊（只更新視覺，不改 currentTeam/currentPitcher）
        activeSlot = activeSlot === 'A' ? 'B' : 'A';
        document.getElementById('slotA').classList.toggle('active-slot', activeSlot === 'A');
        document.getElementById('slotB').classList.toggle('active-slot', activeSlot === 'B');

        // 同步 half 與 batter info：slot A 投→上半局對手打，slot B 投→下半局對手打
        gameState.half = activeSlot === 'A' ? '上' : '下';
        autoUpdateBatterInfoByInning();

        updateSlotDisplay();
        updatePitchLog();
        updateStats();
        updateScoreboard();
        saveToLocalStorage();

        // 若打者模式分頁正在顯示，同步更新
        if (userMode === 'batter') {
            const t = _bmState.tab;
            if (t === 'stats')           _renderBmStats();
            else if (t === 'batterdata') refreshBatterList();
        }

        setTimeout(() => {
            updateTeamList();
            if (window.innerWidth <= 1024) {
                const sidebar = document.getElementById('sidebar');
                const overlay = document.getElementById('sidebarOverlay');
                if (sidebar && sidebar.classList.contains('show')) {
                    sidebar.classList.remove('show');
                    if (overlay) overlay.classList.remove('show');
                }
            }
        }, 50);
    }

    function checkFatigue(pitches) {
        // Only pitches with speed recorded
        const withSpeed = pitches.filter(p => p.speed);
        if (withSpeed.length < 6) return null; // not enough data

        // Pitches from innings 1-2: estimate by pitch count (roughly <=30 pitches = first 2 innings)
        // Better: use score inning stored on pitch, but we don't have that.
        // Use first 30% of pitches as proxy for "first two innings"
        const earlyCount = Math.max(6, Math.floor(withSpeed.length * 0.3));
        const earlyPitches = withSpeed.slice(0, earlyCount);
        const earlyAvg = earlyPitches.reduce((s, p) => s + p.speed, 0) / earlyPitches.length;

        // Check last 3 pitches with speed
        const recent3 = withSpeed.slice(-3);
        if (recent3.length < 3) return null;
        const recentAvg = recent3.reduce((s, p) => s + p.speed, 0) / 3;

        if (earlyAvg - recentAvg >= 5) {
            return { earlyAvg: earlyAvg.toFixed(1), recentAvg: recentAvg.toFixed(1), drop: (earlyAvg - recentAvg).toFixed(1) };
        }
        return null;
    }

    function updateSlotDisplay() {
        const aHasPitcher = slotA.team !== null && slotA.pitcher !== null && allData.teams[slotA.team];
        const bHasPitcher = slotB.team !== null && slotB.pitcher !== null && allData.teams[slotB.team];
        const onlyOne = aHasPitcher !== bHasPitcher; // XOR: exactly one slot filled

        ['A','B'].forEach(slot => {
            const s = slot === 'A' ? slotA : slotB;
            const contentEl = document.getElementById('slot' + slot + 'Content');
            const slotEl = document.getElementById('slot' + slot);
            slotEl.classList.toggle('active-slot', activeSlot === slot);

            // Hide empty slot when only one pitcher is loaded
            const hasPitcher = slot === 'A' ? aHasPitcher : bHasPitcher;
            slotEl.style.display = (onlyOne && !hasPitcher) ? 'none' : '';

            if (s.team !== null && s.pitcher !== null && allData.teams[s.team]) {
                const team = allData.teams[s.team];
                const pitcher = team.pitchers[s.pitcher];
                if (pitcher) {
                    const isActive = activeSlot === slot;
                    // Slot A = 後攻隊 (away), Slot B = 先攻隊 (home)
                    const teamLabel = slot === 'A'
                        ? (team.opponent || team.name)
                        : team.name;

                    const fatigue = checkFatigue(pitcher.pitches);
                    const fatigueHTML = fatigue
                        ? `<div class="fatigue-alert" style="margin-top:6px;font-size:11px;padding:2px 8px;">⚠️ 球速下降 ${fatigue.earlyAvg}→${fatigue.recentAvg}</div>`
                        : '';

                    const metaBadges = [
                        pitcher.number ? `#${pitcher.number}` : null,
                        pitcher.hand || null,
                        pitcher.role || null,
                    ].filter(Boolean).map(t => `<span class="pitcher-slot-badge">${t}</span>`).join('');

                    const styleTag = pitcher.style
                        ? `<span class="pitcher-slot-type">${pitcher.style}</span>`
                        : '';

                    contentEl.innerHTML = `
                        ${isActive ? '<div class="active-indicator"></div>' : ''}
                        <div>
                            <div class="pitcher-slot-team">${teamLabel}</div>
                            <div class="pitcher-slot-name">${pitcher.name}</div>
                        </div>
                        <div>
                            <div class="pitcher-slot-meta">${metaBadges}${styleTag}</div>
                            <div class="pitcher-slot-count">${pitcher.pitches.length} 球記錄</div>
                            ${fatigueHTML}
                        </div>
                    `;
                    return;
                }
            }
            contentEl.innerHTML = '<span class="pitcher-slot-empty">點選左側投手選擇</span>';
        });
    }

    // ====== PITCHER MANAGEMENT ======
    function deleteTeam(teamIndex) {
        if (!confirm('確定要刪除此球隊及所有投手資料嗎？')) return;
        allData.teams.splice(teamIndex, 1);
        expandedTeams.delete(teamIndex);
        const newExpanded = new Set();
        expandedTeams.forEach(i => { if (i > teamIndex) newExpanded.add(i-1); else if (i < teamIndex) newExpanded.add(i); });
        expandedTeams = newExpanded;
        if (currentTeam === teamIndex) { currentTeam = null; currentPitcher = null; }
        else if (currentTeam > teamIndex) currentTeam--;
        if (slotA.team === teamIndex) slotA = { team: null, pitcher: null };
        else if (slotA.team > teamIndex) slotA.team--;
        if (slotB.team === teamIndex) slotB = { team: null, pitcher: null };
        else if (slotB.team > teamIndex) slotB.team--;
        updateTeamList();
        updateSlotDisplay();
        saveToLocalStorage();
    }

    function deletePitcher(teamIndex, pitcherIndex) {
        const pitcher = allData.teams[teamIndex].pitchers[pitcherIndex];
        if (!confirm(`確定要刪除投手「${pitcher.name}」嗎？`)) return;
        allData.teams[teamIndex].pitchers.splice(pitcherIndex, 1);
        if (currentTeam === teamIndex && currentPitcher === pitcherIndex) { currentTeam = null; currentPitcher = null; }
        else if (currentTeam === teamIndex && currentPitcher > pitcherIndex) currentPitcher--;
        // 同步修正 slotA / slotB 的投手索引
        if (slotA.team === teamIndex) {
            if (slotA.pitcher === pitcherIndex) slotA = { team: null, pitcher: null };
            else if (slotA.pitcher > pitcherIndex) slotA.pitcher--;
        }
        if (slotB.team === teamIndex) {
            if (slotB.pitcher === pitcherIndex) slotB = { team: null, pitcher: null };
            else if (slotB.pitcher > pitcherIndex) slotB.pitcher--;
        }
        updateTeamList(); updateSlotDisplay(); updateStats(); updatePitchLog(); saveToLocalStorage();
    }

    // ====== LINEUP MANAGEMENT ======
    // index 0 unused; 1-9 = batting order slots
    let lineup = gameState.lineups.teamB; // 預設上半局：B 隊打擊，autoUpdateBatterInfoByInning() 會動態切換

    // 依局數上下半判斷打擊隊名稱：上半局=先攻(team.name)打，下半局=後攻(team.opponent)打
    function getBattingTeamName() {
        const ti = currentTeam !== null ? currentTeam : (slotA.team !== null ? slotA.team : (slotB.team !== null ? slotB.team : null));
        if (ti === null) return null;
        const team = allData.teams[ti];
        if (!team) return null;
        return gameState.half === '上' ? (team.name || '先攻') : (team.opponent || '後攻');
    }

    function updateBattingTeamUI() {
        const ti = currentTeam !== null ? currentTeam : (slotA.team !== null ? slotA.team : (slotB.team !== null ? slotB.team : null));
        const team = ti !== null ? allData.teams[ti] : null;
        const awayBtn = document.getElementById('lineupBtnAway');
        const homeBtn = document.getElementById('lineupBtnHome');
        const title   = document.getElementById('lineupModalTitle');
        if (awayBtn) awayBtn.textContent = team?.name ? `📋 ${team.name}` : '📋 先攻';
        if (homeBtn) homeBtn.textContent = team?.opponent ? `📋 ${team.opponent}` : '📋 後攻';
        if (title)   title.textContent   = '📋 打擊順序設定';

        // 正在打擊的隊伍加金色外框（上半局＝先攻打；下半局＝後攻打）
        const isBattingAway = gameState.half === '上';
        if (awayBtn) {
            awayBtn.style.outline      = isBattingAway ? '3px solid #ffd700' : 'none';
            awayBtn.style.outlineOffset = isBattingAway ? '2px' : '0';
            awayBtn.style.boxShadow    = isBattingAway ? '0 0 8px rgba(255,215,0,0.7)' : 'none';
        }
        if (homeBtn) {
            homeBtn.style.outline      = !isBattingAway ? '3px solid #ffd700' : 'none';
            homeBtn.style.outlineOffset = !isBattingAway ? '2px' : '0';
            homeBtn.style.boxShadow    = !isBattingAway ? '0 0 8px rgba(255,215,0,0.7)' : 'none';
        }
    }

    function openLineupModal(side) {
        // side: 'teamA' (先攻/team.name) or 'teamB' (後攻/team.opponent); default to current batting team
        const targetSide = side || (gameState.half === '上' ? 'teamA' : 'teamB');
        lineup = gameState.lineups[targetSide];

        const ti = currentTeam !== null ? currentTeam : (slotA.team !== null ? slotA.team : (slotB.team !== null ? slotB.team : null));
        const team = ti !== null ? allData.teams[ti] : null;
        const teamName = targetSide === 'teamA'
            ? (team?.name || '先攻')
            : (team?.opponent || '後攻');

        const title = document.getElementById('lineupModalTitle');
        if (title) title.textContent = `📋 ${teamName} 打擊順序`;

        const container = document.getElementById('lineupRows');
        container.innerHTML = '';
        for (let i = 1; i <= 9; i++) {
            const p = lineup[i];
            const row = document.createElement('div');
            row.style.cssText = 'display:grid;grid-template-columns:44px 2fr 3fr 4fr;gap:6px;margin-bottom:8px;align-items:center;';
            row.innerHTML = `
                <div style="width:36px;height:36px;border-radius:50%;background:var(--ct-blue-dark);color:#ffd700;font-size:16px;font-weight:900;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;flex-shrink:0;">${i}</div>
                <input type="text" inputmode="numeric" placeholder="#" value="${p.number||''}" data-order="${i}" data-field="number"
                    style="padding:7px 4px;border:1.5px solid #d1d5db;border-radius:7px;font-size:13px;width:100%;box-sizing:border-box;text-align:center;"
                    onkeydown="if(event.key==='Enter')this.blur()">
                <select data-order="${i}" data-field="hand"
                    style="padding:7px 4px;border:1.5px solid #d1d5db;border-radius:7px;font-size:13px;width:100%;box-sizing:border-box;text-align:center;">
                    <option value="右打" ${p.hand==='右打'?'selected':''}>右打</option>
                    <option value="左打" ${p.hand==='左打'?'selected':''}>左打</option>
                </select>
                <input type="text" placeholder="姓名" value="${p.name||''}" data-order="${i}" data-field="name"
                    style="padding:7px 6px;border:1.5px solid #d1d5db;border-radius:7px;font-size:13px;width:100%;box-sizing:border-box;"
                    onkeydown="if(event.key==='Enter')this.blur()">` ;
            container.appendChild(row);
        }
        const modal = document.getElementById('lineupModal');
        modal.style.display = 'flex';
    }

    function closeLineupModal() {
        document.getElementById('lineupModal').style.display = 'none';
    }

    function saveLineup() {
        document.querySelectorAll('#lineupRows [data-order]').forEach(el => {
            const i = parseInt(el.dataset.order);
            lineup[i][el.dataset.field] = el.value;
        });
        closeLineupModal();
        // Auto-fill current batter if order is set
        const order = parseInt(document.getElementById('batterOrder').value);
        if (order >= 1 && order <= 9) applyLineupToUI(order);
        // ★ 聯動模式：打擊順序 Modal 儲存後同步到打者側欄
        if (_bmState.recMode === 'linked') {
            const savedSide = (lineup === gameState.lineups.teamA) ? 'A' : 'B';
            const bmTeam = (allData.bm && allData.bm.attackingTeam) || 'B';
            if (savedSide === bmTeam) {
                _syncGameStateToBmLineup(bmTeam);
            }
        }
        // ★ 將打序儲存到賽事資料（重開 app 後可還原）
        if (currentTeam !== null && allData.teams[currentTeam]) {
            if (!allData.teams[currentTeam].lineups) allData.teams[currentTeam].lineups = {};
            const side = (lineup === gameState.lineups.teamA) ? 'teamA' : 'teamB';
            // lineup 是 1-indexed；存成 0-indexed array 方便讀取
            allData.teams[currentTeam].lineups[side] = lineup.slice(1).map(p => p ? {...p} : {number:'',name:'',hand:'右打'});
            saveToLocalStorage();
            saveToFirebase(currentTeam);
        }
    }

    function applyLineupToUI(order) {
        const p = lineup[order];
        if (!p) return;
        if (p.number) document.getElementById('batterNumber').value = p.number;
        if (p.name) document.getElementById('batterName').value = p.name;
        document.querySelectorAll('.hand-btn').forEach(b => b.classList.toggle('active', b.dataset.hand === p.hand));
        currentPitch.batterHand = p.hand;
    }

    // ====== BATTER AUTO-FILL ======
    function autofillBatterNumber() {}

    // ====== 雙隊打序智慧連動 ======
    // 防止 activateSlot ↔ autoUpdateBatterInfoByInning 互相觸發的遞迴保護旗標
    let _syncingSlotAndBatter = false;

    /**
     * 依當前 gameState.half 自動切換 activeSlot，並從 gameState.lineups 填入打者資訊。
     * 上半局：A 隊投（slot A）、A 隊打 → 讀 lineups.teamA[currentBatterIndex.teamA]（teamA = team.name 先攻）
     * 下半局：B 隊投（slot B）、B 隊打 → 讀 lineups.teamB[currentBatterIndex.teamB]（teamB = team.opponent 後攻）
     */
    function autoUpdateBatterInfoByInning() {
        if (_syncingSlotAndBatter) return;
        _syncingSlotAndBatter = true;

        const half = gameState.half;
        const targetSlot  = half === '上' ? 'A' : 'B';
        const battingTeam = half === '上' ? 'teamA' : 'teamB';

        // 切換 slot（避免呼叫 activateSlot 造成遞迴，直接操作 DOM 與狀態）
        if (activeSlot !== targetSlot) {
            activeSlot = targetSlot;
            document.getElementById('slotA').classList.toggle('active-slot', targetSlot === 'A');
            document.getElementById('slotB').classList.toggle('active-slot', targetSlot === 'B');
            const s = targetSlot === 'A' ? slotA : slotB;
            if (s.team !== null && s.pitcher !== null) {
                currentTeam    = s.team;
                currentPitcher = s.pitcher;
                updatePitchLog();
                updateStats();
                updateScoreboard();
            }
        }

        // 將 lineup 參考指向當前打擊隊，讓打序 Modal 也連動
        lineup = gameState.lineups[battingTeam];
        updateBattingTeamUI();

        // 計算本次打者的棒次（0-based index → 1-based order）
        const batterOrder = gameState.currentBatterIndex[battingTeam] + 1;
        document.getElementById('batterOrder').value = batterOrder;

        // 優先從 lineups 填入打者資料
        const batterData = gameState.lineups[battingTeam][batterOrder];
        if (batterData && (batterData.number || batterData.name)) {
            document.getElementById('batterNumber').value = batterData.number || '';
            document.getElementById('batterName').value   = batterData.name   || '';
            document.querySelectorAll('.hand-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.hand === batterData.hand));
            currentPitch.batterHand = batterData.hand || '右打';
        } else {
            // fallback：從「正確 slot 的投手」pitch history 找打者
            // 不能用 currentTeam（可能指向對方投手，導致換局後撈到舊隊打者）
            const ts = targetSlot === 'A' ? slotA : slotB;
            let found = false;
            if (ts.team !== null && ts.pitcher !== null) {
                const pitches = allData.teams[ts.team]?.pitchers[ts.pitcher]?.pitches || [];
                for (let i = pitches.length - 1; i >= 0; i--) {
                    if (String(pitches[i].batterOrder) === String(batterOrder) && pitches[i].batterNumber) {
                        document.getElementById('batterNumber').value = pitches[i].batterNumber || '';
                        document.getElementById('batterName').value   = pitches[i].batterName  || '';
                        const hand = pitches[i].batterHand || '右打';
                        document.querySelectorAll('.hand-btn').forEach(b =>
                            b.classList.toggle('active', b.dataset.hand === hand));
                        currentPitch.batterHand = hand;
                        found = true;
                        break;
                    }
                }
            }
            if (!found) {
                document.getElementById('batterNumber').value = '';
                document.getElementById('batterName').value   = '';
            }
        }

        _syncingSlotAndBatter = false;
    }

    function togglePinchHitter() {
        const cb = document.getElementById('isPinchHitter');
        const btn = document.getElementById('pinchHitterBtn');
        cb.checked = !cb.checked;
        if (cb.checked) {
            btn.style.background = 'var(--ct-red)';
            btn.style.color = 'white';
            btn.style.borderColor = 'var(--ct-gold)';
            btn.textContent = '✅ 代打上場';
        } else {
            btn.style.background = '#fff3cd';
            btn.style.color = 'var(--ct-blue-dark)';
            btn.style.borderColor = 'var(--ct-gold)';
            btn.textContent = '代打上場';
        }
    }

    // ====== PITCH RECORDING ======
    function selectBatterHand(btn) {
        document.querySelectorAll('.hand-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPitch.batterHand = btn.dataset.hand;
        // 手動調整慣用手時，同步回寫 lineup，下一輪不用再調
        const order = parseInt(document.getElementById('batterOrder').value);
        if (order >= 1 && order <= 9 && lineup[order]) {
            lineup[order].hand = btn.dataset.hand;
        }
    }

    function selectPitch(btn) {
        document.querySelectorAll('.pitch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPitch.type = btn.dataset.pitch;
    }

    function selectZone(zone) {
        document.querySelectorAll('.zone-cell').forEach(cell => cell.classList.remove('selected'));
        document.querySelector(`[data-zone="${zone}"]`).classList.add('selected');
        currentPitch.zone = zone;

        // Auto-determine result from zone
        const isStrike = !String(zone).startsWith('B');
        if (currentPitch.foul || currentPitch.swing) {
            // Foul/swing overrides to strike
            currentPitch.result = '好球';
        } else {
            currentPitch.result = isStrike ? '好球' : '壞球';
        }
        updateAutoResultDisplay();
        updateZoneCountDisplay();
    }

    function updateAutoResultDisplay() {
        const el = document.getElementById('autoResultDisplay');
        if (!currentPitch.result) {
            el.className = 'pitch-result-display-value none-result';
            el.textContent = '請選擇投球位置';
            return;
        }
        if (currentPitch.foul) {
            el.className = 'pitch-result-display-value strike-result';
            el.textContent = '🚫 界外球（好球）';
        } else if (currentPitch.swing) {
            el.className = 'pitch-result-display-value strike-result';
            el.textContent = '💨 揮空（好球）';
        } else if (currentPitch.result === '好球') {
            el.className = 'pitch-result-display-value strike-result';
            el.textContent = '✓ 好球';
        } else {
            el.className = 'pitch-result-display-value ball-result';
            el.textContent = '✗ 壞球';
        }
    }

    function updateZoneCountDisplay() {
        document.getElementById('zoneCountDisplay').textContent = `${gameState.balls}B - ${gameState.strikes}S`;
    }

    function setSpeed(speed, btn) {
        document.getElementById('pitchSpeed').value = speed;
        document.getElementById('currentSpeed').textContent = speed;
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        currentPitch.speed = speed;
    }

    function toggleFoul(btn) {
        currentPitch.foul = !currentPitch.foul;
        btn.classList.toggle('active');
        if (currentPitch.foul) {
            currentPitch.swing = false;
            document.getElementById('swingBtn').classList.remove('active');
            // Foul: allow zone selection freely (攻擊壞球也算界外)
            // result determined by 2-strike rule when recording
            currentPitch.result = '好球';
        } else {
            // Revert result based on zone
            if (currentPitch.zone) {
                currentPitch.result = !String(currentPitch.zone).startsWith('B') ? '好球' : '壞球';
            } else {
                currentPitch.result = null;
            }
        }
        updateAutoResultDisplay();
        updateZoneCountDisplay();
    }

    function toggleSwing(btn) {
        currentPitch.swing = !currentPitch.swing;
        btn.classList.toggle('active');
        if (currentPitch.swing) {
            currentPitch.foul = false;
            document.getElementById('foulBtn').classList.remove('active');
            currentPitch.result = '好球';
        }
        updateAutoResultDisplay();
    }

    function toggleWild(btn) {
        currentPitch.wild = !currentPitch.wild;
        btn.classList.toggle('active');
    }

    function togglePassball(btn) {
        currentPitch.passball = !currentPitch.passball;
        btn.classList.toggle('active');
    }

    const OUT_OUTCOMES = ['滾地球出局','飛球出局','平飛球出局','三振','趁傳出局','雙殺','出局','高飛犧牲打','犧牲觸擊'];
    // 打席結束（進入下一打者）的結果清單
    const PA_ENDING = ['滾地球出局','飛球出局','平飛球出局','高飛犧牲打','犧牲觸擊','三振','不死三振',
        '內野安打','一壘安打','二壘安打','三壘安打','全壘打','保送','觸身球','野選','趁傳出局','失誤','違規打擊','Push'];
    // 球有進場（落點有意義）的打席結果
    const BALL_IN_PLAY_OUTCOMES = ['滾地球出局','飛球出局','平飛球出局','高飛犧牲打','犧牲觸擊','雙殺',
        '內野安打','一壘安打','二壘安打','三壘安打','全壘打','野選','失誤'];

    function toggleOutcome(btn) {
        const resultGroups = ['out-btn', 'hit-btn', 'reach-btn'];
        const clickedGroup = resultGroups.find(c => btn.classList.contains(c));

        // 點擊出局/安打/上壘任一組時，取消其他兩組的所有已選項（三組互斥）
        if (clickedGroup && !btn.classList.contains('selected')) {
            resultGroups.filter(c => c !== clickedGroup).forEach(c => {
                document.querySelectorAll(`.outcome-btn.${c}.selected`)
                    .forEach(b => b.classList.remove('selected'));
            });
        }

        btn.classList.toggle('selected');
        currentPitch.outcomes = Array.from(document.querySelectorAll('.outcome-btn.selected')).map(b => b.dataset.outcome);
        // 不在此修改 gameState，避免雙重計算；由 recordPitch → updateGameStateFromPitch 統一處理
    }

    // ====== RECORD PITCH ======
    function recordPitch(btn) {
        if (currentTeam === null || currentPitcher === null) { alert('請先選擇球隊和投手！'); return; }
        if (!currentPitch.batterHand) { alert('請選擇打者慣用手！'); return; }
        if (!currentPitch.type) { alert('請選擇球種！'); return; }
        if (!currentPitch.zone) { alert('請選擇投球位置！'); return; }
        if (!currentPitch.result) { alert('投球結果未判定，請選擇投球位置！'); return; }

        if (btn) { btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 280); }

        const batterNumber = document.getElementById('batterNumber').value;
        const batterOrder = document.getElementById('batterOrder').value;
        const isPinch = document.getElementById('isPinchHitter').checked;
        currentPitch.batterNumber = batterNumber || null;
        currentPitch.batterOrder = batterOrder || null;
        currentPitch.pinchHit = isPinch;

        // 從打序表查詢打者姓名；若打序表無姓名，退而讀取 UI 輸入欄位
        const _battingTeam = gameState.half === '上' ? 'teamA' : 'teamB';
        const _bOrderIdx = (parseInt(batterOrder) || 1) - 1;
        const _lineupEntry = gameState.lineups[_battingTeam][Math.max(0, _bOrderIdx)];
        const _domBatterName = (document.getElementById('batterName')?.value || '').trim();
        currentPitch.batterName = (_lineupEntry && _lineupEntry.name)
            ? _lineupEntry.name.trim()
            : _domBatterName;

        const speedVal = document.getElementById('pitchSpeed').value;
        const speedParsed = parseInt(speedVal);
        currentPitch.speed = (!isNaN(speedParsed) && speedParsed > 0) ? speedParsed : null;
        currentPitch.note = document.getElementById('pitchNote').value.trim() || null;
        currentPitch.timestamp = new Date().toISOString();
        currentPitch.basesSnapshot = [...gameState.bases]; // [1b, 2b, 3b]
        currentPitch.runnersOn = gameState.bases.some(b => b);
        currentPitch.half = gameState.half; // 上/下，用於打者分頁判斷哪隊在打擊
        // ★ 記錄打者所屬隊伍（上半局 = teamA/team.name 打擊；下半局 = teamB/opponent 打擊）
        const _teamObj = allData.teams[currentTeam];
        currentPitch.batterTeam = _battingTeam === 'teamA'
            ? (_teamObj?.name || '')
            : (_teamObj?.opponent || '');

        // Compute count before this pitch
        const prev = allData.teams[currentTeam].pitchers[currentPitcher].pitches;
        const countBefore = computeCountBefore(prev, batterNumber, batterOrder);
        currentPitch.balls = countBefore.balls;
        currentPitch.strikes = countBefore.strikes;

        // For legacy compatibility, set outcome as primary outcome
        currentPitch.outcome = currentPitch.outcomes.length > 0 ? currentPitch.outcomes[0] : null;

        allData.teams[currentTeam].pitchers[currentPitcher].pitches.push({...currentPitch});

        // 接近 localStorage 容量時提醒備份（10MB 上限，超過 7MB 時警告）
        const dataStr = JSON.stringify(allData);
        const dataMB = dataStr.length / (1024 * 1024);
        if (dataMB > 7) {
            const w = document.getElementById('lsWarning');
            if (w) {
                w.style.display = 'block';
                w.textContent = `⚠️ 本機儲存已用 ${dataMB.toFixed(1)}MB（上限 10MB），建議點「備份數據」下載後清理舊場次資料`;
            }
        }

        // Sync to pitcherDB (cumulative across games)
        const pitcher = allData.teams[currentTeam].pitchers[currentPitcher];
        syncPitchToDB({...currentPitch}, currentTeam, pitcher.name, pitcher.number);

        // Update game state counts
        const _prePitchHalf = gameState.half; // 捕捉此球投出時的局半，供得分確認使用
        updateGameStateFromPitch(currentPitch);

        // 打席結束 → 推進打者、更新連動
        const hasEndingOutcome = currentPitch.outcomes.some(o => PA_ENDING.includes(o));
        if (hasEndingOutcome) {
            // 推進「投球前」那半局的打擊隊棒次（換局時 gameState.half 已翻面，要用 _prePitchHalf）
            const battingTeam = _prePitchHalf === '上' ? 'teamA' : 'teamB';
            gameState.currentBatterIndex[battingTeam] =
                (gameState.currentBatterIndex[battingTeam] + 1) % 9;

            const curOrder = parseInt(batterOrder) || 0;
            if (curOrder >= 1 && curOrder <= 9) {
                const nextOrder = curOrder >= 9 ? 1 : curOrder + 1;
                document.getElementById('batterOrder').value = nextOrder;
            }
            gameState.strikes = 0;
            gameState.balls = 0;
            renderCountLights();
            // 從 lineups 填入下一棒（若有）；否則從投球歷史填入
            autoUpdateBatterInfoByInning();
        }
        _syncPitcherToBmLinked();

        updateSlotDisplay();
        updatePitchLog();
        updateStats();
        saveToLocalStorage();
        saveToFirebase(currentTeam);

        // 紀錄此球資訊，供球場圖模式 + 得分確認使用（reset 前先存）
        const _bipOutcomes = [...currentPitch.outcomes];
        const _bipTeam = currentTeam;
        const _bipPitcher = currentPitcher;
        const _bipIdx = allData.teams[currentTeam].pitchers[currentPitcher].pitches.length - 1;
        const _preBasesSnapshot = allData.teams[_bipTeam].pitchers[_bipPitcher].pitches[_bipIdx].basesSnapshot || [false, false, false];
        const _hasBIP = _bipOutcomes.some(o => BALL_IN_PLAY_OUTCOMES.includes(o));
        const _hasRunners = _preBasesSnapshot.some(b => b);
        const _autoRuns = (_hasBIP && _hasRunners) ? applyBaseRunning(_preBasesSnapshot, _bipOutcomes).runsScored : 0;
        const _autoBases = [...gameState.bases]; // post-advance bases from updateGameStateFromPitch
        const _isBunt = _bipOutcomes.includes('犧牲觸擊');
        if (_isBunt) window._pendingBuntCtx = { autoBases: _autoBases };
        else window._pendingBuntCtx = null;

        document.querySelectorAll('.pitch-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.zone-cell').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.outcome-btn').forEach(b => b.classList.remove('selected'));
        ['foulBtn','swingBtn','wildBtn','passballBtn'].forEach(id => document.getElementById(id)?.classList.remove('active'));
        document.getElementById('pitchSpeed').value = '';
        document.getElementById('currentSpeed').textContent = '--';
        document.getElementById('pitchNote').value = '';
        document.getElementById('autoResultDisplay').className = 'pitch-result-display-value none-result';
        document.getElementById('autoResultDisplay').textContent = '請選擇投球位置';

        currentPitch = {
            type: null, zone: null, speed: null, result: null,
            batterHand: currentPitch.batterHand,
            batterNumber: document.getElementById('batterNumber').value,
            batterOrder: document.getElementById('batterOrder').value,
            outcomes: [], outcome: null, wild: false, foul: false, swing: false, passball: false, pinchHit: false
        };

        // 得分確認 chip helper（球場圖結束後 or 直接觸發）
        const _maybeShowRunsChip = () => {
            if (_hasRunners && _hasBIP) {
                showRunsChip({
                    bipTeam: _bipTeam, bipPitcher: _bipPitcher, bipIdx: _bipIdx,
                    autoRuns: _autoRuns, preBasesSnapshot: _preBasesSnapshot,
                    half: _prePitchHalf
                });
                // bunt modal will fire from closeRunsChip if _pendingBuntCtx is set
            } else if (window._pendingBuntCtx) {
                const ctx = window._pendingBuntCtx;
                window._pendingBuntCtx = null;
                showBuntBasesModal(ctx);
            }
        };

        // 球場圖模式：球有進場結果 → 落點選擇，結束後接得分確認
        if (fieldMapEnabled && _hasBIP) {
            showHitLocationModal(function(loc) {
                if (loc && allData.teams[_bipTeam] &&
                        allData.teams[_bipTeam].pitchers[_bipPitcher] &&
                        allData.teams[_bipTeam].pitchers[_bipPitcher].pitches[_bipIdx]) {
                    allData.teams[_bipTeam].pitchers[_bipPitcher].pitches[_bipIdx].hitLocation = loc;
                    rebuildPitcherDB();
                    saveToLocalStorage();
                    saveToFirebase(_bipTeam);
                    updatePitchLog();
                    updateStats();
                }
                _maybeShowRunsChip(); // 球場圖 → 得分確認
            });
        } else {
            _maybeShowRunsChip(); // 直接進得分確認
        }
    }

    function adjustBatterOrder(delta) {
        const el = document.getElementById('batterOrder');
        const cur = parseInt(el.value) || 0;
        const next = cur + delta;
        const clamped = next < 1 ? 9 : next > 9 ? 1 : next;
        el.value = clamped;
        // 手動調整時同步更新 gameState 棒次索引，防止 autoUpdateBatterInfoByInning 蓋回去
        const battingTeam = gameState.half === '上' ? 'teamA' : 'teamB';
        gameState.currentBatterIndex[battingTeam] = clamped - 1;
        autoFillBatterFromOrder(clamped);
    }

    function syncBatterOrderToState(val) {
        const order = parseInt(val);
        if (isNaN(order) || order < 1 || order > 9) return;
        const battingTeam = gameState.half === '上' ? 'teamA' : 'teamB';
        gameState.currentBatterIndex[battingTeam] = order - 1;
        autoFillBatterFromOrder(order);
    }

    function autoFillBatterFromOrder(order) {
        // Priority 1: lineup pre-set data
        const lp = lineup[order];
        if (lp && (lp.number || lp.name)) {
            applyLineupToUI(order);
            return;
        }
        // Priority 2: most recent pitch history for this order
        if (currentTeam === null || currentPitcher === null) return;
        const pitches = allData.teams[currentTeam].pitchers[currentPitcher].pitches;
        for (let i = pitches.length - 1; i >= 0; i--) {
            if (String(pitches[i].batterOrder) === String(order) && pitches[i].batterNumber) {
                document.getElementById('batterNumber').value = pitches[i].batterNumber;
                if (pitches[i].batterName) document.getElementById('batterName').value = pitches[i].batterName;
                const hand = pitches[i].batterHand;
                document.querySelectorAll('.hand-btn').forEach(b => b.classList.toggle('active', b.dataset.hand === hand));
                currentPitch.batterHand = hand;
                return;
            }
        }
        document.getElementById('batterNumber').value = '';
        document.getElementById('batterName').value = '';
    }

    // ====== 壘包位移引擎 ======
    // bases = [1b, 2b, 3b] boolean array
    // returns { newBases, runsScored }
    // 跑者身份追蹤：比照 applyBaseRunning 邏輯，同步移動 gameState.runners
    function _advanceRunners(outcomes, oldBases, batter) {
        const r = [...gameState.runners];
        const has1b = oldBases[0], has2b = oldBases[1], has3b = oldBases[2];
        if (outcomes.includes('全壘打')) {
            gameState.runners = [null, null, null]; return;
        }
        if (outcomes.some(o => o === '三壘安打')) {
            gameState.runners = [null, null, batter]; return;
        }
        if (outcomes.some(o => o === '二壘安打')) {
            gameState.runners = [null, batter, has1b ? r[0] : null]; return;
        }
        if (outcomes.some(o => o === '一壘安打' || o === '內野安打')) {
            gameState.runners = [batter, has1b ? r[0] : null, has2b ? r[1] : null]; return;
        }
        if (outcomes.some(o => ['保送','觸身球','故意四壞'].includes(o))) {
            if (has1b && has2b && has3b) gameState.runners = [batter, r[0], r[1]];
            else if (has1b && has2b)     gameState.runners = [batter, r[0], r[1]];
            else if (has1b)              gameState.runners = [batter, r[0], r[2]];
            else                         gameState.runners = [batter, r[1], r[2]];
            return;
        }
        if (outcomes.includes('高飛犧牲打')) {
            gameState.runners = [r[0], r[1], null]; return;
        }
        if (outcomes.includes('犧牲觸擊')) {
            gameState.runners = [null, has1b ? r[0] : null, has2b ? r[1] : null]; return;
        }
        if (outcomes.some(o => ['不死三振','野選','失誤'].includes(o))) {
            gameState.runners = [batter, r[1], r[2]]; return;
        }
        // 出局類：runners 不動，三出局時由外層清空
    }

    function applyBaseRunning(bases, outcomes) {
        let b = [...bases]; // copy
        let runs = 0;

        const has1b = b[0], has2b = b[1], has3b = b[2];

        if (outcomes.includes('全壘打')) {
            runs = 1 + (has1b ? 1 : 0) + (has2b ? 1 : 0) + (has3b ? 1 : 0);
            return { newBases: [false, false, false], runsScored: runs };
        }

        if (outcomes.some(o => o === '三壘安打')) {
            runs += (has1b ? 1 : 0) + (has2b ? 1 : 0) + (has3b ? 1 : 0);
            return { newBases: [false, false, true], runsScored: runs };
        }

        if (outcomes.some(o => o === '二壘安打')) {
            runs += (has3b ? 1 : 0) + (has2b ? 1 : 0);
            // Runner on 1b advances to 3rd (aggressive) or 2nd (conservative) - use 3rd
            return { newBases: [false, true, has1b], runsScored: runs };
        }

        if (outcomes.some(o => o === '一壘安打' || o === '內野安打')) {
            runs += (has3b ? 1 : 0);
            // 2b→scores if aggressive; standard: 2b→3rd, 1b→2nd, batter→1st
            const new3b = has2b; // 2b advances to 3rd
            const new2b = has1b; // 1b advances to 2nd
            const new1b = true;  // batter on 1st
            // if 3b scored already counted; 2b→3rd
            return { newBases: [new1b, new2b, new3b], runsScored: runs };
        }

        if (outcomes.some(o => o === '保送' || o === '觸身球')) {
            // 強迫進壘（只在有人在一壘時才連動後壘）
            if (has1b && has2b && has3b) { runs = 1; return { newBases: [true, true, true], runsScored: runs }; }
            if (has1b && has2b)          { return { newBases: [true, true, true], runsScored: 0 }; }
            if (has1b)                   { return { newBases: [true, true, has3b], runsScored: 0 }; }
            return { newBases: [true, has2b, has3b], runsScored: 0 };
        }

        if (outcomes.includes('高飛犧牲打')) {
            // 打者出局，三壘跑者得分
            runs = has3b ? 1 : 0;
            return { newBases: [has1b, has2b, false], runsScored: runs };
        }

        if (outcomes.includes('犧牲觸擊')) {
            // 打者出局，所有跑者前進一壘
            runs = has3b ? 1 : 0;
            return { newBases: [false, has1b, has2b], runsScored: runs };
        }

        if (outcomes.includes('不死三振')) {
            // 打者跑向一壘（接捕手未接好），壘上跑者不強迫推進
            return { newBases: [true, has2b, has3b], runsScored: 0 };
        }

        // 出局 — 壘包不變（滿壘雙殺、飛球等），由3出局邏輯清壘
        return { newBases: b, runsScored: 0 };
    }

    function updateGameStateFromPitch(pitch) {
        if (pitch.foul) {
            if (gameState.strikes < 2) gameState.strikes++;
        } else if (pitch.swing) {
            if (gameState.strikes < 2) gameState.strikes++;
        } else if (pitch.result === '好球') {
            if (gameState.strikes < 2) gameState.strikes++;
        } else if (pitch.result === '壞球') {
            if (gameState.balls < 3) gameState.balls++;
        }

        const outcomes = pitch.outcomes && pitch.outcomes.length > 0 ? pitch.outcomes : (pitch.outcome ? [pitch.outcome] : []);
        const isOut = outcomes.some(o => OUT_OUTCOMES.includes(o));
        const isDoublePlay = outcomes.includes('雙殺');
        const isPA  = outcomes.some(o => ['一壘安打','二壘安打','三壘安打','全壘打','內野安打',
            '保送','觸身球','野選','失誤','不死三振','Push'].includes(o));

        if (isOut) {
            gameState.outs += isDoublePlay ? 2 : 1;
            gameState.strikes = 0; gameState.balls = 0;
            if (gameState.outs >= 3) {
                // 三出局換局：自動觸發，重置計數與壘包
                if (currentTeam !== null) {
                    const score = getTeamScore();
                    score.half = score.half === '上' ? '下' : '上';
                    if (score.half === '上') score.inning = Math.min(20, score.inning + 1);
                    gameState.half = score.half;
                }
                gameState.outs = 0;
                gameState.bases = [false, false, false];
                gameState.runners = [null, null, null];
                gameState.strikes = 0; gameState.balls = 0;
                renderCountLights(); renderBases();
                updateScoreboard();
                // 換局後自動切換 slot 並更新打者資訊
                autoUpdateBatterInfoByInning();
            }
        } else if (isPA) {
            gameState.strikes = 0; gameState.balls = 0;
            // Apply base running + auto score
            const _oldBases = [...gameState.bases];
            const { newBases, runsScored: autoRuns } = applyBaseRunning(gameState.bases, outcomes);
            gameState.bases = newBases;
            _advanceRunners(outcomes, _oldBases, {
                number: pitch.batterNumber || null,
                order:  parseInt(pitch.batterOrder) || 0,
                name:   pitch.batterName   || null
            });
            // 優先使用使用者確認過的得分（pitch.runsScored），舊資料無此欄則退回算法值
            const runsScored = (pitch.runsScored !== undefined && pitch.runsScored !== null)
                ? pitch.runsScored : autoRuns;
            if (runsScored > 0 && currentTeam !== null) {
                const score = getTeamScore();
                // Determine which side scores (away = top half, home = bottom half)
                if (gameState.half === '上') score.away = (score.away || 0) + runsScored;
                else score.home = (score.home || 0) + runsScored;
                updateScoreboard();
            }
            renderBases();
        }
        renderCountLights();
        updateZoneCountDisplay();
    }

    // ====== 從所有投球紀錄重新計算 gameState（用於刪除/編輯後回溯）======
    function recomputeGameState() {
        const score = getTeamScore();
        // Reset all live state except inning (keep inning from score)
        gameState.strikes = 0;
        gameState.balls = 0;
        gameState.outs = 0;
        gameState.bases   = [false, false, false];
        gameState.runners = [null, null, null];
        gameState.half = score.half || '上';
        gameState.inning = score.inning || 1;
        // Also reset score runs to 0 then recount
        score.home = 0;
        score.away = 0;
        score.inning = 1;
        score.half = '上';
        gameState.inning = 1;
        gameState.half = '上';

        if (currentTeam === null || currentPitcher === null) return;
        const pitches = allData.teams[currentTeam].pitchers[currentPitcher].pitches;
        pitches.forEach(p => updateGameStateFromPitch(p));

        renderCountLights();
        renderBases();
        updateScoreboard();
        updateZoneCountDisplay();
    }

    function stealBase(success) {
        // 找出最前面的跑者（盜壘者）
        let leadIdx = -1;
        if      (gameState.bases[2]) leadIdx = 2;
        else if (gameState.bases[1]) leadIdx = 1;
        else if (gameState.bases[0]) leadIdx = 0;

        // ── 記錄盜壘事件 ──
        if (leadIdx >= 0 && currentTeam !== null && currentPitcher !== null) {
            const pitcher = allData.teams[currentTeam]?.pitchers[currentPitcher];
            if (pitcher) {
                if (!pitcher.steals) pitcher.steals = [];
                const runner = gameState.runners[leadIdx];
                // 嘗試從 lineup 補名字
                let runnerName = runner?.name || null;
                if (!runnerName && runner?.order) {
                    const battingTeam = gameState.half === '上' ? 'teamA' : 'teamB';
                    const le = gameState.lineups[battingTeam]?.[runner.order];
                    if (le?.name) runnerName = le.name;
                }
                const toBase = leadIdx === 2 ? 'H' : leadIdx + 2;
                pitcher.steals.push({
                    number:   runner?.number || null,
                    order:    runner?.order  || null,
                    name:     runnerName,
                    fromBase: leadIdx + 1,
                    toBase,
                    success,
                    inning:   gameState.inning,
                    half:     gameState.half,
                    outs:     gameState.outs,
                    balls:    gameState.balls,    // 盜壘當下球數
                    strikes:  gameState.strikes,  // 盜壘當下好球數
                    ts:       Date.now()
                });
                saveToLocalStorage();
                saveToFirebase(currentTeam);
            }
        }

        // ── 移動壘包與 runners ──
        if (success) {
            if (leadIdx === 2) {
                gameState.bases[2] = false;
                gameState.runners[2] = null;
            } else if (leadIdx === 1) {
                gameState.bases[1] = false; gameState.bases[2] = true;
                gameState.runners[2] = gameState.runners[1]; gameState.runners[1] = null;
            } else if (leadIdx === 0) {
                gameState.bases[0] = false; gameState.bases[1] = true;
                gameState.runners[1] = gameState.runners[0]; gameState.runners[0] = null;
            }
        } else {
            if (leadIdx >= 0) {
                gameState.bases[leadIdx] = false;
                gameState.runners[leadIdx] = null;
            }
            gameState.outs++;
            if (gameState.outs >= 3) {
                gameState.outs = 0;
                gameState.bases   = [false, false, false];
                gameState.runners = [null, null, null];
                if (gameState.half === '上') { gameState.half = '下'; }
                else { gameState.half = '上'; gameState.inning = Math.min(20, gameState.inning + 1); }
                if (currentTeam !== null) {
                    const score = getTeamScore();
                    score.half = gameState.half;
                    score.inning = gameState.inning;
                }
                updateScoreboard();
            }
        }
        renderBases();
        renderCountLights();
    }

    function advanceLeadRunner() {
        if (gameState.bases[2]) {
            gameState.bases[2] = false; // 三壘跑者得分
        } else if (gameState.bases[1]) {
            gameState.bases[1] = false;
            gameState.bases[2] = true;
        } else if (gameState.bases[0]) {
            gameState.bases[0] = false;
            gameState.bases[1] = true;
        }
        renderBases();
    }

    // ====== GAME STATE - Count & Bases ======
    function renderCountLights() {
        for (let i = 0; i < 2; i++) {
            const el = document.getElementById('s' + i);
            if (el) el.classList.toggle('strike-on', i < gameState.strikes);
        }
        for (let i = 0; i < 3; i++) {
            const el = document.getElementById('b' + i);
            if (el) el.classList.toggle('ball-on', i < gameState.balls);
        }
        for (let i = 0; i < 2; i++) {
            const el = document.getElementById('o' + i);
            if (el) el.classList.toggle('out-on', i < gameState.outs);
        }
    }

    function toggleBase(base) {
        gameState.bases[base - 1] = !gameState.bases[base - 1];
        renderBases();
    }

    function adjustCount(type, lightIndex) {
        // lightIndex = which light was clicked (0-based)
        // If the clicked light is ON → turn it off (decrement to lightIndex)
        // If the clicked light is OFF → turn it on (increment to lightIndex+1)
        const max = type === 'strikes' ? 2 : type === 'balls' ? 3 : 2;
        const current = gameState[type] || 0;
        const clickedIsOn = lightIndex < current;
        if (clickedIsOn) {
            // click on lit light → reduce to that index
            gameState[type] = lightIndex;
        } else {
            // click on unlit light → set to lightIndex+1
            gameState[type] = Math.min(lightIndex + 1, max);
        }
        renderCountLights();
        updateZoneCountDisplay();
    }

    function renderBases() {
        document.getElementById('base1b').classList.toggle('on', gameState.bases[0]);
        document.getElementById('base2b').classList.toggle('on', gameState.bases[1]);
        document.getElementById('base3b').classList.toggle('on', gameState.bases[2]);
    }

    // ====== COUNT ======
    function computeCountBefore(pitches, batterNumber, batterOrder) {
        let balls = 0, strikes = 0;
        for (let i = pitches.length - 1; i >= 0; i--) {
            const p = pitches[i];
            if (p.outcome || (p.outcomes && p.outcomes.length > 0)) break;
            if (p.batterNumber !== batterNumber || p.batterOrder !== batterOrder) break;
            if (p.result === '壞球') balls++;
            else if (p.result === '好球' || p.result === '揮空') strikes++;
        }
        return { balls: Math.min(balls, 3), strikes: Math.min(strikes, 2) };
    }

    function undoLast() {
        if (currentTeam === null || currentPitcher === null) return;
        const pitches = allData.teams[currentTeam].pitchers[currentPitcher].pitches;
        if (pitches.length > 0) {
            pitches.pop();
            recomputeGameState();
            updateSlotDisplay(); updatePitchLog(); updateStats(); saveToLocalStorage();
        }
    }

    function clearCurrentPitcher() {
        if (currentTeam === null || currentPitcher === null) return;
        if (confirm('確定要清除當前投手的所有記錄嗎？')) {
            allData.teams[currentTeam].pitchers[currentPitcher].pitches = [];
            Object.assign(gameState, { strikes:0, balls:0, outs:0, bases:[false,false,false], runners:[null,null,null], half:'上', inning:1, currentBatterIndex:{ teamA:0, teamB:0 } });
            renderCountLights(); renderBases();
            updateSlotDisplay(); updatePitchLog(); updateStats(); saveToLocalStorage();
        }
    }

    // ====== PITCH LOG ======
    function updatePitchLog() {
        const logDiv = document.getElementById('pitchLog');
        logDiv.innerHTML = '';
        if (currentTeam === null || currentPitcher === null) {
            document.getElementById('totalPitches').textContent = '0'; return;
        }
        const pitches = allData.teams[currentTeam].pitchers[currentPitcher].pitches;
        let lastBatterKey = null;
        pitches.slice().reverse().forEach((pitch, revIndex) => {
            const index = pitches.length - 1 - revIndex;
            const outcomes = pitch.outcomes && pitch.outcomes.length > 0 ? pitch.outcomes : (pitch.outcome ? [pitch.outcome] : []);

            // 打席分隔線：當打者或棒次改變時插入
            const batterKey = `${pitch.batterOrder}-${pitch.batterNumber}`;
            if (lastBatterKey !== null && batterKey !== lastBatterKey) {
                const div = document.createElement('hr');
                div.className = 'pa-divider';
                logDiv.appendChild(div);
            }
            lastBatterKey = batterKey;

            const record = document.createElement('div');
            record.className = 'pitch-record';
            const resultColor = pitch.result === '好球' ? '#92400e' : pitch.result === '壞球' ? '#065f46' : 'var(--ct-blue-dark)';
            const batterInfo = `${pitch.batterHand || ''}${pitch.batterNumber ? ' #'+pitch.batterNumber : ''}${pitch.batterOrder ? ' ('+pitch.batterOrder+'棒)' : ''}${pitch.pinchHit ? ' 代打' : ''}`;
            const extras = [];
            if (pitch.foul) extras.push('界外球');
            if (pitch.swing) extras.push('揮空');
            if (pitch.wild) extras.push('⚠️暴投');

            // 用 DOM 操作而非 innerHTML，確保按鈕事件在各裝置正常運作
            record.innerHTML = `
                <div class="pitch-record-header">
                    <div style="flex:1;min-width:0;overflow:hidden;">
                        <strong style="color:${resultColor}">#${index+1}</strong>
                        ${batterInfo} | <strong>${pitch.type || '-'}</strong> | 位置:${pitch.zone}
                        ${pitch.speed ? ' | <strong style="color:var(--ct-red);">'+pitch.speed+'</strong>' : ''}
                        | <strong style="color:${resultColor}">${pitch.result}</strong>
                        ${extras.length ? ' <span style="color:#c2410c;font-weight:700;">'+extras.join(' ')+'</span>' : ''}
                    </div>
                    <div class="pitch-record-actions" style="flex-shrink:0;">
                    </div>
                </div>
                ${outcomes.length ? `<div class="pitch-record-details">打擊結果: <strong style="color:var(--ct-red);">${outcomes.join('、')}</strong></div>` : ''}
                ${pitch.note ? `<div class="pitch-record-details" style="color:#6b7280;">📝 ${pitch.note}</div>` : ''}
                <div class="pitch-record-details" style="font-size:11px;color:#9ca3af;">${pitch.balls !== undefined ? pitch.balls+'B-'+pitch.strikes+'S' : ''} ${pitch.timestamp ? new Date(pitch.timestamp).toLocaleTimeString('zh-TW') : ''}</div>
            `;
            // 用 addEventListener 確保行動裝置按鈕不會失效
            const actions = record.querySelector('.pitch-record-actions');
            const editBtn = document.createElement('button');
            editBtn.className = 'edit-btn';
            editBtn.textContent = '✏️';
            editBtn.addEventListener('click', () => openEditModal(index));
            const delBtn = document.createElement('button');
            delBtn.className = 'delete-btn';
            delBtn.textContent = '刪除';
            delBtn.addEventListener('click', () => deletePitch(index));
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            logDiv.appendChild(record);
        });
        document.getElementById('totalPitches').textContent = pitches.length;
    }

    function deletePitch(index) {
        if (confirm('確定要刪除這筆記錄嗎？')) {
            allData.teams[currentTeam].pitchers[currentPitcher].pitches.splice(index, 1);
            recomputeGameState();
            updateSlotDisplay(); updatePitchLog(); updateStats(); saveToLocalStorage();
        }
    }

    // ====== EDIT PITCH MODAL ======
    function openEditModal(index) {
        editingPitchIndex = index;
        const pitch = allData.teams[currentTeam].pitchers[currentPitcher].pitches[index];
        const pitchTypes = ['快速球','上飄球','下墜球','變速球','內曲','外曲'];
        const outcomes = pitch.outcomes && pitch.outcomes.length > 0 ? pitch.outcomes : (pitch.outcome ? [pitch.outcome] : []);
        const allOutcomes = ['滾地球出局','飛球出局','平飛球出局','高飛犧牲打','三振','不死三振','內野安打','一壘安打','二壘安打','三壘安打','全壘打','保送','野選','Push','趁傳出局','內野失誤','外野失誤','違規打擊'];

        document.getElementById('editPitchForm').innerHTML = `
            <div class="input-group"><label>球種</label>
                <select id="editType">
                    ${pitchTypes.map(t => `<option value="${t}" ${pitch.type===t?'selected':''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="input-group"><label>球速</label>
                <input type="number" id="editSpeed" value="${pitch.speed||''}" placeholder="球速">
            </div>
            <div class="input-group"><label>投球位置 (例: 1 或 B3)</label>
                <input type="text" id="editZone" value="${pitch.zone||''}">
            </div>
            <div class="input-group"><label>打者手</label>
                <select id="editHand">
                    <option value="左打" ${pitch.batterHand==='左打'?'selected':''}>左打</option>
                    <option value="右打" ${pitch.batterHand==='右打'?'selected':''}>右打</option>
                </select>
            </div>
            <div class="input-group"><label>背號</label>
                <input type="text" id="editBatterNum" value="${pitch.batterNumber||''}">
            </div>
            <div class="input-group"><label>棒次</label>
                <input type="number" id="editBatterOrder" value="${pitch.batterOrder||''}" min="1" max="9">
            </div>
            <div class="input-group"><label>打擊結果（可複選）</label>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
                ${allOutcomes.map(o => `<button type="button" class="outcome-btn ${outcomes.includes(o)?'selected':''}" data-outcome="${o}" onclick="this.classList.toggle('selected')" style="font-size:12px;padding:8px 4px;">${o}</button>`).join('')}
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px;">
                <button type="button" id="editFoulBtn"
                    onclick="toggleEditFlag('editFoulBtn','editFoul')"
                    style="padding:10px 6px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:2px solid #9333ea;background:${pitch.foul?'#9333ea':'white'};color:${pitch.foul?'white':'#7c3aed'};">
                    🚫 界外球
                </button>
                <button type="button" id="editSwingBtn"
                    onclick="toggleEditFlag('editSwingBtn','editSwing')"
                    style="padding:10px 6px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:2px solid var(--ct-blue);background:${pitch.swing?'var(--ct-blue-dark)':'white'};color:${pitch.swing?'white':'var(--ct-blue-dark)'};">
                    💨 揮空
                </button>
                <button type="button" id="editWildBtn"
                    onclick="toggleEditFlag('editWildBtn','editWild')"
                    style="padding:10px 6px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:2px solid #f97316;background:${pitch.wild?'#f97316':'white'};color:${pitch.wild?'white':'#c2410c'};">
                    ⚠️ 暴投
                </button>
            </div>
            <input type="hidden" id="editFoul" value="${pitch.foul?'1':'0'}">
            <input type="hidden" id="editSwing" value="${pitch.swing?'1':'0'}">
            <input type="hidden" id="editWild" value="${pitch.wild?'1':'0'}">
        `;
        document.getElementById('editPitchModal').style.display = 'block';
    }

    function toggleEditFlag(btnId, hiddenId) {
        const btn = document.getElementById(btnId);
        const hidden = document.getElementById(hiddenId);
        const isOn = hidden.value === '1';
        hidden.value = isOn ? '0' : '1';
        // Toggle visual
        if (btnId === 'editFoulBtn') {
            btn.style.background = !isOn ? '#9333ea' : 'white';
            btn.style.color = !isOn ? 'white' : '#7c3aed';
        } else if (btnId === 'editSwingBtn') {
            btn.style.background = !isOn ? 'var(--ct-blue-dark)' : 'white';
            btn.style.color = !isOn ? 'white' : 'var(--ct-blue-dark)';
        } else if (btnId === 'editWildBtn') {
            btn.style.background = !isOn ? '#f97316' : 'white';
            btn.style.color = !isOn ? 'white' : '#c2410c';
        }
    }

    function closeEditModal() {
        document.getElementById('editPitchModal').style.display = 'none';
        editingPitchIndex = null;
    }

    function saveEditedPitch() {
        if (editingPitchIndex === null) return;
        const pitch = allData.teams[currentTeam].pitchers[currentPitcher].pitches[editingPitchIndex];
        const zone = document.getElementById('editZone').value.trim();
        const isStrike = !zone.startsWith('B');
        const foul = document.getElementById('editFoul').value === '1';
        const swing = document.getElementById('editSwing').value === '1';
        pitch.type = document.getElementById('editType').value;
        pitch.speed = parseInt(document.getElementById('editSpeed').value) || null;
        pitch.zone = zone;
        pitch.batterHand = document.getElementById('editHand').value;
        pitch.batterNumber = document.getElementById('editBatterNum').value || null;
        pitch.batterOrder = document.getElementById('editBatterOrder').value || null;
        pitch.foul = foul;
        pitch.swing = swing;
        pitch.wild = document.getElementById('editWild').value === '1';
        pitch.result = (foul || swing) ? '好球' : (isStrike ? '好球' : '壞球');
        const selectedOutcomes = Array.from(document.querySelectorAll('#editPitchForm .outcome-btn.selected')).map(b => b.dataset.outcome);
        pitch.outcomes = selectedOutcomes;
        pitch.outcome = selectedOutcomes[0] || null;
        recomputeGameState();
        updatePitchLog(); updateStats(); saveToLocalStorage();
        closeEditModal();
    }

    // ====== SCOREBOARD ======
    function getTeamScore() {
        // Score stored at team level, shared across all pitchers in same game
        if (currentTeam === null) return getDefaultScore();
        const team = allData.teams[currentTeam];
        if (!team.score) team.score = getDefaultScore();
        return team.score;
    }

    function updateScoreboard() {
        if (currentTeam === null || currentPitcher === null) {
            document.getElementById('scoreHome').textContent = '0';
            document.getElementById('scoreAway').textContent = '0';
            document.getElementById('scoreInning').textContent = '1';
            document.getElementById('halfDisplay').textContent = '▲ 上半';
            document.getElementById('scoreHomeLabel').textContent = '先攻';
            document.getElementById('scoreAwayLabel').textContent = '後攻';
            document.getElementById('scoreMeta').textContent = '選擇投手後記錄即時比分';
            return;
        }
        const team = allData.teams[currentTeam];
        const score = getTeamScore();
        document.getElementById('scoreHome').textContent = score.home;
        document.getElementById('scoreAway').textContent = score.away;
        document.getElementById('scoreInning').textContent = score.inning;
        document.getElementById('halfDisplay').textContent = score.half === '上' ? '▲ 上半' : '▼ 下半';
        document.getElementById('scoreHomeLabel').textContent = team.name || '先攻';
        document.getElementById('scoreAwayLabel').textContent = team.opponent ? team.opponent.split(' ')[0] : '後攻';
        const diff = score.home - score.away;
        document.getElementById('scoreMeta').textContent =
            `${score.inning}局${score.half}半 ｜ ${diff>0?'領先 '+diff:diff<0?'落後 '+(-diff):'平手'}`;
    }

    function adjustScore(side, delta) {
        if (currentTeam === null) { alert('請先選擇投手！'); return; }
        const score = getTeamScore();
        score[side] = Math.max(0, score[side] + delta);
        updateScoreboard(); saveToLocalStorage();
    }

    function adjustInning(delta) {
        if (currentTeam === null) { alert('請先選擇投手！'); return; }
        const score = getTeamScore();
        score.inning = Math.max(1, Math.min(20, score.inning + delta));
        // 只更新顯示，不重置 gameState（手動修正不影響球數/出局數）
        updateScoreboard(); saveToLocalStorage();
    }

    // isManual=true 時僅更新顯示，不重置球數/壘包（比賽中有太多不確定因素）
    function toggleHalf(isManual = false) {
        if (currentTeam === null) { alert('請先選擇投手！'); return; }
        const score = getTeamScore();
        score.half = score.half === '上' ? '下' : '上';
        gameState.half = score.half;
        if (!isManual) {
            // 自動換局（3出局觸發）：重置計數
            gameState.outs = 0; gameState.strikes = 0; gameState.balls = 0;
            gameState.bases   = [false, false, false];
            gameState.runners = [null, null, null];
            renderCountLights(); renderBases();
        }
        updateScoreboard(); saveToLocalStorage();
        // 換局後自動切換 slot 並更新打者資訊
        autoUpdateBatterInfoByInning();
    }

    // ====== STATS FILTER ======
    function onFilterChange(val) {
        statsFilter = val;
        updateStats();
    }

    function populateFilterDropdown() {
        const sel = document.getElementById('statsFilterSelect');
        if (!sel || currentTeam === null || currentPitcher === null) return;
        const games = getAvailableGames(currentTeam, currentPitcher);
        const current = sel.value;
        sel.innerHTML = '<option value="all">📊 生涯總計</option>';
        games.forEach(([gk, label]) => {
            const opt = document.createElement('option');
            opt.value = gk;
            opt.textContent = '🎯 ' + label;
            sel.appendChild(opt);
        });
        sel.value = statsFilter;
    }

    // ====== STATS ======
    function updateStats() {
        if (currentTeam === null || currentPitcher === null) {
            ['statTotal','statStrike','statBall','statSwing','statWild','statAvgSpeed','statMaxSpeed'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = id.includes('Strike')||id.includes('Ball')||id.includes('Swing')||id.includes('Wild') ? '0%' : '0';
            });
            const infoEl = document.getElementById('statsPitcherInfo');
            if (infoEl) infoEl.style.display = 'none';
            return;
        }

        // 更新投手資訊欄
        const _p = allData.teams[currentTeam]?.pitchers[currentPitcher];
        const _t = allData.teams[currentTeam];
        const infoEl = document.getElementById('statsPitcherInfo');
        if (infoEl && _p) {
            document.getElementById('spName').textContent =
                [_p.number ? '#' + _p.number : '', _p.name].filter(Boolean).join('  ');
            document.getElementById('spMeta').textContent =
                [_p.hand, _p.role, _p.style].filter(Boolean).join(' · ');
            document.getElementById('spGame').textContent =
                [_t?.gameName, _t?.name, _t?.opponent ? 'vs ' + _t.opponent : '', _t?.date].filter(Boolean).join('　');
            infoEl.style.display = 'block';
        }

        populateFilterDropdown();
        const pitches = getFilteredPitches(currentTeam, currentPitcher);
        const total = pitches.length;
        const strikes = pitches.filter(p => p.result === '好球').length;
        const balls = pitches.filter(p => p.result === '壞球').length;
        const swings = pitches.filter(p => p.swing || p.result === '揮空').length;
        const wilds = pitches.filter(p => p.wild).length;
        const speeds = pitches.filter(p => p.speed).map(p => p.speed);
        const avgSpeed = speeds.length > 0 ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : 0;
        const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;

        document.getElementById('statTotal').textContent = total;
        document.getElementById('statStrike').textContent = total > 0 ? ((strikes/total)*100).toFixed(1)+'%' : '0%';
        document.getElementById('statBall').textContent = total > 0 ? ((balls/total)*100).toFixed(1)+'%' : '0%';
        document.getElementById('statSwing').textContent = total > 0 ? ((swings/total)*100).toFixed(1)+'%' : '0%';
        document.getElementById('statWild').textContent = total > 0 ? ((wilds/total)*100).toFixed(1)+'%' : '0%';
        document.getElementById('statAvgSpeed').textContent = avgSpeed;
        document.getElementById('statMaxSpeed').textContent = maxSpeed;

        updateBatterStats(pitches);
        updatePitchTypeStats(pitches);
        updateHeatmap(pitches);
        updateTendencyMaps(pitches);
        updatePatternAnalysis(pitches);
        updateCountAnalysis(pitches);
        updatePitchEffectiveness(pitches);
        updateOutcomeStats(pitches);
        updateInnerOuterTable(pitches);
        updateFirstPitchAnalysis(pitches);
        updateTwoStrikeAnalysis(pitches);
        updateBaseStateAnalysis(pitches);
        // Charts
        updatePitchTypePieChart(pitches);
        updatePatternPieChart(pitches);
        updateSpeedLineChart(pitches);
        // Right-panel heatmaps (analysis split layout)
        updateSingleHeatmap('tendencyStrikeRight', pitches.filter(p => p.result==='好球' && !String(p.zone).startsWith('B')), 'yellow');
        updateBallTendencyHeatmap('tendencyBallRight', pitches.filter(p => p.result==='壞球'));
    }

    function updateBatterStats(pitches) {
        const calcSide = (sp) => {
            const total = sp.length;
            const strikes = sp.filter(p => p.result === '好球').length;
            const hits = sp.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打')||o==='全壘打'))).length;
            const atBats = sp.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打')||o==='全壘打'||o.includes('出局')||o==='三振'))).length;
            const ks = sp.filter(p => (p.outcomes||[p.outcome]).some(o => o==='三振'||o==='不死三振')).length;
            return { total, strikes, hits, atBats, ks };
        };
        const L = calcSide(pitches.filter(p => p.batterHand === '左打'));
        const R = calcSide(pitches.filter(p => p.batterHand === '右打'));
        document.getElementById('leftPitches').textContent = L.total;
        document.getElementById('leftStrikeRate').textContent = L.total > 0 ? ((L.strikes/L.total)*100).toFixed(1)+'%' : '0%';
        document.getElementById('leftHits').textContent = L.hits;
        document.getElementById('leftBattingAvg').textContent = L.atBats > 0 ? (L.hits/L.atBats).toFixed(3) : '.000';
        document.getElementById('leftStrikeouts').textContent = L.ks;
        document.getElementById('rightPitches').textContent = R.total;
        document.getElementById('rightStrikeRate').textContent = R.total > 0 ? ((R.strikes/R.total)*100).toFixed(1)+'%' : '0%';
        document.getElementById('rightHits').textContent = R.hits;
        document.getElementById('rightBattingAvg').textContent = R.atBats > 0 ? (R.hits/R.atBats).toFixed(3) : '.000';
        document.getElementById('rightStrikeouts').textContent = R.ks;
    }

    function updatePitchTypeStats(pitches) {
        const statsDiv = document.getElementById('pitchTypeStats');
        statsDiv.innerHTML = '';
        const usedTypes = PITCH_ORDER.filter(t => pitches.some(p => p.type === t));
        if (usedTypes.length === 0) {
            statsDiv.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:16px;">尚無球種記錄</p>';
            const canvas = document.getElementById('statsTypePieChart');
            if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); }
            if (statsTypePieInstance) { statsTypePieInstance.destroy(); statsTypePieInstance = null; }
            return;
        }
        usedTypes.forEach((type) => {
            const count = pitches.filter(p => p.type === type).length;
            const pct = pitches.length > 0 ? ((count/pitches.length)*100).toFixed(1) : 0;
            const color = PITCH_COLORS[type] || '#999';
            const item = document.createElement('div');
            item.className = 'pattern-item';
            item.innerHTML = `<span style="font-size:17px;font-weight:900;color:${color};font-family:'Oswald','Noto Sans TC',sans-serif;">${type}</span><span style="color:var(--ct-red);font-weight:700;">${count} 球 (${pct}%)</span>`;
            statsDiv.appendChild(item);
        });
        // pie chart
        const canvas = document.getElementById('statsTypePieChart');
        if (canvas) {
            const counts = usedTypes.map(t => pitches.filter(p => p.type === t).length);
            const colors = usedTypes.map(t => PITCH_COLORS[t] || '#999');
            if (statsTypePieInstance) { statsTypePieInstance.destroy(); statsTypePieInstance = null; }
            statsTypePieInstance = _makeDoughnut(canvas, usedTypes, counts, colors, pitches.length);
        }
    }

    // ====== HEATMAP ======
    function colorForIntensity(intensity, mode) {
        if (mode === 'yellow') {
            // 好球帶：淺橘 → 深橘，數字全黑
            if (intensity <= 0) return ['#f5f5f0','#bbb'];
            if (intensity <= 0.2)  return ['#fde8c8','#000'];
            if (intensity <= 0.4)  return ['#fdd09a','#000'];
            if (intensity <= 0.6)  return ['#fdb96a','#000'];
            if (intensity <= 0.8)  return ['#f99832','#000'];
            return ['#e67a00','#000'];
        }
        if (mode === 'green') {
            // 壞球區：淺綠 → 深綠，數字全黑
            if (intensity <= 0) return ['#f0f5f0','#bbb'];
            if (intensity <= 0.2)  return ['#d4edda','#000'];
            if (intensity <= 0.4)  return ['#9dd4ab','#000'];
            if (intensity <= 0.6)  return ['#5cb87a','#000'];
            if (intensity <= 0.8)  return ['#2e9e52','#000'];
            return ['#1a7a3a','#000'];
        }
        // fallback: unified heatmap uses zone type instead
        if (intensity <= 0) return ['#f5f5f0','#bbb'];
        if (intensity <= 0.33) return ['#fde8c8','#000'];
        if (intensity <= 0.66) return ['#fdb96a','#000'];
        return ['#e67a00','#000'];
    }

    function updateSingleHeatmap(elementId, pitches, mode) {
        const heatmap = document.getElementById(elementId);
        if (!heatmap) return;
        heatmap.innerHTML = '';
        const zoneCounts = {};
        for (let i = 1; i <= 9; i++) zoneCounts[i] = 0;
        pitches.forEach(p => {
            const z = String(p.zone);
            if (!z.startsWith('B') && p.zone >= 1 && p.zone <= 9) zoneCounts[p.zone]++;
        });
        const maxCount = Math.max(...Object.values(zoneCounts), 1);
        for (let i = 1; i <= 9; i++) {
            const cell = document.createElement('div');
            cell.className = 'heat-cell';
            const count = zoneCounts[i];
            const [bg,fg] = colorForIntensity(count === 0 ? 0 : count/maxCount, mode);
            cell.style.background = bg; cell.style.color = '#000';
            cell.textContent = count; cell.style.fontWeight = '700';
            heatmap.appendChild(cell);
        }
    }

    // Ball zone heatmap (B1-B16 in 6x5 visual layout)
    // Layout rows: [B1,B2,B3,B4,B5,B6], [B7,1,2,3,B8,-], [B9,4,5,6,B10,-], [B11,7,8,9,B12,-], [B13,B14,B15,B16,-,-]
    function updateBallHeatmap(elementId, pitches) {
        const heatmap = document.getElementById(elementId);
        if (!heatmap) return;
        heatmap.innerHTML = '';
        const bCounts = {};
        for (let i = 1; i <= 16; i++) bCounts['B'+i] = 0;
        pitches.forEach(p => {
            const z = String(p.zone);
            if (z.startsWith('B') && bCounts[z] !== undefined) bCounts[z]++;
        });
        const maxCount = Math.max(...Object.values(bCounts), 1);
        // 6x5 layout: row1=B1-B6, row2=B7,inner1-3,B8,empty, row3=B9,inner4-6,B10,empty, row4=B11,inner7-9,B12,empty, row5=B13-B16,empty,empty
        const layout = [
            ['B1','B2','B3','B4','B5','B6'],
            ['B7','S1','S2','S3','B8',''],
            ['B9','S4','S5','S6','B10',''],
            ['B11','S7','S8','S9','B12',''],
            ['B13','B14','B15','B16','','']
        ];
        layout.forEach(row => {
            row.forEach(cell => {
                const div = document.createElement('div');
                if (!cell) { div.className = 'ball-heat-cell'; div.style.background = 'transparent'; div.style.border = 'none'; heatmap.appendChild(div); return; }
                if (cell.startsWith('S')) {
                    div.className = 'ball-heat-cell inner'; div.textContent = '';
                } else {
                    div.className = 'ball-heat-cell';
                    const count = bCounts[cell] || 0;
                    const [bg,fg] = colorForIntensity(count === 0 ? 0 : count/maxCount, 'green');
                    div.style.background = bg; div.style.color = '#000';
                    div.style.fontSize = '10px';
                    div.innerHTML = `<span style="position:absolute;top:1px;left:2px;font-size:8px;color:rgba(0,0,0,0.4);">${cell.replace('B','')}</span>${count}`;
                    div.style.position = 'relative';
                }
                heatmap.appendChild(div);
            });
        });

        // Update side info
        const ballList = document.getElementById('ballCommonList');
        if (ballList) {
            const sorted = Object.entries(bCounts).sort((a,b) => b[1]-a[1]).filter(e => e[1]>0).slice(0,5);
            ballList.innerHTML = sorted.map(([z,c]) => `<div class="heatmap-side-row"><span>${z}</span><span style="font-weight:700;color:var(--ct-green);">${c}</span></div>`).join('') || '-';
        }
    }

    function updateHeatmap(pitches) {
        // Unified 5x5 heatmap with all pitches
        const el = document.getElementById('heatmapUnified');
        if (!el) return;
        el.innerHTML = '';
        // Count all zones
        const allCounts = {};
        const strikeCounts = {};
        for (let i=1;i<=9;i++) { allCounts[i]=0; strikeCounts[i]=0; }
        for (let i=1;i<=16;i++) allCounts['B'+i]=0;
        pitches.forEach(p => {
            const z = String(p.zone);
            if (z.startsWith('B')) { if (allCounts[z]!==undefined) allCounts[z]++; }
            else if (p.zone>=1&&p.zone<=9) { allCounts[p.zone]++; if (p.result==='好球') strikeCounts[p.zone]++; }
        });
        // Build 5x5 grid same layout as input zone
        const layout = [
            ['B1','B2','B3','B4','B5','B6'],  // top row - but 5x5 only 5 cols
        ];
        // Use same 5x5 layout as the input grid
        const cells5x5 = ['B1','B2','B3','B4','B5','B6',
                           '1','2','3','B7','B8',
                           '4','5','6','B9','B10',
                           '7','8','9','B11','B12',
                           'B13','B14','B15','B16',''];
        const maxVal = Math.max(...Object.values(allCounts), 1);
        cells5x5.forEach(z => {
            const cell = document.createElement('div');
            cell.className = 'zone-cell';
            if (!z) { cell.style.background='transparent'; cell.style.border='none'; el.appendChild(cell); return; }
            const isStrike = z && !z.startsWith('B');
            cell.classList.add(isStrike ? 'strike-zone' : 'ball-zone');
            const count = allCounts[z]||0;
            const intensity = count/maxVal;
            const mode = isStrike ? 'yellow' : 'green';
            const [bg,fg] = colorForIntensity(count===0?0:intensity, mode);
            cell.style.background = bg; cell.style.color = '#000';
            cell.style.fontWeight = '700';
            cell.innerHTML = `<span class="zone-label">${z}</span>${count||''}`;
            el.appendChild(cell);
        });
        // Common positions list
        const listEl = document.getElementById('heatmapCommonList');
        if (listEl) {
            const allEntries = Object.entries(allCounts).filter(e=>e[1]>0).sort((a,b)=>b[1]-a[1]).slice(0,8);
            listEl.innerHTML = allEntries.map(([z,c])=>`<div class="heatmap-rank-item"><span class="heatmap-rank-zone" style="color:${z.startsWith('B')?'#065f46':'#92400e'};">${z}</span><span class="heatmap-rank-count">${c}</span></div>`).join('') || '<span style="color:#9ca3af;font-size:13px;">尚無資料</span>';
        }
    }

    // ====== TENDENCY MAPS ======
    function updateTendencyMaps(pitches) {
        updateSingleHeatmap('tendencyStrike', pitches.filter(p => p.result==='好球' && !String(p.zone).startsWith('B')), 'yellow');
        updateBallTendencyHeatmap('tendencyBall', pitches.filter(p => p.result==='壞球'));

        // Tips
        const sCounts = {};
        for (let i=1;i<=9;i++) sCounts[i]=0;
        pitches.filter(p=>p.result==='好球'&&!String(p.zone).startsWith('B')).forEach(p=>{if(p.zone>=1&&p.zone<=9)sCounts[p.zone]++;});
        const topStrike = Object.entries(sCounts).sort((a,b)=>b[1]-a[1]).filter(e=>e[1]>0).slice(0,2);
        document.getElementById('strikeZoneTip').textContent = topStrike.length ? '好球常用: ' + topStrike.map(e=>'位置'+e[0]+'('+e[1]+')').join(', ') : '尚無資料';

        const bCounts={};
        for(let i=1;i<=16;i++) bCounts['B'+i]=0;
        pitches.filter(p=>p.result==='壞球').forEach(p=>{const z=String(p.zone);if(z.startsWith('B')&&bCounts[z]!==undefined)bCounts[z]++;});
        const topBall = Object.entries(bCounts).sort((a,b)=>b[1]-a[1]).filter(e=>e[1]>0).slice(0,2);
        document.getElementById('ballZoneTip').textContent = topBall.length ? '壞球常用: ' + topBall.map(e=>e[0]+'('+e[1]+')').join(', ') : '尚無資料';

        // Insight with pitch type breakdown
        const insight = document.getElementById('tendencyInsight');
        const used = PITCH_ORDER.filter(t => pitches.some(p => p.type===t));
        if (tendencyTypeChartInstance) { tendencyTypeChartInstance.destroy(); tendencyTypeChartInstance = null; }
        if (used.length === 0) { insight.innerHTML = ''; return; }
        const typeRows = used.map(type => {
            const tp = pitches.filter(p => p.type===type);
            const cnt = tp.length;
            const pct = pitches.length ? ((cnt/pitches.length)*100).toFixed(1) : 0;
            const strikeRate = tp.length ? ((tp.filter(p=>p.result==='好球').length/tp.length)*100).toFixed(0) : 0;
            const color = PITCH_COLORS[type] || '#999';
            return `<div style="display:flex;align-items:center;gap:12px;padding:9px 6px;border-bottom:1px solid #e5e7eb;">
                <span style="width:13px;height:13px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block;"></span>
                <span style="font-weight:700;color:${color};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:18px;min-width:54px;">${type}</span>
                <span style="font-size:15px;color:#374151;font-weight:600;">${cnt}球</span>
                <span style="font-size:15px;font-weight:700;color:var(--ct-blue-dark);">${pct}%</span>
                <span style="font-size:15px;font-weight:700;color:#b45309;">好球率 ${strikeRate}%</span>
            </div>`;
        }).join('');
        insight.innerHTML = `<div style="background:#f0f9ff;border:2px solid var(--ct-blue);border-radius:10px;padding:12px;">
            <strong style="color:var(--ct-blue-dark);display:block;font-size:16px;margin-bottom:8px;text-align:center;">⚾ 各球種投球傾向</strong>
            <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;">
                <div style="flex:0 1 auto;min-width:180px;max-width:340px;">${typeRows}</div>
                <div style="flex:0 0 auto;width:min(340px,90vw);height:min(340px,90vw);position:relative;"><canvas id="tendencyTypeChart"></canvas></div>
            </div>
        </div>`;
        const tendencyCanvas = document.getElementById('tendencyTypeChart');
        if (tendencyCanvas) {
            tendencyTypeChartInstance = _makeDoughnut(tendencyCanvas, used,
                used.map(t => pitches.filter(p=>p.type===t).length),
                used.map(t => PITCH_COLORS[t] || '#999'), pitches.length);
        }
    }

    function updateBallTendencyHeatmap(elementId, pitches) {
        const heatmap = document.getElementById(elementId);
        if (!heatmap) return;
        heatmap.innerHTML = '';
        const bCounts = {};
        for (let i=1;i<=16;i++) bCounts['B'+i]=0;
        pitches.forEach(p => { const z=String(p.zone); if(z.startsWith('B')&&bCounts[z]!==undefined) bCounts[z]++; });
        const maxCount = Math.max(...Object.values(bCounts), 1);
        // 5x5: corners+edges only, center=strike zone placeholder
        // Row1: B1 B2 B3 B4 B5 -> but 5 cols
        const layout5 = [
            ['B1','B2','B3','B4','B5'],
            ['B6','','','','B7'],
            ['B8','','','','B9'],
            ['B10','','','','B11'],
            ['B12','B13','B14','B15','B16']
        ];
        layout5.forEach(row => {
            row.forEach(cell => {
                const div = document.createElement('div');
                div.className = 'ball-heat-cell';
                if (!cell) {
                    div.style.cssText = 'background:#e0f0e8;border:1px dashed #86efac;display:flex;align-items:center;justify-content:center;font-size:9px;color:#aaa;';
                    div.textContent = '好球帶';
                    heatmap.appendChild(div); return;
                }
                const count = bCounts[cell]||0;
                const [bg,fg] = colorForIntensity(count===0?0:count/maxCount,'green');
                div.style.background=bg; div.style.color='#000'; div.style.position='relative';
                div.innerHTML=`<span style="position:absolute;top:1px;left:1px;font-size:7px;color:rgba(0,0,0,0.45);">${cell.replace('B','')}</span>${count}`;
                heatmap.appendChild(div);
            });
        });
    }

    // ====== 內外角與位移分析 ======
    function updateInnerOuterTable(pitches) {
        const div = document.getElementById('innerOuterTable');
        if (!div) return;
        if (innerOuterRHBChartInstance) { innerOuterRHBChartInstance.destroy(); innerOuterRHBChartInstance = null; }
        if (innerOuterLHBChartInstance) { innerOuterLHBChartInstance.destroy(); innerOuterLHBChartInstance = null; }
        if (pitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無資料</p>'; return; }

        const innerZonesRHB = ['1','4','7'], outerZonesRHB = ['3','6','9'];
        const innerZonesLHB = ['3','6','9'], outerZonesLHB = ['1','4','7'];

        const buildSideStats = (ps, innerZones, outerZones) => {
            const total = ps.length;
            if (total === 0) return null;
            const strikePs = ps.filter(p => !String(p.zone).startsWith('B'));
            const inner = strikePs.filter(p => innerZones.includes(String(p.zone))).length;
            const outer = strikePs.filter(p => outerZones.includes(String(p.zone))).length;
            const mid = strikePs.length - inner - outer;
            const pct = n => total > 0 ? ((n/total)*100).toFixed(1) : '0.0';
            const typeBreakdown = PITCH_ORDER.filter(t => ps.some(p=>p.type===t)).map(t => ({
                type: t, cnt: ps.filter(p=>p.type===t).length,
                pct: ((ps.filter(p=>p.type===t).length/total)*100).toFixed(1)
            })).sort((a,b)=>b.cnt-a.cnt);
            return { total, inner, outer, mid, pct, typeBreakdown };
        };

        const rhb = buildSideStats(pitches.filter(p=>p.batterHand==='右打'), innerZonesRHB, outerZonesRHB);
        const lhb = buildSideStats(pitches.filter(p=>p.batterHand==='左打'), innerZonesLHB, outerZonesLHB);

        const buildSideHTML = (d, label, color, chartId) => {
            if (!d) return `<div style="color:#9ca3af;font-size:13px;padding:12px;text-align:center;height:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;">${label}：尚無資料</div>`;
            const itemCount = d.typeBreakdown.length;
            const typeFontSize = itemCount <= 1 ? 22 : itemCount <= 2 ? 20 : itemCount <= 3 ? 18 : 16;
            const statFontSize = typeFontSize - 1;
            const rowPad = itemCount <= 2 ? '7px 2px' : '4px 2px';
            const rows = d.typeBreakdown.map(({type,cnt,pct}) => `
                <div style="display:flex;align-items:center;gap:4px;padding:${rowPad};">
                    <span style="width:9px;height:9px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                    <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:${typeFontSize}px;min-width:44px;">${type}</span>
                    <span style="font-size:${statFontSize}px;color:#374151;font-weight:600;">${cnt}球 <b style="color:var(--ct-red);">${pct}%</b></span>
                </div>`).join('');
            return `<div style="background:${color}08;border:2px solid ${color};border-radius:8px;padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
                <div style="font-size:15px;font-weight:900;color:${color};margin-bottom:8px;text-align:center;">${label} <span style="font-size:12px;font-weight:400;color:#6b7280;">（${d.total}球）</span></div>
                <div style="flex:1;display:flex;gap:10px;align-items:center;justify-content:center;">
                    <div style="flex:0 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;">
                        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;justify-content:center;">
                            <span style="background:#fee2e2;border-radius:5px;padding:2px 6px;font-size:12px;font-weight:700;color:#dc2626;">內角 ${d.pct(d.inner)}%</span>
                            <span style="background:#dbeafe;border-radius:5px;padding:2px 6px;font-size:12px;font-weight:700;color:#2563eb;">外角 ${d.pct(d.outer)}%</span>
                            <span style="background:#f3f4f6;border-radius:5px;padding:2px 6px;font-size:12px;font-weight:700;color:#6b7280;">中間 ${d.pct(d.mid)}%</span>
                        </div>
                        ${rows || '<div style="color:#9ca3af;font-size:13px;">無資料</div>'}
                    </div>
                    <div style="flex:0 0 auto;width:200px;height:200px;position:relative;"><canvas id="${chartId}"></canvas></div>
                </div>
            </div>`;
        };

        div.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch;">
                            ${buildSideHTML(lhb, '👈 對左打 (LHB)', '#2563eb', 'innerOuterLHBChart')}
                            ${buildSideHTML(rhb, '👉 對右打 (RHB)', '#dc2626', 'innerOuterRHBChart')}
                         </div>` +
                        '<p style="font-size:11px;color:#9ca3af;margin-top:6px;">內角定義：對RHB為1/4/7區，對LHB為3/6/9區。佔比以總投球數計算。</p>';

        const makeChart = (d, canvasId) => {
            if (!d) return null;
            const canvas = document.getElementById(canvasId);
            if (!canvas) return null;
            const types = d.typeBreakdown.map(t=>t.type);
            return _makeCompactDoughnut(canvas, types, d.typeBreakdown.map(t=>t.cnt),
                types.map(t => PITCH_COLORS[t]||'#999'), d.total);
        };
        innerOuterRHBChartInstance = makeChart(rhb, 'innerOuterRHBChart');
        innerOuterLHBChartInstance = makeChart(lhb, 'innerOuterLHBChart');
    }

    // ====== 首球習慣分析 ======
    function updateFirstPitchAnalysis(pitches) {
        const div = document.getElementById('firstPitchAnalysis');
        if (!div) return;
        [firstPitchAllChartInstance, firstPitchRHBChartInstance, firstPitchLHBChartInstance].forEach(c => { if(c) c.destroy(); });
        firstPitchAllChartInstance = firstPitchRHBChartInstance = firstPitchLHBChartInstance = null;
        if (pitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無資料</p>'; return; }

        const firstPitches = pitches.filter(p => (p.balls||0)===0 && (p.strikes||0)===0);
        if (firstPitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無首球資料（需記錄球數）</p>'; return; }

        const buildSection = (fps, label, color, chartId, compact=false) => {
            const total = fps.length;
            if (total === 0) return `<div style="color:#9ca3af;font-size:13px;padding:8px;text-align:center;">${label}：尚無資料</div>`;
            const typeCount = {};
            fps.forEach(p => { if(p.type) typeCount[p.type] = (typeCount[p.type]||0)+1; });
            const sorted = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
            const pct = n => ((n/total)*100).toFixed(1);
            // compact（RHB/LHB並排）：圖上文字下，間距緊湊
            if (compact) {
                const itemCount = sorted.length;
                const typeFontSize = itemCount <= 1 ? 22 : itemCount <= 2 ? 20 : itemCount <= 3 ? 18 : 16;
                const statFontSize = typeFontSize - 1;
                const rowPad = itemCount <= 2 ? '7px 2px' : '4px 2px';
                const rows = sorted.map(([type,cnt],i) => `
                    <div style="display:flex;align-items:center;gap:4px;padding:${rowPad};">
                        <span style="font-size:12px;flex-shrink:0;">${i===0?'🥇':i===1?'🥈':i===2?'🥉':''}</span>
                        <span style="width:9px;height:9px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                        <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:${typeFontSize}px;min-width:42px;">${type}</span>
                        <span style="font-size:${statFontSize}px;color:#374151;font-weight:600;">${cnt}次 <b style="color:var(--ct-red);">${pct(cnt)}%</b></span>
                    </div>`).join('');
                return `<div style="background:${color}08;border:2px solid ${color};border-radius:8px;padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
                    <div style="font-size:15px;font-weight:900;color:${color};margin-bottom:8px;text-align:center;">${label} <span style="font-size:12px;font-weight:400;color:#6b7280;">（${total}打席）</span></div>
                    <div style="flex:1;display:flex;gap:10px;align-items:center;justify-content:center;">
                        <div style="flex:0 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;">${rows}</div>
                        <div style="flex:0 0 auto;width:200px;height:200px;position:relative;"><canvas id="${chartId}"></canvas></div>
                    </div>
                </div>`;
            }
            // 全部首球：圖右文字左，字大
            const rows = sorted.map(([type,cnt],i) => `
                <div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid #f3f4f6;">
                    <span style="font-size:15px;flex-shrink:0;">${i===0?'🥇':i===1?'🥈':i===2?'🥉':'　'}</span>
                    <span style="width:12px;height:12px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                    <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:17px;min-width:50px;">${type}</span>
                    <span style="font-size:15px;color:#374151;font-weight:600;margin-left:6px;">${cnt}次 <b style="color:var(--ct-red);">${pct(cnt)}%</b></span>
                </div>`).join('');
            return `<div style="background:${color}08;border:2px solid ${color};border-radius:8px;padding:14px;">
                <div style="font-size:16px;font-weight:900;color:${color};margin-bottom:10px;text-align:center;">${label} <span style="font-size:13px;font-weight:400;color:#6b7280;">（${total}打席首球）</span></div>
                <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:center;">
                    <div style="flex:0 1 auto;min-width:180px;max-width:320px;">${rows}</div>
                    <div style="flex:0 0 auto;width:min(340px,90vw);height:min(340px,90vw);position:relative;"><canvas id="${chartId}"></canvas></div>
                </div>
            </div>`;
        };

        const rhb = firstPitches.filter(p=>p.batterHand==='右打');
        const lhb = firstPitches.filter(p=>p.batterHand==='左打');

        div.innerHTML = `<div style="margin-bottom:12px;">${buildSection(firstPitches, '📊 全部首球分布', '#003d79', 'firstPitchAllChart', false)}</div>` +
                        `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch;">
                             ${buildSection(lhb, '👈 對左打首球', '#2563eb', 'firstPitchLHBChart', true)}
                             ${buildSection(rhb, '👉 對右打首球', '#dc2626', 'firstPitchRHBChart', true)}
                         </div>`;

        const makeChart = (fps, canvasId) => {
            const canvas = document.getElementById(canvasId);
            if (!canvas || fps.length === 0) return null;
            const tc = {};
            fps.forEach(p => { if(p.type) tc[p.type] = (tc[p.type]||0)+1; });
            const sorted = Object.entries(tc).sort((a,b)=>b[1]-a[1]);
            const types = sorted.map(e=>e[0]);
            // 全部首球用大圖（外標籤），RHB/LHB用緊湊圖
            const isFull = canvasId === 'firstPitchAllChart';
            return isFull
                ? _makeDoughnut(canvas, types, sorted.map(e=>e[1]), types.map(t => PITCH_COLORS[t]||'#999'), fps.length)
                : _makeCompactDoughnut(canvas, types, sorted.map(e=>e[1]), types.map(t => PITCH_COLORS[t]||'#999'), fps.length);
        };
        firstPitchAllChartInstance = makeChart(firstPitches, 'firstPitchAllChart');
        firstPitchRHBChartInstance = makeChart(rhb, 'firstPitchRHBChart');
        firstPitchLHBChartInstance = makeChart(lhb, 'firstPitchLHBChart');
    }

    // ====== PATTERN ANALYSIS ======
    function updatePatternAnalysis(pitches) {
        const divType = document.getElementById('patternAnalysisType');
        const divSeq  = document.getElementById('patternAnalysisSeq');
        if (!divType || !divSeq) return;
        const empty = '<p style="color:#9ca3af;padding:8px;font-size:13px;">尚無資料</p>';
        if (pitches.length === 0) { divType.innerHTML = empty; divSeq.innerHTML = empty; return; }

        // ── 球種比例 ──
        const typeCount = {};
        pitches.forEach(p => { typeCount[p.type] = (typeCount[p.type]||0)+1; });
        const sortedTypes = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
        const total = pitches.length;
        divType.innerHTML = '';
        sortedTypes.forEach(([type,cnt]) => {
            const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};margin-right:6px;vertical-align:middle;flex-shrink:0;"></span>`;
            const item = document.createElement('div');
            item.className = 'pattern-item';
            item.innerHTML = `<span style="display:flex;align-items:center;">${dot}<span style="font-size:18px;font-weight:900;color:${PITCH_COLORS[type]||'var(--ct-blue-dark)'};font-family:'Oswald','Noto Sans TC',sans-serif;">${type}</span></span><span style="font-size:16px;color:var(--ct-red);font-weight:700;white-space:nowrap;">${cnt}球 ${((cnt/total)*100).toFixed(1)}%</span>`;
            divType.appendChild(item);
        });

        // ── 配球模式 ──
        divSeq.innerHTML = '';
        if (pitches.length < 2) { divSeq.innerHTML = '<p style="color:#9ca3af;padding:8px;font-size:13px;">需至少 2 球</p>'; return; }
        const sequences = {};
        for (let i=1; i<pitches.length; i++) {
            const seq = `${pitches[i-1].type} → ${pitches[i].type}`;
            sequences[seq] = (sequences[seq]||0)+1;
        }
        Object.entries(sequences).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([seq,cnt]) => {
            const item = document.createElement('div');
            item.className = 'pattern-item';
            item.innerHTML = `<span style="font-size:17px;font-weight:700;color:var(--ct-blue-dark);">${seq}</span><span style="font-size:16px;color:var(--ct-red);font-weight:700;white-space:nowrap;">${cnt}次</span>`;
            divSeq.appendChild(item);
        });
    }

    function updateCountAnalysis(pitches) {
        const aheadDiv = document.getElementById('aheadPitches');
        const behindDiv = document.getElementById('behindPitches');
        aheadDiv.innerHTML = ''; behindDiv.innerHTML = '';
        const ahead={}, behind={};
        pitches.forEach(p => {
            const b=p.balls||0, s=p.strikes||0;
            if (s>b) ahead[p.type]=(ahead[p.type]||0)+1;
            else if (b>s) behind[p.type]=(behind[p.type]||0)+1;
        });
        const renderCount = (obj, container, klass) => {
            const sorted = Object.entries(obj).sort((a,b)=>b[1]-a[1]);
            if (sorted.length===0) { container.innerHTML='<p style="font-size:12px;color:#6b7280;">尚無資料</p>'; return; }
            sorted.forEach(([type,cnt]) => {
                const row = document.createElement('div');
                row.className = 'count-pitch-row';
                row.innerHTML = `<span class="count-pitch-name" style="color:${klass==='ahead'?'#92400e':'#065f46'};">${type}</span><span style="font-weight:700;">${cnt} 球</span>`;
                container.appendChild(row);
            });
        };
        renderCount(ahead, aheadDiv, 'ahead');
        renderCount(behind, behindDiv, 'behind');
    }

    // 計算總出局數（整數）
    function computeTotalOuts(pitches) {
        return pitches.filter(p =>
            (p.outcomes||[p.outcome]).some(o => o && (o.includes('出局') || o === '三振' || o === '不死三振'))
        ).length;
    }

    // 將總出局數轉為棒球記分板局數格式（X / X.1 / X.2）
    function formatIP(totalOuts) {
        const full = Math.floor(totalOuts / 3);
        const rem  = totalOuts % 3;
        return rem === 0 ? `${full}` : `${full}.${rem}`;
    }

    // 向後相容：原本呼叫 computeInnings 的地方仍可用（回傳小數）
    function computeInnings(pitches) {
        return computeTotalOuts(pitches) / 3;
    }

    function updatePitchEffectiveness(pitches) {
        const div = document.getElementById('pitchEffectiveness');
        div.innerHTML = '';

        // 清除舊圖
        if (pitchTypeChartInstance) { pitchTypeChartInstance.destroy(); pitchTypeChartInstance = null; }

        if (pitches.length === 0) {
            div.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:16px;">尚無資料</p>';
            return;
        }

        const usedTypes = PITCH_ORDER.filter(t => pitches.some(p => p.type === t));
        const totalOuts  = computeTotalOuts(pitches);
        const ipDisplay  = formatIP(totalOuts);
        const earnedRuns = pitches.reduce((sum, p) => {
            if (p.runsScored !== undefined && p.runsScored !== null) return sum + p.runsScored;
            const outs = p.outcomes && p.outcomes.length ? p.outcomes : (p.outcome ? [p.outcome] : []);
            if (!outs.length) return sum;
            const bases = p.basesSnapshot || [false, false, false];
            return sum + applyBaseRunning(bases, outs).runsScored;
        }, 0);
        const totalWalks = pitches.filter(p => (p.outcomes||[p.outcome]).some(o => o === '保送')).length;
        const totalHits  = pitches.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打') || o === '全壘打'))).length;

        let eraTotal, whipTotal;
        if (totalOuts === 0 && earnedRuns === 0) {
            eraTotal = '0.00'; whipTotal = '0.00';
        } else if (totalOuts === 0) {
            eraTotal = '-.--'; whipTotal = '-.--';
        } else {
            eraTotal  = ((earnedRuns * GAME_INNING_STANDARD * 3) / totalOuts).toFixed(2);
            whipTotal = (((totalHits + totalWalks) * 3) / totalOuts).toFixed(2);
        }

        // 計算各球種統計，並依球數排序（大 → 小）以對應藍色深淺
        const typeStats = usedTypes.map(type => {
            const tp = pitches.filter(p => p.type === type);
            const total = tp.length;
            const strikes = tp.filter(p => p.result === '好球').length;
            const balls   = tp.filter(p => p.result === '壞球').length;
            const swings  = tp.filter(p => p.swing || p.result === '揮空').length;
            const wilds   = tp.filter(p => p.wild).length;
            const hits    = tp.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打') || o === '全壘打'))).length;
            const ks      = tp.filter(p => (p.outcomes||[p.outcome]).some(o => o === '三振' || o === '不死三振')).length;
            const atBats  = tp.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打') || o === '全壘打' || o.includes('出局') || o === '三振'))).length;
            const speeds  = tp.filter(p => p.speed).map(p => p.speed);
            const avgSpeed = speeds.length > 0 ? (speeds.reduce((a,b) => a+b, 0) / speeds.length).toFixed(1) : '--';
            const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : '--';
            const pct = ((total / pitches.length) * 100).toFixed(1);
            return {
                type, total, pct,
                strikeRate: ((strikes / total) * 100).toFixed(1),
                ballRate:   ((balls   / total) * 100).toFixed(1),
                swingRate:  ((swings  / total) * 100).toFixed(1),
                kRate:  atBats > 0 ? ((ks / atBats) * 100).toFixed(1) : '0.0',
                hitRate: atBats > 0 ? (hits / atBats).toFixed(3) : '.000',
                avgSpeed, maxSpeed,
                ballAlert: ((balls / total) * 100) >= 35,
                wildAlert: ((wilds / total) * 100) >= 5,
            };
        }).sort((a, b) => b.total - a.total);

        // 使用 PITCH_COLORS（與對比頁一致）
        const chartColors = typeStats.map(s => PITCH_COLORS[s.type] || '#999');
        const colorMap = {};
        typeStats.forEach(s => { colorMap[s.type] = PITCH_COLORS[s.type] || '#999'; });

        // ---- 建立表格（9欄，移除球數欄，table-layout:fixed 防重疊）----
        const rows = typeStats.map(s => {
            const ballFlag = s.ballAlert ? ' <span style="color:#dc2626;font-size:10px;">⚠</span>' : '';
            const wildFlagVal = s.wildAlert ? `<span style="color:#dc2626;">${s.swingRate}%</span>` : `${s.swingRate}%`;
            const colorDot = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${colorMap[s.type]};margin-right:4px;vertical-align:middle;flex-shrink:0;"></span>`;
            return `<tr>
                <td><span style="display:flex;align-items:center;">${colorDot}${s.type}(${s.total})</span></td>
                <td style="font-weight:700;color:${colorMap[s.type]};">${s.pct}%</td>
                <td style="color:#b45309;">${s.strikeRate}%</td>
                <td style="color:${s.ballAlert ? '#dc2626' : '#065f46'};">${s.ballRate}%${ballFlag}</td>
                <td>${wildFlagVal}</td>
                <td>${s.avgSpeed}</td>
                <td style="font-weight:700;">${s.maxSpeed}</td>
                <td>${s.kRate}%</td>
                <td style="font-weight:700;">${s.hitRate}</td>
            </tr>`;
        }).join('');

        div.innerHTML = `
            <table class="pitch-detail-table">
                <colgroup>
                    <col class="col-type"><col class="col-pct"><col class="col-str">
                    <col class="col-ball"><col class="col-swing">
                    <col class="col-avg"><col class="col-max">
                    <col class="col-k"><col class="col-ba">
                </colgroup>
                <thead><tr>
                    <th>球種</th><th>佔比</th><th>好球率</th>
                    <th>壞球率</th><th>揮空率</th>
                    <th>均速</th><th>最高速</th>
                    <th>三振率</th><th>被打率</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="pitch-detail-summary">
                <span class="sum-title">⚾ 整場合計 · ${pitches.length} 球 · IP ${ipDisplay}</span>
                <div class="sum-item"><div class="sum-label">ERA</div><div class="sum-val" style="color:var(--ct-red);">${eraTotal}</div></div>
                <div class="sum-item"><div class="sum-label">WHIP</div><div class="sum-val" style="color:var(--ct-red);">${whipTotal}</div></div>
            </div>`;

        // ---- 建立甜甜圈圖（legend-bottom，無外部指引線）----
        const canvas = document.getElementById('pitchTypeChart');
        if (!canvas) return;
        if (pitchTypeChartInstance) { pitchTypeChartInstance.destroy(); pitchTypeChartInstance = null; }
        const centerPlugin = {
            id: 'pitchTypeCenter',
            afterDraw(chart) {
                const { ctx, chartArea: { left, right, top, bottom } } = chart;
                const cx = (left + right) / 2, cy = (top + bottom) / 2;
                ctx.save();
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.font = "bold 22px 'Oswald','Noto Sans TC',sans-serif";
                ctx.fillStyle = '#003d79';
                ctx.fillText(pitches.length, cx, cy - 10);
                ctx.font = "11px 'Noto Sans TC',sans-serif";
                ctx.fillStyle = '#9ca3af';
                ctx.fillText('總球數', cx, cy + 10);
                ctx.restore();
            }
        };
        pitchTypeChartInstance = new Chart(canvas, {
            type: 'doughnut',
            plugins: [centerPlugin],
            data: {
                labels: typeStats.map(s => s.type),
                datasets: [{ data: typeStats.map(s => s.total), backgroundColor: chartColors, borderWidth: 2, borderColor: '#fff' }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '52%',
                layout: { padding: 0 },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            font: { size: 11, weight: '700' },
                            padding: 6,
                            boxWidth: 12,
                            usePointStyle: true,
                            pointStyleWidth: 10,
                            color: '#374151',
                            generateLabels: chart => chart.data.labels.map((label, i) => ({
                                text: `${label} ${((chart.data.datasets[0].data[i]/pitches.length)*100).toFixed(1)}%`,
                                fillStyle: chart.data.datasets[0].backgroundColor[i],
                                strokeStyle: chart.data.datasets[0].backgroundColor[i],
                                pointStyle: 'circle',
                                index: i
                            }))
                        }
                    },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} 球 (${((ctx.parsed/pitches.length)*100).toFixed(1)}%)` } },
                    datalabels: { display: false }
                }
            }
        });

    }

    function updateOutcomeStats(pitches) {
        const statsDiv = document.getElementById('outcomeStats');
        statsDiv.innerHTML = '';
        const outcomes = {};
        pitches.forEach(p => {
            const outs = p.outcomes && p.outcomes.length > 0 ? p.outcomes : (p.outcome ? [p.outcome] : []);
            outs.forEach(o => { if(o) outcomes[o]=(outcomes[o]||0)+1; });
        });
        const sorted = Object.entries(outcomes).sort((a,b)=>b[1]-a[1]);
        if (sorted.length===0) { statsDiv.innerHTML='<p style="color:#9ca3af;text-align:center;padding:16px;">尚無打擊結果記錄</p>'; return; }
        sorted.forEach(([outcome,cnt]) => {
            const item=document.createElement('div');
            item.className='pattern-item';
            item.innerHTML=`<span><strong>${outcome}</strong></span><span style="color:var(--ct-red);font-weight:700;">${cnt} 次</span>`;
            statsDiv.appendChild(item);
        });
    }

    // ====== 兩好球決勝球傾向 ======
    function updateTwoStrikeAnalysis(pitches) {
        const div = document.getElementById('twoStrikeAnalysis');
        if (!div) return;
        if (twoStrikeRHBChartInstance) { twoStrikeRHBChartInstance.destroy(); twoStrikeRHBChartInstance = null; }
        if (twoStrikeLHBChartInstance) { twoStrikeLHBChartInstance.destroy(); twoStrikeLHBChartInstance = null; }
        const twoStrike = pitches.filter(p => (p.strikes||0) === 2);
        if (twoStrike.length === 0) {
            div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無兩好球資料（需記錄球數）</p>';
            return;
        }
        const rhb = twoStrike.filter(p => p.batterHand === '右打');
        const lhb = twoStrike.filter(p => p.batterHand === '左打');

        const buildSection = (ps, label, color, chartId) => {
            if (ps.length === 0) return `<div style="color:#9ca3af;font-size:12px;padding:8px;text-align:center;">${label}：尚無資料</div>`;
            const total = ps.length;
            const pct = n => ((n/total)*100).toFixed(1);
            const typeCount = {};
            ps.forEach(p => { if(p.type) typeCount[p.type] = (typeCount[p.type]||0)+1; });
            const topTypes = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
            const zoneCount = {};
            ps.forEach(p => { if(p.zone) zoneCount[p.zone] = (zoneCount[p.zone]||0)+1; });
            const topZones = Object.entries(zoneCount).sort((a,b)=>b[1]-a[1]).slice(0,3);

            const itemCount = topTypes.length;
            const typeFontSize = itemCount <= 1 ? 22 : itemCount <= 2 ? 20 : itemCount <= 3 ? 18 : 16;
            const statFontSize = typeFontSize - 1;
            const rowPad = itemCount <= 2 ? '7px 2px' : '4px 2px';
            const typeRows = topTypes.map(([type,cnt],i) => `
                <div style="display:flex;align-items:center;gap:4px;padding:${rowPad};">
                    <span style="font-size:12px;flex-shrink:0;">${i===0?'🥇':i===1?'🥈':i===2?'🥉':''}</span>
                    <span style="width:9px;height:9px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                    <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:${typeFontSize}px;min-width:42px;">${type}</span>
                    <span style="font-size:${statFontSize}px;color:#374151;font-weight:600;">${cnt}球 <b style="color:var(--ct-red);">${pct(cnt)}%</b></span>
                </div>`).join('');
            const zoneRows = topZones.map(([zone,cnt],i) => {
                const isStrike = !zone.startsWith('B');
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 2px;font-size:12px;">
                    <span>${i===0?'🎯 ':''}<b style="color:${isStrike?'#92400e':'#065f46'};">位置${zone}</b></span>
                    <span style="color:var(--ct-red);font-weight:700;">${cnt}球 ${pct(cnt)}%</span>
                </div>`;
            }).join('');
            return `<div style="background:${color}08;border:2px solid ${color};border-radius:8px;padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
                <div style="font-size:15px;font-weight:900;color:${color};margin-bottom:8px;text-align:center;">${label} <span style="font-size:12px;font-weight:400;color:#6b7280;">（${total}球）</span></div>
                <div style="flex:1;display:flex;gap:10px;align-items:center;justify-content:center;">
                    <div style="flex:0 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;">
                        <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:2px;">⚾ 球種</div>
                        ${typeRows}
                        <div style="font-size:11px;font-weight:700;color:#374151;margin:4px 0 2px;">📍 進壘 Top3</div>
                        ${zoneRows || '<div style="color:#9ca3af;font-size:12px;">無資料</div>'}
                    </div>
                    <div style="flex:0 0 auto;width:200px;height:200px;position:relative;"><canvas id="${chartId}"></canvas></div>
                </div>
            </div>`;
        };

        div.innerHTML = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px;">共 ${twoStrike.length} 球兩好球紀錄（左打 ${lhb.length} / 右打 ${rhb.length}）</div>` +
                        `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch;">
                             ${buildSection(lhb, '👈 對左打兩好球 (LHB)', '#2563eb', 'twoStrikeLHBChart')}
                             ${buildSection(rhb, '👉 對右打兩好球 (RHB)', '#dc2626', 'twoStrikeRHBChart')}
                         </div>`;

        const makeChart = (ps, canvasId) => {
            const canvas = document.getElementById(canvasId);
            if (!canvas || ps.length === 0) return null;
            const tc = {};
            ps.forEach(p => { if(p.type) tc[p.type] = (tc[p.type]||0)+1; });
            const sorted = Object.entries(tc).sort((a,b)=>b[1]-a[1]);
            const types = sorted.map(e=>e[0]);
            return _makeCompactDoughnut(canvas, types, sorted.map(e=>e[1]),
                types.map(t => PITCH_COLORS[t]||'#999'), ps.length);
        };
        twoStrikeRHBChartInstance = makeChart(rhb, 'twoStrikeRHBChart');
        twoStrikeLHBChartInstance = makeChart(lhb, 'twoStrikeLHBChart');
    }

    // ====== 壘上有人分析 ======
    function updateBaseStateAnalysis(pitches) {
        const divWith = document.getElementById('baseStateWith');
        const divNo = document.getElementById('baseStateNo');
        const divInsight = document.getElementById('baseStateInsight');
        if (!divWith || !divNo) return;
        const div = { innerHTML: '' }; // dummy, not used below
        const upperZones = ['1','2','3'];
        const lowerZones = ['7','8','9'];

        const calc = (ps) => {
            const total = ps.length;
            if (total === 0) return null;
            const strike = ps.filter(p => !String(p.zone).startsWith('B'));
            const upper = strike.filter(p => upperZones.includes(String(p.zone))).length;
            const lower = strike.filter(p => lowerZones.includes(String(p.zone))).length;
            const mid = strike.length - upper - lower;
            const stTotal = strike.length || 1;
            const hits = ps.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打') || o === '全壘打'))).length;
            const atBats = ps.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打') || o === '全壘打' || o.includes('出局') || o === '三振'))).length;
            const avg = atBats > 0 ? (hits / atBats).toFixed(3) : '.000';
            return { total, upper, lower, mid, stTotal, hits, atBats, avg,
                upperPct: ((upper/stTotal)*100).toFixed(1),
                midPct: ((mid/stTotal)*100).toFixed(1),
                lowerPct: ((lower/stTotal)*100).toFixed(1) };
        };

        const withBase = pitches.filter(p => p.runnersOn);
        const noBase = pitches.filter(p => !p.runnersOn);
        const bWith = calc(withBase);
        const bNo = calc(noBase);

        if (!bWith && !bNo) {
            divWith.innerHTML = '<p style="color:#9ca3af;padding:10px;font-size:12px;">尚無資料（需記錄壘包狀態）</p>';
            divNo.innerHTML = '';
            if (divInsight) divInsight.innerHTML = '';
            return;
        }

        const bar = (pct, color) => `<div style="height:10px;border-radius:5px;background:#e5e7eb;margin:4px 0 8px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${color};border-radius:5px;"></div></div>`;

        const renderCard = (data, label, borderColor) => {
            if (!data) return `<div style="color:#9ca3af;font-size:14px;padding:10px;border:2px solid #e5e7eb;border-radius:8px;">尚無${label}資料</div>`;
            return `<div style="border:2px solid ${borderColor};border-radius:10px;padding:14px;background:${borderColor}08;margin-bottom:10px;">
                <div style="font-weight:700;color:${borderColor};margin-bottom:10px;font-size:15px;">${label}
                    <span style="font-weight:400;color:#6b7280;font-size:13px;">（共${data.total}球）</span>
                </div>
                <div style="font-size:14px;color:#374151;margin-bottom:2px;">⬆️ 高球帶(1-3)：<strong>${data.upperPct}%</strong></div>
                ${bar(data.upperPct,'#f59e0b')}
                <div style="font-size:14px;color:#374151;margin-bottom:2px;">➡️ 中間(4-6)：<strong>${data.midPct}%</strong></div>
                ${bar(data.midPct,'#94a3b8')}
                <div style="font-size:14px;color:#374151;margin-bottom:2px;">⬇️ 低球帶(7-9)：<strong>${data.lowerPct}%</strong></div>
                ${bar(data.lowerPct,'#3b82f6')}
                <div style="font-size:14px;color:#374151;margin-top:6px;padding-top:8px;border-top:1px solid #e5e7eb;">
                    🎯 被安打率：<strong style="color:var(--ct-red);font-size:16px;">${data.avg}</strong>
                    <span style="color:#9ca3af;font-size:12px;">(${data.hits}安/${data.atBats}打席)</span>
                </div>
            </div>`;
        };

        const diff = bWith && bNo ? (parseFloat(bWith.upperPct) - parseFloat(bNo.upperPct)).toFixed(1) : null;
        const insight = diff !== null ? `<div style="background:${Math.abs(diff)>=5?'#fef3c7':'#f0fdf4'};border:1px solid ${Math.abs(diff)>=5?'#f59e0b':'#86efac'};border-radius:6px;padding:8px;font-size:12px;color:#374151;margin-top:4px;">
            ${Math.abs(diff)>=5 ? `⚠️ 壘上有人時高球帶${diff>0?'增加':'減少'} <strong>${Math.abs(diff)}%</strong>，有明顯差異` : `✅ 壘上有無人時進壘點差異不大（${diff>0?'+':''}${diff}%）`}
        </div>` : '';

        divWith.innerHTML = renderCard(bWith, '🏃 壘上有人', '#dc2626');
        divNo.innerHTML = renderCard(bNo, '⬜ 壘上無人', '#2563eb');
        if (divInsight) divInsight.innerHTML = insight;
    }

    // ====== 備份還原 ======
    function triggerDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
    }

    function backupData() {
        try {
            const dataStr = JSON.stringify(allData, null, 2);
            const blob = new Blob([dataStr], {type:'application/json'});
            const url = URL.createObjectURL(blob);
            triggerDownload(url, `投手情蒐備份_${new Date().toISOString().split('T')[0]}.json`);
        } catch(e) { alert('備份失敗：' + e.message); }
    }

    function restoreData(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const imported = JSON.parse(e.target.result);
                if (!confirm('還原數據將覆蓋目前所有記錄，確定繼續？')) return;
                allData = imported;
                if (!allData.pitcherDB) allData.pitcherDB = {};
                rebuildPitcherDB();
                currentTeam = null; currentPitcher = null;
                slotA = {team:null,pitcher:null}; slotB = {team:null,pitcher:null};
                saveToLocalStorage();
                saveToFirebase();
                updateTeamList(); updateSlotDisplay(); updateScoreboard();
                alert('✅ 數據還原成功！已同步至雲端');
            } catch(e) { alert('還原失敗，請確認檔案格式正確：' + e.message); }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    // ====== TABS ======
    // ====== CHART.JS INSTANCES ======
    let pieChartInstance = null;
    let statsTypePieInstance = null;
    let patternPieInstance = null;
    let lineChartInstance = null;
    let pitchTypeChartInstance = null;
    let tendencyTypeChartInstance = null;
    let innerOuterRHBChartInstance = null;
    let innerOuterLHBChartInstance = null;
    let firstPitchAllChartInstance = null;
    let firstPitchRHBChartInstance = null;
    let firstPitchLHBChartInstance = null;
    let twoStrikeRHBChartInstance = null;
    let twoStrikeLHBChartInstance = null;
    let comparePitchAChart = null;
    let comparePitchBChart = null;
    let compareEffectAChart = null;
    let compareEffectBChart = null;

    // 緊湊型甜甜圈：legend-bottom，無外部標籤，用於 RHB/LHB 並排區塊
    function _makeCompactDoughnut(canvas, types, counts, colors, total) {
        const id = 'compactCenter_' + (canvas.id || Math.random().toString(36).slice(2));
        const centerPlugin = {
            id,
            afterDraw(chart) {
                const { ctx, chartArea: { left, right, top, bottom } } = chart;
                const cx = (left + right) / 2, cy = (top + bottom) / 2;
                ctx.save();
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.font = "bold 20px 'Oswald','Noto Sans TC',sans-serif";
                ctx.fillStyle = '#003d79';
                ctx.fillText(total, cx, cy - 9);
                ctx.font = "9px 'Noto Sans TC',sans-serif";
                ctx.fillStyle = '#9ca3af';
                ctx.fillText('球', cx, cy + 9);
                ctx.restore();
            }
        };
        return new Chart(canvas, {
            type: 'doughnut',
            plugins: [centerPlugin],
            data: { labels: types, datasets: [{ data: counts, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '52%',
                layout: { padding: 0 },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} 球 (${((ctx.parsed / total) * 100).toFixed(1)}%)` } },
                    datalabels: { display: false }
                }
            }
        });
    }

    // 共用甜甜圈圖建立函式：外置標籤 + 引導線 + 中間總球數
    function _makeDoughnut(canvas, types, counts, colors, total) {
        // 中間總球數文字
        const centerTextPlugin = {
            id: 'doughnutCenter',
            afterDraw(chart) {
                const { ctx, chartArea: { left, right, top, bottom } } = chart;
                const cx = (left + right) / 2, cy = (top + bottom) / 2;
                ctx.save();
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.font = "bold 20px 'Oswald', 'Noto Sans TC', sans-serif";
                ctx.fillStyle = '#003d79';
                ctx.fillText(total, cx, cy - 9);
                ctx.font = "10px 'Noto Sans TC', sans-serif";
                ctx.fillStyle = '#9ca3af';
                ctx.fillText('總球數', cx, cy + 10);
                ctx.restore();
            }
        };
        // 引導線：從弧段外緣畫短線到標籤方向
        const connectorPlugin = {
            id: 'doughnutConnectors',
            afterDatasetsDraw(chart) {
                const { ctx, data } = chart;
                const tot = data.datasets[0].data.reduce((a, b) => a + b, 0);
                chart.getDatasetMeta(0).data.forEach((arc, i) => {
                    if (data.datasets[0].data[i] / tot < 0.05) return;
                    const mid = (arc.startAngle + arc.endAngle) / 2;
                    const r = arc.outerRadius;
                    const x1 = arc.x + Math.cos(mid) * r;
                    const y1 = arc.y + Math.sin(mid) * r;
                    const x2 = arc.x + Math.cos(mid) * (r + 22);
                    const y2 = arc.y + Math.sin(mid) * (r + 22);
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.strokeStyle = data.datasets[0].backgroundColor[i];
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    ctx.restore();
                });
            }
        };
        return new Chart(canvas, {
            type: 'doughnut',
            plugins: [ChartDataLabels, centerTextPlugin, connectorPlugin],
            data: { labels: types, datasets: [{ data: counts, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '50%',
                layout: { padding: 65 },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} 球 (${((ctx.parsed/total)*100).toFixed(1)}%)` } },
                    datalabels: {
                        display: ctx => (ctx.dataset.data[ctx.dataIndex] / total) >= 0.05,
                        anchor: 'end',
                        align: 'end',
                        offset: 6,
                        formatter: (value, ctx) => `${ctx.chart.data.labels[ctx.dataIndex]}\n${((value/total)*100).toFixed(1)}%`,
                        color: ctx => ctx.dataset.backgroundColor[ctx.dataIndex],
                        font: { weight: '700', size: 10 },
                        textAlign: 'center',
                        clamp: false
                    }
                }
            }
        });
    }

    function updatePitchTypePieChart(pitches) {
        const canvas = document.getElementById('pitchTypePieChart');
        if (!canvas) return;
        const allTypes = PITCH_ORDER.filter(t => pitches.some(p => p.type === t));
        const counts = allTypes.map(t => pitches.filter(p => p.type === t).length);
        const colors = allTypes.map(t => PITCH_COLORS[t] || '#999');
        if (pieChartInstance) { pieChartInstance.destroy(); pieChartInstance = null; }
        if (!allTypes.length) { const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); return; }
        pieChartInstance = _makeDoughnut(canvas, allTypes, counts, colors, pitches.length);
    }

    function updatePatternPieChart(pitches) {
        const canvas = document.getElementById('patternPieChart');
        if (!canvas) return;
        if (patternPieInstance) { patternPieInstance.destroy(); patternPieInstance = null; }
        if (pitches.length < 2) { const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); return; }
        const sequences = {};
        for (let i = 1; i < pitches.length; i++) {
            const seq = `${pitches[i-1].type}→${pitches[i].type}`;
            sequences[seq] = (sequences[seq] || 0) + 1;
        }
        const top = Object.entries(sequences).sort((a,b) => b[1]-a[1]).slice(0, 5);
        if (!top.length) return;
        const total = top.reduce((s, [,c]) => s + c, 0);
        // 縮短標籤：移除「球」字讓顯示更緊湊（快速球→快速）
        const shorten = s => s.replace(/球/g, '');
        const labels = top.map(([seq]) => shorten(seq));
        const counts = top.map(([,c]) => c);
        const colors = top.map(([seq]) => PITCH_COLORS[seq.split('→')[0]] || '#999');
        patternPieInstance = _makeDoughnut(canvas, labels, counts, colors, total);
    }

    function updateSpeedLineChart(pitches) {
        const canvas = document.getElementById('speedLineChart');
        if (!canvas) return;
        if (lineChartInstance) { lineChartInstance.destroy(); lineChartInstance = null; }
        const withSpeed = pitches.filter(p => p.speed && p.speed > 0);
        if (withSpeed.length < 3) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#9ca3af';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('需至少 3 筆球速數據', canvas.width/2, canvas.height/2);
            return;
        }
        const groupSize = Math.max(1, Math.ceil(withSpeed.length / 12));
        const labels = [], data = [];
        for (let i = 0; i < withSpeed.length; i += groupSize) {
            const group = withSpeed.slice(i, i + groupSize);
            const avg = group.reduce((s, p) => s + p.speed, 0) / group.length;
            labels.push(`第${i+1}球`);
            data.push(parseFloat(avg.toFixed(1)));
        }
        const minS = Math.min(...data) - 3;
        const maxS = Math.max(...data) + 3;
        lineChartInstance = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: '平均球速',
                    data,
                    borderColor: '#003d79',
                    backgroundColor: 'rgba(0,61,121,0.07)',
                    pointBackgroundColor: data.map(v => v === Math.max(...data) ? '#dc2626' : '#0051a5'),
                    pointRadius: 5, tension: 0.35, fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { min: minS, max: maxS, ticks: { callback: v => v + ' km/h', font: { size: 11 } } },
                    x: { ticks: { font: { size: 10 }, maxRotation: 45, maxTicksLimit: 12 } }
                },
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y + ' km/h' } } }
            }
        });
    }

    // ====== HISTORY MODAL ======
    function showPitcherHistory() {
        if (currentTeam === null || currentPitcher === null) { alert('請先選擇投手！'); return; }
        const pitcher = allData.teams[currentTeam].pitchers[currentPitcher];
        const key = getPitcherKey(pitcher.name, pitcher.number);
        const db_entry = allData.pitcherDB[key];
        document.getElementById('historyModal').style.display = 'block';
        renderHistoryModal(pitcher, db_entry);
    }

    function closeHistoryModal() {
        document.getElementById('historyModal').style.display = 'none';
    }

    function renderHistoryModal(pitcher, db_entry) {
        const body = document.getElementById('historyModalBody');
        const allPitches = db_entry ? db_entry.pitches : pitcher.pitches;
        if (!allPitches || allPitches.length === 0) {
            body.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:24px;">尚無歷史數據</p>';
            return;
        }

        // Group by gameKey
        const byGame = {};
        allPitches.forEach(p => {
            const gk = p.gameKey || '未知場次';
            if (!byGame[gk]) byGame[gk] = [];
            byGame[gk].push(p);
        });

        // Career totals
        const total = allPitches.length;
        const ks = allPitches.filter(p => (p.outcomes||[p.outcome]).some(o => o==='三振'||o==='不死三振')).length;
        const walks = allPitches.filter(p => (p.outcomes||[p.outcome]).some(o => o==='保送')).length;
        const hits = allPitches.filter(p => (p.outcomes||[p.outcome]).some(o => o&&(o.includes('安打')||o==='全壘打'))).length;
        const speeds = allPitches.filter(p => p.speed).map(p => p.speed);
        const avgSpeed = speeds.length ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : '--';
        const maxSpeed = speeds.length ? Math.max(...speeds) : '--';
        const strikeRate = ((allPitches.filter(p=>p.result==='好球').length/total)*100).toFixed(1);

        // Most hit pitch type
        const hitsByType = {};
        allPitches.filter(p => (p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'))).forEach(p => {
            hitsByType[p.type] = (hitsByType[p.type]||0)+1;
        });
        const mostHitType = Object.entries(hitsByType).sort((a,b)=>b[1]-a[1])[0];

        // Most used type
        const typeCount = {};
        allPitches.forEach(p => { if(p.type) typeCount[p.type]=(typeCount[p.type]||0)+1; });
        const mostUsed = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).slice(0,3);

        body.innerHTML = `
        <!-- 投手標頭 -->
        <div style="background:linear-gradient(135deg,var(--ct-blue-dark),var(--ct-blue));border-radius:10px;padding:14px;color:white;margin-bottom:16px;">
            <div style="font-size:22px;font-weight:900;font-family:'Oswald','Noto Sans TC',sans-serif;">${pitcher.name}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
                ${pitcher.number ? `<span style="background:rgba(255,255,255,0.15);padding:2px 8px;border-radius:4px;font-size:12px;">#${pitcher.number}</span>` : ''}
                ${pitcher.hand ? `<span style="background:rgba(255,255,255,0.15);padding:2px 8px;border-radius:4px;font-size:12px;">${pitcher.hand}</span>` : ''}
                ${pitcher.role ? `<span style="background:rgba(255,215,0,0.2);padding:2px 8px;border-radius:4px;font-size:12px;color:var(--ct-gold);">${pitcher.role}</span>` : ''}
                <span style="background:rgba(255,255,255,0.1);padding:2px 8px;border-radius:4px;font-size:12px;">共 ${Object.keys(byGame).length} 場記錄</span>
            </div>
        </div>

        <!-- 生涯累積 -->
        <h3 style="color:var(--ct-blue-dark);margin-bottom:10px;">📊 生涯累積數據</h3>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;">
            ${[['總球數',total+'球'],['好球率',strikeRate+'%'],['平均球速',avgSpeed+' km/h'],['最高球速',maxSpeed+' km/h'],['三振',ks+'次'],['保送',walks+'次'],['被安打',hits+'次'],['最易被打型',mostHitType?mostHitType[0]+' ('+mostHitType[1]+')':'無']].map(([l,v])=>`
            <div style="background:#f9fafb;border-radius:8px;padding:10px;border-left:3px solid var(--ct-blue);">
                <div style="font-size:10px;color:#6b7280;font-weight:700;margin-bottom:3px;">${l}</div>
                <div style="font-size:15px;font-weight:900;color:var(--ct-blue-dark);">${v}</div>
            </div>`).join('')}
        </div>

        <!-- 最常用球種 -->
        <h3 style="color:var(--ct-blue-dark);margin-bottom:8px;">⚾ 最常用球種</h3>
        <div style="margin-bottom:16px;">
            ${mostUsed.map(([type,cnt],i)=>`
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:${i===0?'#fef3c7':'#f9fafb'};border-radius:6px;margin-bottom:5px;">
                <span style="font-weight:700;color:var(--ct-blue-dark);">${['🥇','🥈','🥉'][i]} ${type}</span>
                <span style="color:var(--ct-red);font-weight:700;">${cnt}球 · ${((cnt/total)*100).toFixed(1)}%</span>
            </div>`).join('')}
        </div>

        <!-- 各場次明細 -->
        <h3 style="color:var(--ct-blue-dark);margin-bottom:10px;">📅 各場次記錄</h3>
        ${Object.entries(byGame).map(([gk, ps]) => {
            const gTotal = ps.length;
            const gKs = ps.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='三振'||o==='不死三振')).length;
            const gSpeeds = ps.filter(p=>p.speed).map(p=>p.speed);
            const gAvg = gSpeeds.length ? (gSpeeds.reduce((a,b)=>a+b,0)/gSpeeds.length).toFixed(1) : '--';
            const gSR = ((ps.filter(p=>p.result==='好球').length/gTotal)*100).toFixed(1);
            const parts = gk.split('|');
            const gameName = parts[0] || gk;
            const dateVs = parts[1] && parts[2] ? `${parts[1]} · ${parts[2]}` : '';
            return `<div style="border:2px solid var(--ct-gold);border-radius:10px;padding:12px;margin-bottom:10px;">
                <div style="font-weight:900;color:var(--ct-blue-dark);font-size:14px;margin-bottom:4px;">🏟️ ${gameName}</div>
                ${dateVs ? `<div style="font-size:11px;color:#6b7280;margin-bottom:8px;">${dateVs}</div>` : ''}
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;font-size:12px;">
                    <div style="text-align:center;background:#f0f9ff;border-radius:6px;padding:6px;"><div style="color:#6b7280;margin-bottom:2px;">球數</div><strong>${gTotal}</strong></div>
                    <div style="text-align:center;background:#fef3c7;border-radius:6px;padding:6px;"><div style="color:#6b7280;margin-bottom:2px;">好球率</div><strong>${gSR}%</strong></div>
                    <div style="text-align:center;background:#d1fae5;border-radius:6px;padding:6px;"><div style="color:#6b7280;margin-bottom:2px;">三振</div><strong>${gKs}</strong></div>
                    <div style="text-align:center;background:#ede9fe;border-radius:6px;padding:6px;"><div style="color:#6b7280;margin-bottom:2px;">均速</div><strong>${gAvg}</strong></div>
                </div>
            </div>`;
        }).join('')}`;

        // Close on outside click
        document.getElementById('historyModal').onclick = function(e) {
            if (e.target === this) closeHistoryModal();
        };
    }

    function switchTab(e, tab) {
        document.querySelectorAll('.tab-btn').forEach(btn=>btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
        if (e && e.target) e.target.classList.add('active');
        if (tab==='record') document.getElementById('recordTab').classList.add('active');
        else if (tab==='stats') { document.getElementById('statsTab').classList.add('active'); updateStats(); }
        else if (tab==='analysis') { document.getElementById('analysisTab').classList.add('active'); updateStats(); }
        else if (tab==='compare') { document.getElementById('compareTab').classList.add('active'); updateCompare(); }
        // 程式化切換時自動將對應 tab-btn 標為 active
        if (!e || !e.target) {
            document.querySelectorAll('.tab-btn').forEach(btn => {
                if ((btn.getAttribute('onclick')||'').includes(`'${tab}'`)) btn.classList.add('active');
            });
        }
    }

    // ====== PITCHER COMPARE ======
    function updateCompare() {
        const hasA = slotA.team !== null && slotA.pitcher !== null && allData.teams[slotA.team];
        const hasB = slotB.team !== null && slotB.pitcher !== null && allData.teams[slotB.team];

        const noDataMsg = '<div style="text-align:center;color:#9ca3af;padding:32px;font-size:14px;">請先在左側選擇兩位投手（Slot A 和 Slot B）再進行對比</div>';
        if (!hasA && !hasB) {
            ['compareHeader','compareBasic','comparePitchTypes','compareHeatmaps','comparePatterns','compareEffectiveness'].forEach(id => {
                document.getElementById(id).innerHTML = id === 'compareBasic' ? noDataMsg : '';
            });
            return;
        }

        // 有資料才銷毀舊圖表並重建
        [comparePitchAChart, comparePitchBChart, compareEffectAChart, compareEffectBChart].forEach(c => { if(c) c.destroy(); });
        comparePitchAChart = comparePitchBChart = compareEffectAChart = compareEffectBChart = null;

        const pitcherA = hasA ? allData.teams[slotA.team].pitchers[slotA.pitcher] : null;
        const pitcherB = hasB ? allData.teams[slotB.team].pitchers[slotB.pitcher] : null;
        const pitchesA = hasA ? getFilteredPitches(slotA.team, slotA.pitcher) : [];
        const pitchesB = hasB ? getFilteredPitches(slotB.team, slotB.pitcher) : [];
        const teamA = hasA ? allData.teams[slotA.team] : null;
        const teamB = hasB ? allData.teams[slotB.team] : null;

        // ---- Header cards ----
        const makeHeader = (pitcher, team, slot, pitches) => {
            if (!pitcher) return `<div style="background:rgba(0,0,0,0.06);border-radius:12px;padding:16px;text-align:center;border:2px dashed #d1d5db;color:#9ca3af;">Slot ${slot}<br>尚未選擇投手</div>`;
            const color = slot === 'A' ? '#003d79' : '#2b2b2b';
            const border = slot === 'A' ? 'var(--ct-gold)' : '#aaa';
            return `<div style="background:linear-gradient(135deg,${color},${slot==='A'?'#0051a5':'#444'});border-radius:12px;padding:16px;color:white;border:3px solid ${border};">
                <div style="font-size:10px;opacity:0.6;letter-spacing:2px;margin-bottom:4px;">SLOT ${slot} · ${team ? (slot === 'A' ? (team.opponent || team.name) : team.name) : ''}</div>
                <div style="font-size:24px;font-weight:900;font-family:'Oswald','Noto Sans TC',sans-serif;">${pitcher.name}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
                    ${pitcher.number ? `<span style="background:rgba(255,255,255,0.15);padding:2px 8px;border-radius:4px;font-size:12px;">#${pitcher.number}</span>` : ''}
                    ${pitcher.hand ? `<span style="background:rgba(255,255,255,0.15);padding:2px 8px;border-radius:4px;font-size:12px;">${pitcher.hand}</span>` : ''}
                    ${pitcher.role ? `<span style="background:rgba(255,215,0,0.2);padding:2px 8px;border-radius:4px;font-size:12px;color:var(--ct-gold);">${pitcher.role}</span>` : ''}
                </div>
                <div style="margin-top:8px;font-size:13px;opacity:0.8;">${pitches.length} 球記錄</div>
            </div>`;
        };
        document.getElementById('compareHeader').innerHTML = makeHeader(pitcherA, teamA, 'A', pitchesA) + makeHeader(pitcherB, teamB, 'B', pitchesB);

        // ---- Basic stats compare ----
        const calcBasic = (pitches) => {
            if (!pitches.length) return null;
            const total = pitches.length;
            const strikes = pitches.filter(p => p.result === '好球').length;
            const balls = pitches.filter(p => p.result === '壞球').length;
            const wilds = pitches.filter(p => p.wild).length;
            const swings = pitches.filter(p => p.swing).length;
            const speeds = pitches.filter(p => p.speed).map(p => p.speed);
            const ks = pitches.filter(p => (p.outcomes||[p.outcome]).some(o => o === '三振' || o === '不死三振')).length;
            const walks = pitches.filter(p => (p.outcomes||[p.outcome]).some(o => o === '保送')).length;
            const hits = pitches.filter(p => (p.outcomes||[p.outcome]).some(o => o && (o.includes('安打') || o === '全壘打'))).length;
            return {
                total,
                strikeRate: ((strikes/total)*100).toFixed(1),
                ballRate: ((balls/total)*100).toFixed(1),
                wildRate: total > 0 ? ((wilds/total)*100).toFixed(1) : '0.0',
                swingRate: total > 0 ? ((swings/total)*100).toFixed(1) : '0.0',
                avgSpeed: speeds.length ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : '--',
                maxSpeed: speeds.length ? Math.max(...speeds) : '--',
                ks, walks, hits
            };
        };
        const bA = calcBasic(pitchesA);
        const bB = calcBasic(pitchesB);

        const rows = [
            { label:'投球總數', keyA: bA?.total, keyB: bB?.total, unit:'球', higherBetter: false, isCount: true },
            { label:'好球率', keyA: bA?.strikeRate, keyB: bB?.strikeRate, unit:'%', higherBetter: true },
            { label:'壞球率', keyA: bA?.ballRate, keyB: bB?.ballRate, unit:'%', higherBetter: false },
            { label:'暴投率', keyA: bA?.wildRate, keyB: bB?.wildRate, unit:'%', higherBetter: false },
            { label:'揮空率', keyA: bA?.swingRate, keyB: bB?.swingRate, unit:'%', higherBetter: true },
            { label:'平均球速', keyA: bA?.avgSpeed, keyB: bB?.avgSpeed, unit:'km/h', higherBetter: true },
            { label:'最高球速', keyA: bA?.maxSpeed, keyB: bB?.maxSpeed, unit:'km/h', higherBetter: true },
            { label:'三振數', keyA: bA?.ks, keyB: bB?.ks, unit:'', higherBetter: true, isCount: true },
            { label:'保送數', keyA: bA?.walks, keyB: bB?.walks, unit:'', higherBetter: false, isCount: true },
            { label:'被安打數', keyA: bA?.hits, keyB: bB?.hits, unit:'', higherBetter: false, isCount: true },
        ];

        const nameA = pitcherA ? ((teamA ? (teamA.opponent || teamA.name) : '') + ' · ' + pitcherA.name) : 'Slot A';
        const nameB = pitcherB ? ((teamB ? teamB.name : '') + ' · ' + pitcherB.name) : 'Slot B';
        const shortA = pitcherA ? pitcherA.name : 'A';
        const shortB = pitcherB ? pitcherB.name : 'B';
        let basicHTML = `<div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                    <tr style="background:linear-gradient(135deg,var(--ct-blue-dark),var(--ct-blue));color:white;">
                        <th style="padding:10px;text-align:left;border-radius:8px 0 0 0;">項目</th>
                        <th style="padding:10px;text-align:center;color:var(--ct-gold);">A · ${nameA}</th>
                        <th style="padding:10px;text-align:center;">　</th>
                        <th style="padding:10px;text-align:center;color:#ccc;border-radius:0 8px 0 0;">B · ${nameB}</th>
                    </tr>
                </thead><tbody>`;

        rows.forEach((row, i) => {
            const vA = parseFloat(row.keyA);
            const vB = parseFloat(row.keyB);
            const hasValues = !isNaN(vA) && !isNaN(vB) && row.keyA !== '--' && row.keyB !== '--';
            let winA = false, winB = false;
            if (hasValues && !row.isCount) {
                winA = row.higherBetter ? vA > vB : vA < vB;
                winB = row.higherBetter ? vB > vA : vB < vA;
            }
            const bgA = winA ? 'rgba(16,185,129,0.12)' : '';
            const bgB = winB ? 'rgba(16,185,129,0.12)' : '';
            const boldA = winA ? 'font-weight:900;color:#065f46;' : '';
            const boldB = winB ? 'font-weight:900;color:#065f46;' : '';
            const dispA = row.keyA !== undefined && row.keyA !== null ? `${row.keyA}${row.unit}` : '—';
            const dispB = row.keyB !== undefined && row.keyB !== null ? `${row.keyB}${row.unit}` : '—';
            const rowBg = i % 2 === 0 ? '#f9fafb' : 'white';
            basicHTML += `<tr style="background:${rowBg};">
                <td style="padding:10px 12px;font-weight:700;color:var(--ct-blue-dark);">${row.label}</td>
                <td style="padding:10px;text-align:center;background:${bgA};${boldA}font-size:15px;">${dispA}</td>
                <td style="padding:10px;text-align:center;color:#d1d5db;font-size:18px;">${hasValues && winA ? '◀' : hasValues && winB ? '▶' : '—'}</td>
                <td style="padding:10px;text-align:center;background:${bgB};${boldB}font-size:15px;">${dispB}</td>
            </tr>`;
        });
        basicHTML += '</tbody></table></div>';
        document.getElementById('compareBasic').innerHTML = basicHTML;

        // ---- Pitch type compare ----
        const calcTypes = (pitches) => {
            const types = {};
            pitches.forEach(p => { if (p.type) types[p.type] = (types[p.type]||0)+1; });
            return types;
        };
        const typesA = calcTypes(pitchesA);
        const typesB = calcTypes(pitchesB);
        const allTypes = [...new Set([...Object.keys(typesA), ...Object.keys(typesB)])];
        const totalA = pitchesA.length || 1;
        const totalB = pitchesB.length || 1;

        // ---- 球種比例對比：左右卡片 + 圓形圖 ----
        const buildTypeCard = (pitches, label, color, chartId, total) => {
            const types = {};
            pitches.forEach(p => { if(p.type) types[p.type] = (types[p.type]||0)+1; });
            const sorted = Object.entries(types).sort((a,b)=>b[1]-a[1]);
            if (!sorted.length) return `<div style="color:#9ca3af;font-size:13px;padding:12px;text-align:center;">尚無資料</div>`;
            const itemCount = sorted.length;
            const fs = itemCount <= 2 ? 18 : itemCount <= 3 ? 16 : 14;
            const rows = sorted.map(([type,cnt]) => `
                <div style="display:flex;align-items:center;gap:6px;padding:5px 2px;border-bottom:1px solid #f0f0f0;">
                    <span style="width:10px;height:10px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                    <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:${fs}px;min-width:48px;">${type}</span>
                    <span style="font-size:${fs-1}px;color:#374151;font-weight:600;">${cnt}球 <b style="color:var(--ct-red);">${((cnt/total)*100).toFixed(1)}%</b></span>
                </div>`).join('');
            return `<div style="background:${color}10;border:2px solid ${color};border-radius:10px;padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
                <div style="font-size:14px;font-weight:900;color:${color};margin-bottom:10px;text-align:center;">${label} <span style="font-size:11px;font-weight:400;color:#6b7280;">（${total}球）</span></div>
                <div style="flex:1;display:flex;gap:10px;align-items:center;justify-content:center;">
                    <div style="flex:0 1 auto;min-width:0;">${rows}</div>
                    <div style="flex:0 0 auto;width:200px;height:200px;position:relative;"><canvas id="${chartId}"></canvas></div>
                </div>
            </div>`;
        };
        const typeCardHTML = `<div class="compare-cards-grid">
            ${buildTypeCard(pitchesA, `A · ${nameA}`, 'var(--ct-gold)', 'comparePitchACanvas', totalA)}
            ${buildTypeCard(pitchesB, `B · ${nameB}`, '#888', 'comparePitchBCanvas', totalB)}
        </div>`;
        document.getElementById('comparePitchTypes').innerHTML = typeCardHTML || '<p style="color:#9ca3af;">尚無球種資料</p>';
        // 繪製圓形圖
        const canvasPA = document.getElementById('comparePitchACanvas');
        const canvasPB = document.getElementById('comparePitchBCanvas');
        if (canvasPA) {
            const tA = Object.entries(typesA).sort((a,b)=>b[1]-a[1]);
            comparePitchAChart = _makeCompactDoughnut(canvasPA, tA.map(e=>e[0]), tA.map(e=>e[1]), tA.map(e=>PITCH_COLORS[e[0]]||'#999'), totalA);
        }
        if (canvasPB) {
            const tB = Object.entries(typesB).sort((a,b)=>b[1]-a[1]);
            comparePitchBChart = _makeCompactDoughnut(canvasPB, tB.map(e=>e[0]), tB.map(e=>e[1]), tB.map(e=>PITCH_COLORS[e[0]]||'#999'), totalB);
        }

        // ---- Heatmaps ----
        const makeHeatmapHTML = (pitches, label, color) => {
            const counts = {};
            pitches.forEach(p => { if (p.zone) counts[p.zone] = (counts[p.zone]||0)+1; });
            const max = Math.max(...Object.values(counts), 1);
            const zones = [['B1','B2','B3','B4','B5'],['B6','1','2','3','B7'],['B8','4','5','6','B9'],['B10','7','8','9','B11'],['B12','B13','B14','B15','B16']];
            let grid = `<div style="text-align:center;"><div style="font-weight:700;color:${color};margin-bottom:6px;font-size:13px;">${label}</div>
                <div style="display:grid;grid-template-columns:repeat(5,44px);grid-template-rows:repeat(5,44px);gap:2px;background:var(--ct-blue-dark);padding:3px;border-radius:8px;border:2px solid ${color};display:inline-grid;">`;
            zones.forEach(row => row.forEach(z => {
                const cnt = counts[z] || 0;
                const isStrike = !z.startsWith('B');
                const intensity = cnt === 0 ? 0 : cnt/max;
                const [bg] = colorForIntensity(intensity, isStrike ? 'yellow' : 'green');
                grid += `<div style="background:${bg};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#000;border-radius:4px;">${cnt||''}</div>`;
            }));
            grid += '</div></div>';
            return grid;
        };
        document.getElementById('compareHeatmaps').innerHTML =
            makeHeatmapHTML(pitchesA, `A · ${nameA}`, 'var(--ct-gold)') +
            makeHeatmapHTML(pitchesB, `B · ${nameB}`, '#aaa');

        // ---- Patterns ----
        const makePatterns = (pitches, label, color) => {
            const typeCount = {};
            pitches.forEach(p => { if (p.type) typeCount[p.type] = (typeCount[p.type]||0)+1; });
            const total = pitches.length || 1;
            const sorted = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).slice(0,5);
            if (!sorted.length) return `<div style="color:#9ca3af;padding:16px;text-align:center;">尚無資料</div>`;
            return `<div style="border:2px solid ${color};border-radius:10px;padding:12px;">
                <div style="font-weight:700;color:${color};margin-bottom:10px;font-size:13px;">${label}</div>
                ${sorted.map(([type,cnt]) => `
                <div style="margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;">
                        <span style="font-weight:700;">${type}</span>
                        <span style="color:var(--ct-red);font-weight:700;">${cnt}球 · ${((cnt/total)*100).toFixed(1)}%</span>
                    </div>
                    <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
                        <div style="height:100%;width:${((cnt/total)*100).toFixed(1)}%;background:${color};border-radius:4px;"></div>
                    </div>
                </div>`).join('')}
            </div>`;
        };
        document.getElementById('comparePatterns').innerHTML =
            makePatterns(pitchesA, `A · ${nameA}`, 'var(--ct-gold)') +
            makePatterns(pitchesB, `B · ${nameB}`, '#888');

        // ---- Effectiveness：兩張左文字右圓形圖的卡片 ----
        const allPitchTypes = PITCH_ORDER.filter(t => pitchesA.some(p=>p.type===t) || pitchesB.some(p=>p.type===t));

        const buildEffCard = (pitches, label, color, chartId, total) => {
            if (!pitches.length) return `<div style="color:#9ca3af;font-size:13px;padding:12px;text-align:center;">${label}：尚無資料</div>`;
            const rows = allPitchTypes.map(type => {
                const tp = pitches.filter(p=>p.type===type);
                if (!tp.length) return `<div style="padding:5px 2px 4px;border-bottom:1px solid #f0f0f0;opacity:0.3;">
                    <div style="display:flex;align-items:center;gap:5px;">
                        <span style="width:8px;height:8px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                        <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:15px;">${type}</span>
                        <span style="font-size:13px;color:#9ca3af;">—</span>
                    </div>
                </div>`;
                const sr = ((tp.filter(p=>p.result==='好球').length/tp.length)*100).toFixed(1);
                const sw = ((tp.filter(p=>p.swing).length/tp.length)*100).toFixed(1);
                const cnt = tp.length;
                const pct = ((cnt/total)*100).toFixed(1);
                return `<div style="padding:5px 2px 4px;border-bottom:1px solid #f0f0f0;">
                    <div style="display:flex;align-items:center;gap:5px;">
                        <span style="width:8px;height:8px;border-radius:50%;background:${PITCH_COLORS[type]||'#999'};flex-shrink:0;display:inline-block;"></span>
                        <span style="font-weight:700;color:${PITCH_COLORS[type]||'#999'};font-family:'Oswald','Noto Sans TC',sans-serif;font-size:15px;min-width:44px;">${type}</span>
                        <span style="font-size:13px;color:#374151;font-weight:600;">${cnt}球 <b style="color:var(--ct-red);">${pct}%</b></span>
                    </div>
                    <div style="font-size:12px;color:#6b7280;padding-left:13px;margin-top:1px;">
                        好球率 <b style="color:#059669;">${sr}%</b>&ensp;揮空率 <b style="color:#7c3aed;">${sw}%</b>
                    </div>
                </div>`;
            }).join('');
            return `<div style="background:${color}10;border:2px solid ${color};border-radius:10px;padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
                <div style="font-size:14px;font-weight:900;color:${color};margin-bottom:10px;text-align:center;">${label} <span style="font-size:11px;font-weight:400;color:#6b7280;">（${total}球）</span></div>
                <div style="flex:1;display:flex;gap:10px;align-items:center;justify-content:center;">
                    <div style="flex:0 1 auto;min-width:0;">${rows}</div>
                    <div style="flex:0 0 auto;width:200px;height:200px;position:relative;"><canvas id="${chartId}"></canvas></div>
                </div>
            </div>`;
        };

        document.getElementById('compareEffectiveness').innerHTML =
            `<div class="compare-cards-grid">
                ${buildEffCard(pitchesA, `A · ${nameA}`, 'var(--ct-gold)', 'compareEffectACanvas', totalA)}
                ${buildEffCard(pitchesB, `B · ${nameB}`, '#888', 'compareEffectBCanvas', totalB)}
            </div>` || '<p style="color:#9ca3af;">尚無資料</p>';

        // 繪製效果圓形圖
        const canvasEA = document.getElementById('compareEffectACanvas');
        const canvasEB = document.getElementById('compareEffectBCanvas');
        if (canvasEA && pitchesA.length) {
            const tA = PITCH_ORDER.filter(t=>typesA[t]).map(t=>[t,typesA[t]]);
            compareEffectAChart = _makeCompactDoughnut(canvasEA, tA.map(e=>e[0]), tA.map(e=>e[1]), tA.map(e=>PITCH_COLORS[e[0]]||'#999'), totalA);
        }
        if (canvasEB && pitchesB.length) {
            const tB = PITCH_ORDER.filter(t=>typesB[t]).map(t=>[t,typesB[t]]);
            compareEffectBChart = _makeCompactDoughnut(canvasEB, tB.map(e=>e[0]), tB.map(e=>e[1]), tB.map(e=>PITCH_COLORS[e[0]]||'#999'), totalB);
        }
    }

    // ====== DATA MANAGEMENT ======
    function exportAllData() {
        const dataStr = JSON.stringify(allData, null, 2);
        const dataBlob = new Blob([dataStr], {type:'application/json'});
        const url = URL.createObjectURL(dataBlob);
        triggerDownload(url, `投手情蒐_全部_${new Date().toISOString().split('T')[0]}.json`);
    }

    function exportCurrentPitcher() {
        if (currentTeam===null||currentPitcher===null) { alert('請先選擇投手！'); return; }
        const team = allData.teams[currentTeam];
        const pitcher = team.pitchers[currentPitcher];
        const exportData = { team:team.name, date:team.date, opponent:team.opponent, gameName:team.gameName, pitcher };
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], {type:'application/json'});
        const url = URL.createObjectURL(dataBlob);
        triggerDownload(url, `${team.name}_${pitcher.name}_${new Date().toISOString().split('T')[0]}.json`);
    }

    function importData(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const imported = JSON.parse(e.target.result);
                if (confirm('匯入數據將覆蓋現有記錄，確定要繼續嗎？')) {
                    allData = imported;
                    if (!allData.pitcherDB) allData.pitcherDB = {};
                    rebuildPitcherDB();
                    currentTeam=null; currentPitcher=null;
                    slotA={team:null,pitcher:null}; slotB={team:null,pitcher:null};
                    updateTeamList(); updateSlotDisplay(); saveToLocalStorage();
                    alert('數據匯入成功！');
                }
            } catch(err) { alert('檔案格式錯誤！'); }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    function manualSave() {
        try {
            localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData));
            saveToFirebase();
            const w = document.getElementById('lsWarning');
            if (w) w.style.display = 'none';
            const btn = event.target;
            const orig = btn.textContent;
            btn.textContent = '✅ 已儲存';
            btn.style.background = 'var(--ct-green)';
            setTimeout(() => { btn.textContent = orig; btn.style.background = 'var(--ct-blue-dark)'; }, 1200);
        } catch(e) {
            const w = document.getElementById('lsWarning');
            if (w) { w.style.display = 'block'; w.textContent = '⚠️ 儲存失敗，請點「備份數據」下載保存'; }
            alert('儲存失敗，建議點「備份數據」手動下載保存。');
        }
    }

    function toggleAutoSave() {
        autoSave = document.getElementById('autoSaveToggle').checked;
        document.getElementById('autoSaveStatus').textContent = autoSave ? '開啟' : '關閉';
        try { localStorage.setItem('autoSaveSetting', autoSave ? '1' : '0'); } catch(e) {}
    }


    // ====== FIREBASE SETUP ======
    const firebaseConfig = {
        apiKey: "AIzaSyAFFL_qwBEGjs-EFHQJhm8_aOetsBmLEF0",
        authDomain: "ctpitcher-cd5cf.firebaseapp.com",
        databaseURL: "https://ctpitcher-cd5cf-default-rtdb.asia-southeast1.firebasedatabase.app",
        projectId: "ctpitcher-cd5cf",
        storageBucket: "ctpitcher-cd5cf.firebasestorage.app",
        messagingSenderId: "225631887831",
        appId: "1:225631887831:web:1e7c2a8a9d6520f55beb92"
    };
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.database();
    // 啟用 Firebase 離線持久化（讓 Firebase SDK 自行處理離線快取）
    db.ref('.info/connected'); // 觸發連線監控初始化

    // 動態 DB_KEY：根據球隊代碼隔離數據
    let DB_KEY = 'pitcherScoutData'; // 預設，登入後會更新為 teams/{teamCode}/data
    let lastSaveTime = 0;
    let _fbSaveTimer = null; // debounce timer for Firebase writes
    let firebaseListening = false;
    let activeFirebaseRef = null; // 記錄目前監聽的 ref，供 logout 時正確移除
    let isOnline = navigator.onLine;
    let pendingSync = false; // 離線期間是否有未同步的資料

    function setSyncStatus(online) {
        const dot = document.getElementById('syncDotCircle');
        const txt = document.getElementById('syncDotText');
        if (!dot) return;
        isOnline = online;
        if (online && pendingSync) {
            dot.className = 'dot'; dot.style.background = '#f59e0b';
            txt.textContent = '同步中...';
        } else {
            dot.className = 'dot ' + (online ? 'online' : 'offline');
            txt.textContent = online ? '已同步' : '離線';
        }
    }

    // 監控連線狀態，重新連線時自動補傳
    db.ref('.info/connected').on('value', snap => {
        const connected = snap.val() === true;
        setSyncStatus(connected);
        if (connected && pendingSync) {
            // 重新連線，自動補傳離線期間的資料
            console.log('[Firebase] 重新連線，補傳離線資料...');
            pendingSync = false;
            saveToFirebase();
        }
    });

    // 瀏覽器網路狀態也監控
    window.addEventListener('online', () => {
        if (pendingSync) {
            console.log('[Network] 連線恢復，補傳資料...');
            pendingSync = false;
            saveToFirebase();
        }
    });

    function sanitizeForFirebase(data) {
        // Only store teams data, skip pitcherDB (has invalid key chars)
        // pitcherDB is rebuilt from teams on load anyway
        const clean = {
            teams: JSON.parse(JSON.stringify(data.teams || [])),
            batterData: JSON.parse(JSON.stringify(data.batterData || [])),
            bm: JSON.parse(JSON.stringify(data.bm || { lineup: [], gameIdx:-1, attackingTeam:'B', atBats:[] }))
        };
        return clean;
    }

    // ====== MULTI-TENANT DATA HELPERS ======

    // Legacy read ref (used only for migration from old single-blob path)
    function getDataRef() {
        return USER_TEAM_REF ? USER_TEAM_REF.child('pitchers') : db.ref(DB_KEY);
    }

    // Per-game Firebase paths: teams/{teamCode}/games/{gameId}
    function getGamesRef() {
        if (USER_TEAM_REF) return USER_TEAM_REF.child('games');
        if (currentTeamCode === 'ADMIN') return db.ref('pitcherScoutGames');
        return db.ref(`teams/${currentTeamCode}/games`);
    }
    function getGameRef(gameId) { return getGamesRef().child(String(gameId)); }

    // Generate a unique game ID
    function _makeGameId() {
        return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // Normalise a single raw game entry (Firebase may return arrays as {0:…,1:…})
    function _normalizeGameEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        let pitchers = raw.pitchers || [];
        if (!Array.isArray(pitchers)) pitchers = Object.values(pitchers);
        pitchers = pitchers.filter(Boolean).map(p => {
            let pitches = p.pitches || [];
            if (!Array.isArray(pitches)) pitches = Object.values(pitches);
            return { ...p, pitches };
        });
        return { ...raw, pitchers };
    }

    // Normalises legacy snapshot value (old single-blob path) into a clean teams array
    function normalizeTeamsData(raw) {
        if (!raw) return null;
        let teams;
        if (USER_TEAM_REF) {
            teams = Array.isArray(raw) ? raw : Object.values(raw);
        } else {
            if (!raw.teams) return null;
            teams = Array.isArray(raw.teams) ? raw.teams : Object.values(raw.teams);
        }
        return teams.filter(Boolean).map(team => {
            let pitchers = team.pitchers || [];
            if (!Array.isArray(pitchers)) pitchers = Object.values(pitchers);
            pitchers = pitchers.filter(Boolean).map(pitcher => {
                let pitches = pitcher.pitches || [];
                if (!Array.isArray(pitches)) pitches = Object.values(pitches);
                return { ...pitcher, pitches };
            });
            if (!team.gameId) team.gameId = _makeGameId();
            return { ...team, pitchers };
        });
    }

    function restoreFromFirebaseData(data) {
        // Firebase Realtime DB converts arrays to objects ({0:{...},1:{...}})
        // Convert back to proper arrays at every level
        let teams = data.teams || [];
        if (!Array.isArray(teams)) teams = Object.values(teams);
        teams = teams.map(team => {
            if (!team) return team;
            let pitchers = team.pitchers || [];
            if (!Array.isArray(pitchers)) pitchers = Object.values(pitchers);
            pitchers = pitchers.map(pitcher => {
                if (!pitcher) return pitcher;
                let pitches = pitcher.pitches || [];
                if (!Array.isArray(pitches)) pitches = Object.values(pitches);
                return { ...pitcher, pitches };
            });
            return { ...team, pitchers };
        });
        allData.teams = teams;
        allData.pitcherDB = {};
        rebuildPitcherDB();
        saveToLocalStorage();
    }

    // 上傳前防呆：偵測到幾乎沒有資料時擋住，避免空資料蓋掉雲端
    function _hasUploadableData() {
        const teamPitches = (allData.teams || []).reduce((sum, t) =>
            sum + (t.pitchers || []).reduce((s, p) => s + (p.pitches || []).length, 0), 0);
        const bmAtBats = (allData.bm && allData.bm.atBats) ? allData.bm.atBats.length : 0;
        if (teamPitches === 0 && bmAtBats === 0) {
            alert('⚠️ 目前沒有任何記錄資料，已取消上傳。\n若要清空雲端請先到側欄手動操作。');
            return false;
        }
        return true;
    }

    function quickSave(btn) {
        if (!_hasUploadableData()) return;
        saveToLocalStorage();
        if (btn) { btn.textContent = '⏳ 儲存中...'; btn.disabled = true; }
        try {
            getDataRef().set(getFirebasePayload())
                .then(() => {
                    setSyncStatus(true);
                    if (btn) { btn.textContent = '✅ 已儲存'; setTimeout(() => { btn.textContent = '💾 儲存'; btn.disabled = false; }, 2000); }
                })
                .catch(() => {
                    if (btn) { btn.textContent = '📱 已存本機'; setTimeout(() => { btn.textContent = '💾 儲存'; btn.disabled = false; }, 2000); }
                });
        } catch(e) {
            if (btn) { btn.textContent = '📱 已存本機'; setTimeout(() => { btn.textContent = '💾 儲存'; btn.disabled = false; }, 2000); }
        }
    }

    function forceSyncToFirebase() {
        if (!_hasUploadableData()) return;
        const btn = event && event.target;
        if (btn) { btn.textContent = '⏳ 同步中...'; btn.disabled = true; }
        try {
            getDataRef().set(getFirebasePayload())
                .then(() => {
                    setSyncStatus(true);
                    if (btn) { btn.textContent = '✅ 同步成功'; setTimeout(() => { btn.textContent = '☁️ 上傳至雲端'; btn.disabled = false; }, 2000); }
                    alert('✅ 數據已成功同步至雲端！');
                })
                .catch(e => {
                    if (btn) { btn.textContent = '❌ 同步失敗'; btn.disabled = false; }
                    alert('同步失敗：' + e.message);
                });
        } catch(e) {
            alert('同步錯誤：' + e.message);
            if (btn) { btn.textContent = '☁️ 上傳至雲端'; btn.disabled = false; }
        }
    }

    function exportReportPDF() {
        if (currentTeam === null || currentPitcher === null) { alert('請先選擇投手！'); return; }
        const pitcher = allData.teams[currentTeam].pitchers[currentPitcher];
        const team = allData.teams[currentTeam];
        const pitches = getFilteredPitches(currentTeam, currentPitcher);
        if (pitches.length === 0) { alert('尚無投球記錄！'); return; }

        const total = pitches.length;
        const strikes = pitches.filter(p => p.result === '好球').length;
        const ks = pitches.filter(p => (p.outcomes||[]).some(o => o==='三振'||o==='不死三振')).length;
        const walks = pitches.filter(p => (p.outcomes||[]).some(o => o==='保送')).length;
        const hits = pitches.filter(p => (p.outcomes||[]).some(o => o&&(o.includes('安打')||o==='全壘打'))).length;
        const speeds = pitches.filter(p => p.speed).map(p => p.speed);
        const avgSpd = speeds.length ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : '--';
        const maxSpd = speeds.length ? Math.max(...speeds) : '--';
        const typeMap = {};
        pitches.forEach(p => { if(p.type) typeMap[p.type]=(typeMap[p.type]||0)+1; });
        const topTypes = Object.entries(typeMap).sort((a,b)=>b[1]-a[1]).slice(0,4);

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>投手情蒐報告</title>
        <style>
            body{font-family:'Noto Sans TC',Arial,sans-serif;padding:24px;color:#1e3a5f;max-width:800px;margin:0 auto;}
            h1{color:#003d79;border-bottom:3px solid #d4af37;padding-bottom:8px;}
            h2{color:#003d79;font-size:15px;margin-top:20px;border-left:4px solid #d4af37;padding-left:8px;}
            .meta{color:#6b7280;font-size:13px;margin-bottom:16px;}
            .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0;}
            .stat-box{background:#f0f4ff;border-radius:8px;padding:10px;text-align:center;border:1px solid #c7d7f0;}
            .stat-val{font-size:22px;font-weight:900;color:#003d79;}
            .stat-lbl{font-size:11px;color:#6b7280;margin-top:2px;}
            table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}
            th{background:#003d79;color:white;padding:7px;text-align:left;}
            td{padding:6px;border-bottom:1px solid #e5e7eb;}
            tr:nth-child(even){background:#f9fafb;}
            .footer{margin-top:24px;font-size:11px;color:#9ca3af;text-align:right;}
        </style></head><body>
        <h1>⚾ 投手情蒐報告</h1>
        <div class="meta">${team.gameName||''} ｜ ${team.name}${team.opponent?' vs '+team.opponent:''} ｜ ${team.date||''}</div>
        <h2>📋 投手資料</h2>
        <p><strong>姓名：</strong>${pitcher.name} &nbsp;|&nbsp; <strong>背號：</strong>#${pitcher.number||'--'} &nbsp;|&nbsp; <strong>投法：</strong>${pitcher.hand||'--'} &nbsp;|&nbsp; <strong>角色：</strong>${pitcher.role||'--'}</p>
        <h2>📊 本場統計</h2>
        <div class="stats-grid">
            <div class="stat-box"><div class="stat-val">${total}</div><div class="stat-lbl">總球數</div></div>
            <div class="stat-box"><div class="stat-val">${((strikes/total)*100).toFixed(1)}%</div><div class="stat-lbl">好球率</div></div>
            <div class="stat-box"><div class="stat-val">${avgSpd}</div><div class="stat-lbl">均速 km/h</div></div>
            <div class="stat-box"><div class="stat-val">${maxSpd}</div><div class="stat-lbl">最高球速</div></div>
            <div class="stat-box"><div class="stat-val">${ks}</div><div class="stat-lbl">三振</div></div>
            <div class="stat-box"><div class="stat-val">${walks}</div><div class="stat-lbl">保送</div></div>
            <div class="stat-box"><div class="stat-val">${hits}</div><div class="stat-lbl">被安打</div></div>
            <div class="stat-box"><div class="stat-val">${topTypes[0]?topTypes[0][0]:'--'}</div><div class="stat-lbl">最常用球種</div></div>
        </div>
        <h2>⚾ 球種分布</h2>
        <table><tr><th>球種</th><th>球數</th><th>佔比</th></tr>
        ${topTypes.map(([t,c])=>`<tr><td>${t}</td><td>${c}</td><td>${((c/total)*100).toFixed(1)}%</td></tr>`).join('')}
        </table>
        <h2>📝 投球明細（前30球）</h2>
        <table><tr><th>#</th><th>球種</th><th>球速</th><th>位置</th><th>結果</th><th>打擊結果</th><th>備註</th></tr>
        ${pitches.slice(0,30).map((p,i)=>`<tr><td>${i+1}</td><td>${p.type||'--'}</td><td>${p.speed||'--'}</td><td>${p.zone||'--'}</td><td>${p.result||'--'}</td><td>${(p.outcomes||[]).join('/')}</td><td>${p.note||''}</td></tr>`).join('')}
        </table>
        <div class="footer">產生時間：${new Date().toLocaleString('zh-TW')} ｜ 中華台北投手情蒐系統</div>
        </body></html>`;

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (w) {
            setTimeout(() => { w.print(); URL.revokeObjectURL(url); }, 800);
        } else {
            triggerDownload(url, `投手報告_${pitcher.name}_${team.date||'today'}.html`);
        }
    }

    function listenFirebase() {
        if (firebaseListening) return;
        firebaseListening = true;

        const gRef = getGamesRef();
        const hasPendingSync = localStorage.getItem('_pendingSync') === '1';

        // 同時讀取新路徑 (games/) 和舊路徑，以「內容指紋」去重後再掛監聽
        // 指紋 = gameName|name|opponent|date，避免 gameId 不一致時產生重複賽事
        Promise.all([
            gRef.once('value'),
            getDataRef().once('value')
        ]).then(([newSnap, oldSnap]) => {

            // ── 收集所有候選賽事 ──
            const candidates = [];
            const newRaw = newSnap.val();
            if (newRaw && typeof newRaw === 'object') {
                Object.entries(newRaw).forEach(([id, data]) => {
                    const g = _normalizeGameEntry(data);
                    if (g) { if (!g.gameId) g.gameId = id; candidates.push(g); }
                });
            }
            const oldTeams = normalizeTeamsData(oldSnap.val()) || [];
            oldTeams.forEach(t => { if (!t.gameId) t.gameId = _makeGameId(); candidates.push(t); });
            (allData.teams || []).forEach(t => {
                if (!t.gameId) t.gameId = _makeGameId();
                candidates.push(JSON.parse(JSON.stringify(t)));
            });

            // ── 以內容指紋去重：保留球數最多的版本 ──
            const fpMap = new Map(); // fingerprint → game
            candidates.forEach(g => {
                const fp = [g.gameName||'', g.name||'', g.opponent||'', g.date||''].join('|');
                if (!fp.replace(/\|/g,'').trim()) return; // 空賽事略過
                if (!fpMap.has(fp)) {
                    fpMap.set(fp, g);
                } else {
                    const existing = fpMap.get(fp);
                    const ec = (existing.pitchers||[]).reduce((s,p)=>s+(p.pitches||[]).length,0);
                    const nc = (g.pitchers||[]).reduce((s,p)=>s+(p.pitches||[]).length,0);
                    if (nc > ec) fpMap.set(fp, g);
                }
            });

            const mergedArr = [...fpMap.values()];
            const originalCount = newRaw && typeof newRaw === 'object' ? Object.keys(newRaw).length : 0;

            // 需要回寫：有去重（少了幾筆）、有新賽事（多了幾筆）、離線補傳
            const needWrite = hasPendingSync
                || mergedArr.length !== originalCount
                || mergedArr.some(g => !newRaw || !newRaw[g.gameId]);

            // 立即更新本機畫面
            if (mergedArr.length > 0) {
                allData.teams = mergedArr;
                rebuildPitcherDB();
                saveToLocalStorage();
                updateTeamList(); updateSlotDisplay(); updatePitchLog(); updateStats(); updateScoreboard();
            }

            if (needWrite) {
                const writeObj = {};
                mergedArr.forEach(g => { writeObj[g.gameId] = JSON.parse(JSON.stringify(g)); });
                lastSaveTime = Date.now();
                gRef.set(writeObj)
                    .then(() => {
                        if (hasPendingSync) {
                            pendingSync = false;
                            try { localStorage.removeItem('_pendingSync'); } catch(e) {}
                            setSyncStatus(true);
                        }
                        console.log(`[Firebase] 初始化完成（${mergedArr.length} 場，已去重）`);
                        _startGamesListener(gRef);
                    })
                    .catch(e => {
                        console.warn('[Firebase] 初始化寫入失敗:', e.code);
                        _startGamesListener(gRef);
                    });
            } else {
                _startGamesListener(gRef);
            }
        }).catch(() => _startGamesListener(gRef));
    }

    function _startGamesListener(gRef) {
        activeFirebaseRef = gRef;
        let _firstEvent = true;

        activeFirebaseRef.on('value', snap => {
            // 10 秒保護：忽略自己寫入後觸發的回呼（第一次事件除外，需要載入初始資料）
            if (!_firstEvent && Date.now() - lastSaveTime < 10000) return;
            _firstEvent = false;

            const raw = snap.val();
            if (!raw || typeof raw !== 'object') return;

            // 把 {gameId: gameData} 轉成陣列
            const remoteGames = Object.entries(raw)
                .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
                .map(([id, data]) => {
                    const g = _normalizeGameEntry(data);
                    if (!g) return null;
                    if (!g.gameId) g.gameId = id;
                    return g;
                })
                .filter(Boolean);

            if (remoteGames.length === 0) return;

            // 目前正在情蒐的賽事 gameId（不允許被遠端資料覆蓋）
            const editingId = (currentTeam !== null && allData.teams[currentTeam])
                ? allData.teams[currentTeam].gameId
                : null;

            // 以本機陣列為基礎做 in-place 合併，保持索引穩定
            const remoteById = Object.fromEntries(remoteGames.map(g => [g.gameId, g]));

            // 更新已有的賽事（跳過正在編輯的那場）
            allData.teams.forEach((local, idx) => {
                if (!local.gameId) return;
                if (local.gameId === editingId) return; // 保護
                if (remoteById[local.gameId]) {
                    allData.teams[idx] = remoteById[local.gameId];
                }
            });

            // 把遠端有、本機沒有的新賽事附加到尾端
            const localIds = new Set(allData.teams.map(t => t.gameId).filter(Boolean));
            remoteGames.forEach(rg => {
                if (!localIds.has(rg.gameId)) allData.teams.push(rg);
            });

            rebuildPitcherDB();
            saveToLocalStorage();
            updateTeamList(); updateSlotDisplay(); updatePitchLog(); updateStats(); updateScoreboard();
            if (typeof refreshBatterList === 'function' &&
                document.getElementById('batterTab')?.classList.contains('active')) {
                refreshBatterList();
            }
            setSyncStatus(true);
        });
    }

    // gameIdx: 指定只儲存哪場比賽（per-game write）；不傳則全量寫入所有賽事
    function saveToFirebase(gameIdx) {
        lastSaveTime = Date.now();
        saveToLocalStorage();

        // batterData 寫入獨立節點（不受 gameIdx 影響）
        if (USER_TEAM_REF && allData.batterData) {
            try {
                USER_TEAM_REF.child('batterData').set(JSON.parse(JSON.stringify(allData.batterData)))
                    .catch(e => console.warn('[Firebase] batterData 寫入失敗:', e.code));
            } catch(e) {}
        }

        const onSuccess = () => {
            lastSaveTime = Date.now();
            setSyncStatus(true);
            pendingSync = false;
            try { localStorage.removeItem('_pendingSync'); } catch(e) {}
        };
        const onFail = e => {
            console.warn('[Firebase] 寫入失敗:', e?.code || e);
            pendingSync = true;
            try { localStorage.setItem('_pendingSync', '1'); } catch(e) {}
            setSyncStatus(false);
        };

        // 300ms debounce：連續記球合併成一次寫入
        clearTimeout(_fbSaveTimer);
        _fbSaveTimer = setTimeout(() => {
            try {
                if (gameIdx !== undefined && allData.teams[gameIdx]) {
                    // ── Per-game write：只更新這一場，不動其他賽事 ──
                    const game = allData.teams[gameIdx];
                    if (!game.gameId) game.gameId = _makeGameId();
                    getGameRef(game.gameId).set(JSON.parse(JSON.stringify(game)))
                        .then(onSuccess).catch(onFail);
                } else {
                    // ── Full write：一次寫入所有賽事（quickSave / 初次遷移等）──
                    const gamesObj = {};
                    (allData.teams || []).forEach(t => {
                        if (!t.gameId) t.gameId = _makeGameId();
                        gamesObj[t.gameId] = JSON.parse(JSON.stringify(t));
                    });
                    getGamesRef().set(gamesObj).then(onSuccess).catch(onFail);
                }
            } catch(e) {
                console.warn('[Firebase] 離線，資料已存本地，待連線後自動同步');
                onFail(e);
            }
        }, 300);
    }

    function pullFromFirebase() {
        // 若本機有未上傳的離線資料，先警告再詢問
        const hasPending = localStorage.getItem('_pendingSync') === '1';
        if (hasPending) {
            const ok = confirm(
                '⚠️ 你有本機離線記錄尚未上傳至雲端！\n\n' +
                '若直接從雲端拉取，這些離線資料將永久遺失。\n\n' +
                '建議：先按「上傳至雲端」再拉取。\n\n' +
                '確定要放棄本機記錄並覆蓋嗎？'
            );
            if (!ok) return;
        }
        getGamesRef().once('value')
            .then(snap => {
                const raw = snap.val();
                let teams = [];
                if (raw && typeof raw === 'object') {
                    teams = Object.entries(raw)
                        .map(([id, data]) => { const g = _normalizeGameEntry(data); if (g && !g.gameId) g.gameId = id; return g; })
                        .filter(Boolean);
                }
                if (teams.length === 0) {
                    alert('雲端目前無資料，請先按「☁️ 上傳至雲端」把本機數據上傳。');
                    return;
                }
                if (!hasPending && !confirm(`雲端有 ${teams.length} 筆球隊資料，要覆蓋本機嗎？`)) return;
                allData.teams = teams;
                allData.pitcherDB = {};
                rebuildPitcherDB();
                saveToLocalStorage();
                try { localStorage.removeItem('_pendingSync'); } catch(e) {}
                updateTeamList(); updateSlotDisplay(); updatePitchLog(); updateStats(); updateScoreboard();
                alert('✅ 已從雲端拉取最新數據！');
            })
            .catch(e => alert('拉取失敗：' + e.message));
    }

    function saveToLocalStorage() {
        try {
            localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData));
        } catch(e) {
            const w = document.getElementById('lsWarning');
            if (w) { w.style.display = 'block'; w.textContent = '⚠️ 自動儲存失敗，請手動備份數據'; }
        }
    }

    function loadFromLocalStorage() {
        const saved = localStorage.getItem('chineseTaipeiPitcherData');
        if (saved) {
            try {
                allData = JSON.parse(saved);
                if (!allData.pitcherDB) allData.pitcherDB = {};
                if (!allData.batterData) allData.batterData = [];
                if (Object.keys(allData.pitcherDB).length === 0 && allData.teams.some(t => t.pitchers.some(p => p.pitches.length > 0))) {
                    rebuildPitcherDB();
                }
            } catch(e) {}
        }
        // Restore slot state
        try {
            const slotState = localStorage.getItem('pitcherScoutSlotState');
            if (slotState) {
                const s = JSON.parse(slotState);
                if (s.lastSelectedSlot) lastSelectedSlot = s.lastSelectedSlot;
                if (s.activeSlot) activeSlot = s.activeSlot;
            }
        } catch(e) {}
        const autoSet = localStorage.getItem('autoSaveSetting');
        autoSave = autoSet === '1';
        const tg = document.getElementById('autoSaveToggle');
        if (tg) tg.checked = autoSave;
        const st = document.getElementById('autoSaveStatus');
        if (st) st.textContent = autoSave ? '開啟' : '關閉';
        // listenFirebase() 移至 enterSystem() 呼叫，確保 USER_TEAM_REF 已設定後才開始監聽
    }

    // Close modals on outside click - use stopPropagation to prevent flash
    window.addEventListener('click', function(event) {
        ['addPitcherModal','editPitchModal','singlePitcherModal'].forEach(id => {
            const modal = document.getElementById(id);
            if (modal && event.target === modal) modal.style.display = 'none';
        });
    });
    // Prevent modal content clicks from closing modal
    document.querySelectorAll && document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.modal-content').forEach(el => {
            el.addEventListener('click', e => e.stopPropagation());
        });

        // 好球帶格子鍵盤支援（平板外接鍵盤 / 無障礙操作）
        document.querySelectorAll('.zone-cell').forEach(cell => {
            cell.setAttribute('tabindex', '0');
            cell.setAttribute('role', 'button');
            cell.setAttribute('aria-label', `投球落點 ${cell.dataset.zone}`);
        });
        const strikeZone = document.getElementById('strikeZone');
        if (strikeZone) {
            strikeZone.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    const cell = e.target.closest('.zone-cell');
                    if (cell) { e.preventDefault(); selectZone(cell.dataset.zone); }
                }
            });
        }

        initFirebaseAuth();
    });

    // ====== FIREBASE AUTH（新多租戶 SaaS 入口）======

    function initFirebaseAuth() {
        firebase.auth().onAuthStateChanged(async (user) => {
            const ao = document.getElementById('authOverlay');
            const msp = document.getElementById('modeSelectionPage');
            if (!user) {
                // 完全未認證：先做匿名登入，讓 DB 規則 auth != null 能通過
                userSession = null;
                USER_TEAM_REF = null;
                try { await firebase.auth().signInAnonymously(); } catch(e) {
                    // 匿名登入失敗（例如未啟用）：仍顯示登入畫面
                    if (ao) ao.style.display = 'flex';
                    if (msp) msp.style.display = 'none';
                    setTimeout(loadRememberedLogin, 80);
                }
                return;
            }
            if (user.isAnonymous) {
                // 匿名認證成功：先檢查是否為「立即更新」後的自動還原
                userSession = null;
                USER_TEAM_REF = null;
                const _restoreRaw = sessionStorage.getItem('_updateRestore');
                if (_restoreRaw) {
                    sessionStorage.removeItem('_updateRestore');
                    try {
                        const restore = JSON.parse(_restoreRaw);
                        // 60 秒內有效（重整一般 1~5 秒，此值給足夠緩衝）
                        if (restore && restore.teamCode && (Date.now() - restore.ts < 60000)) {
                            currentTeamCode = restore.teamCode;
                            userRole = restore.role || 'scout';
                            // 阻止 Firebase 初始快照觸發全畫面重繪（10 秒保護）
                            lastSaveTime = Date.now();
                            if (ao) ao.style.display = 'none';
                            if (msp) msp.style.display = 'none';
                            if (restore.mode === 'batter') {
                                enterBatterMode();
                            } else {
                                enterPitcherMode();
                            }
                            // enterSystem() → init() 執行完後還原槽位選擇
                            setTimeout(() => {
                                if (restore.slotA) slotA = restore.slotA;
                                if (restore.slotB) slotB = restore.slotB;
                                if (restore.currentTeam != null) currentTeam = restore.currentTeam;
                                if (restore.currentPitcher != null) currentPitcher = restore.currentPitcher;
                                if (restore.activeSlot) activeSlot = restore.activeSlot;
                                updateSlotDisplay();
                                updateTeamList();
                                if (currentTeam != null) {
                                    updatePitchLog();
                                    updateStats();
                                    updateScoreboard();
                                    renderBases();
                                    renderCountLights();
                                }
                            }, 350);
                            return;
                        }
                    } catch(e) {}
                }
                // 一般情況：顯示自訂密碼登入畫面（球隊代碼 + 密碼）
                if (ao) ao.style.display = 'flex';
                if (msp) msp.style.display = 'none';
                setTimeout(loadRememberedLogin, 80);
                return;
            }
            // 非匿名（未來 email 登入 SaaS 流程）：取得使用者權限
            userSession = user;
            try {
                const snap = await db.ref('users/' + user.uid).once('value');
                const userData = snap.val();
                // 商業安全防線：isPaid 必須為 true
                if (!userData || userData.isPaid !== true) {
                    await firebase.auth().signOut();
                    const errEl = document.getElementById('authError');
                    if (errEl) errEl.textContent = '❌ 授權已過期，請聯絡管理員開通';
                    return;
                }
                // 核心路徑隔離：鎖定該球隊的 Firebase ref
                USER_TEAM_REF = db.ref('teams/' + userData.teamCode);
                currentTeamCode = userData.teamCode;
                userRole = userData.role || 'admin';
                // 隱藏 authOverlay，顯示模式選擇頁
                if (ao) ao.style.display = 'none';
                if (msp) {
                    msp.style.display = 'flex';
                    const info = document.getElementById('modeSelectionUserInfo');
                    if (info) info.textContent = `${user.email}　｜　${userData.teamCode}　｜　${userRole}`;
                }
            } catch(e) {
                console.error('[Auth] 讀取使用者資料失敗:', e);
                await firebase.auth().signOut();
                const errEl = document.getElementById('authError');
                if (errEl) errEl.textContent = '❌ 驗證失敗，請稍後再試';
            }
        });
    }

    // 登入/註冊 Tab 切換
    // ── Tab 切換：'scout' | 'viewer' ──
    // ====== 記住登入資訊 ======
    // 安全設計：密碼以 btoa 輕度混淆儲存；不適用於公共設備
    const REM_KEY_CODE = '_rem_code';
    const REM_KEY_PW   = '_rem_pw';
    const REM_KEY_TAB  = '_rem_tab';
    const REM_ADMIN_CODE = '_rem_admin_code';
    const REM_ADMIN_PW   = '_rem_admin_pw';

    function _remEncode(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch(e) { return ''; } }
    function _remDecode(s) { try { return decodeURIComponent(escape(atob(s))); } catch(e) { return ''; } }

    function loadRememberedLogin() {
        try {
            const savedCode = localStorage.getItem(REM_KEY_CODE);
            const savedPw   = localStorage.getItem(REM_KEY_PW);
            const savedTab  = localStorage.getItem(REM_KEY_TAB) || 'scout';
            const hasData   = !!(savedCode);

            if (hasData) {
                // 切換到正確 tab
                switchAuthTab(savedTab);
                // 填入代碼
                const codeEl = document.getElementById('authCode');
                const pwEl   = document.getElementById('authPassword');
                if (savedCode && codeEl) codeEl.value = savedCode;
                if (savedPw && pwEl) pwEl.value = _remDecode(savedPw);
                // 勾選 checkbox + 顯示清除按鈕
                const cb = document.getElementById('authRememberMe');
                const forgetBtn = document.getElementById('authForgetBtn');
                if (cb) cb.checked = true;
                if (forgetBtn) forgetBtn.style.display = 'inline';
                // 預覽品牌
                if (savedCode) previewTeamBranding(savedCode, true);
            }

            // 管理員代碼 + 密碼
            const savedAdminCode = localStorage.getItem(REM_ADMIN_CODE);
            const savedAdminPw   = localStorage.getItem(REM_ADMIN_PW);
            if (savedAdminCode) {
                const el   = document.getElementById('adminLoginCode');
                const pwEl = document.getElementById('adminLoginPw');
                const cb   = document.getElementById('adminRememberCode');
                const note = document.getElementById('adminRememberNote');
                if (el) el.value = savedAdminCode;
                if (pwEl && savedAdminPw) pwEl.value = _remDecode(savedAdminPw);
                if (cb) cb.checked = true;
                if (note) note.style.display = 'block';
            }
        } catch(e) {}
    }

    function onRememberMeChange() {
        const cb = document.getElementById('authRememberMe');
        const note = document.getElementById('authRememberNote');
        const forgetBtn = document.getElementById('authForgetBtn');
        if (!cb) return;
        if (cb.checked) {
            if (note) note.style.display = 'block';
            if (forgetBtn) forgetBtn.style.display = 'inline';
        } else {
            if (note) note.style.display = 'none';
            // 勾掉時立刻清除儲存的資訊
            forgetSavedLogin();
            if (forgetBtn) forgetBtn.style.display = 'none';
        }
    }

    function saveRememberedLogin(code, pw, tab) {
        try {
            localStorage.setItem(REM_KEY_CODE, code);
            localStorage.setItem(REM_KEY_PW,   _remEncode(pw));
            localStorage.setItem(REM_KEY_TAB,  tab || 'scout');
        } catch(e) {}
    }

    function forgetSavedLogin() {
        try {
            [REM_KEY_CODE, REM_KEY_PW, REM_KEY_TAB].forEach(k => localStorage.removeItem(k));
            const cb = document.getElementById('authRememberMe');
            const note = document.getElementById('authRememberNote');
            const forgetBtn = document.getElementById('authForgetBtn');
            if (cb) cb.checked = false;
            if (note) note.style.display = 'none';
            if (forgetBtn) forgetBtn.style.display = 'none';
        } catch(e) {}
    }
    function onAdminRememberChange() {
        const cb   = document.getElementById('adminRememberCode');
        const note = document.getElementById('adminRememberNote');
        if (!cb || !note) return;
        note.style.display = cb.checked ? 'block' : 'none';
        if (!cb.checked) {
            try { localStorage.removeItem(REM_ADMIN_CODE); localStorage.removeItem(REM_ADMIN_PW); } catch(e) {}
        }
    }
    window.onAdminRememberChange = onAdminRememberChange;
    window.onRememberMeChange   = onRememberMeChange;
    window.forgetSavedLogin     = forgetSavedLogin;
    window.loadRememberedLogin  = loadRememberedLogin;

    function switchAuthTab(tab) {
        const isViewer = tab === 'viewer';
        const scoutBtn  = document.getElementById('authTabScout');
        const viewerBtn = document.getElementById('authTabViewer');
        const codeWrap  = document.getElementById('authCodeWrap');
        const pwLabel   = document.getElementById('authPasswordLabel');

        if (scoutBtn)  { scoutBtn.style.background  = isViewer ? 'transparent' : 'rgba(255,255,255,0.18)'; scoutBtn.style.color  = isViewer ? 'rgba(255,255,255,0.55)' : 'white'; }
        if (viewerBtn) { viewerBtn.style.background = isViewer ? 'rgba(255,255,255,0.18)' : 'transparent'; viewerBtn.style.color = isViewer ? 'white' : 'rgba(255,255,255,0.55)'; }
        if (codeWrap)  codeWrap.style.display = isViewer ? 'none' : 'block';
        if (pwLabel)   pwLabel.textContent = isViewer ? '觀看密碼' : '密碼';

        const pw = document.getElementById('authPassword');
        if (pw) pw.placeholder = isViewer ? '請輸入觀看密碼' : '請輸入密碼';

        const errEl = document.getElementById('authError');
        if (errEl) { errEl.textContent = ''; errEl.style.color = '#fca5a5'; }

        document.getElementById('authOverlay').dataset.tab = tab;
    }

    // ── 統一送出：依 Tab 決定走哪條路 ──
    async function doAuthAction() {
        const overlay = document.getElementById('authOverlay');
        const tab = overlay ? (overlay.dataset.tab || 'scout') : 'scout';
        if (tab === 'viewer') {
            const pw = (document.getElementById('authPassword').value || '').trim();
            await doViewerLogin(pw);
        } else {
            const code = (document.getElementById('authCode').value || '').trim();
            const pw   = (document.getElementById('authPassword').value || '').trim();
            await doScoutLogin(code, pw);
        }
    }

    // ── 球隊專用登入（情蒐員）──
    async function doScoutLogin(code, pw) {
        code = (code || '').trim().toUpperCase();
        pw   = (pw   || '').trim();
        const errEl = document.getElementById('authError');
        if (!code) { errEl.textContent = '❌ 請輸入登入代碼'; return; }
        if (!pw)   { errEl.textContent = '❌ 請輸入密碼';     return; }

        // 管理員帳號不走此流程，請用開發者專用入口
        if (code === ADMIN_CODE) {
            errEl.textContent = '❌ 管理員請使用下方「🛠️ 開發者專用」入口登入';
            return;
        }

        // 先試離線快取
        if (await _checkCachedCredential(code, 'scout', pw)) {
            currentTeamCode = code;
            try { localStorage.setItem('lastTeamCode', code); } catch(e) {}
            const remCb = document.getElementById('authRememberMe');
            if (remCb && remCb.checked) saveRememberedLogin(code, pw, 'scout');
            else forgetSavedLogin();
            showModeSelectionAfterLogin('scout');
            return;
        }

        if (!navigator.onLine) {
            errEl.textContent = '❌ 離線中，請先在有網路的環境登入一次';
            return;
        }

        errEl.textContent = '🔄 驗證中...';
        try {
            const snap = await db.ref(`teams/${code}/config`).once('value');
            const config = snap.val();
            if (!config) {
                errEl.textContent = `❌ 登入代碼「${code}」不存在，請確認後再試`;
                return;
            }
            // 訂閱到期檢查
            if (config.expiresAt && Date.now() > config.expiresAt) {
                errEl.textContent = '❌ 訂閱已到期，請聯絡管理員續約';
                return;
            }
            const stored = config.scoutPw;
            const inputHash = await _sha256(pw);
            const matches = _isHashed(stored) ? inputHash === stored : pw === stored;
            if (matches) {
                currentTeamCode = code;
                await _cacheCredential(code, 'scout', pw);
                try { localStorage.setItem('lastTeamCode', code); } catch(e) {}
                const remCb = document.getElementById('authRememberMe');
                if (remCb && remCb.checked) saveRememberedLogin(code, pw, 'scout');
                else forgetSavedLogin();
                showModeSelectionAfterLogin('scout');
            } else {
                errEl.textContent = '❌ 密碼錯誤，請再試一次';
                document.getElementById('authPassword').value = '';
                document.getElementById('authPassword').focus();
            }
        } catch(e) {
            console.error('[doScoutLogin] Firebase 讀取失敗:', e.code, e.message);
            if (e.code === 'PERMISSION_DENIED') {
                errEl.textContent = '❌ Firebase 權限不足，請聯絡管理員檢查 Security Rules';
            } else if (await _checkCachedCredential(code, 'scout', pw)) {
                currentTeamCode = code;
                showModeSelectionAfterLogin('scout');
            } else {
                errEl.textContent = '❌ 連線失敗（' + (e.code || e.message) + '），且無離線快取';
            }
        }
    }

    // ── 觀看者登入（只需一組觀看密碼，系統自動比對所有球隊）──
    async function doViewerLogin(viewPw) {
        viewPw = (viewPw || '').trim();
        const errEl = document.getElementById('authError');
        if (!viewPw) { errEl.textContent = '❌ 請輸入觀看密碼'; return; }

        // 先試離線快取（需曾在線上登入過）
        const cachedCode = localStorage.getItem('lastViewerTeamCode');
        if (cachedCode && await _checkCachedCredential(cachedCode, 'view', viewPw)) {
            currentTeamCode = cachedCode;
            try { localStorage.setItem('lastTeamCode', cachedCode); } catch(e) {}
            showModeSelectionAfterLogin('view');
            return;
        }

        if (!navigator.onLine) {
            errEl.textContent = '❌ 離線中，請先在有網路的環境登入一次';
            return;
        }

        errEl.textContent = '🔄 驗證中...';
        try {
            const snap = await db.ref('teams').once('value');
            const teamsObj = snap.val();
            if (!teamsObj) { errEl.textContent = '❌ 無法連線，請稍後再試'; return; }

            const inputHash = await _sha256(viewPw);
            let foundCode = null;
            for (const [teamCode, teamData] of Object.entries(teamsObj)) {
                const config = teamData && teamData.config;
                if (!config || !config.viewPw) continue;
                if (config.expiresAt && Date.now() > config.expiresAt) continue; // 跳過已到期球隊
                const stored = config.viewPw;
                const matches = _isHashed(stored) ? inputHash === stored : viewPw === stored;
                if (matches) { foundCode = teamCode; break; }
            }

            if (!foundCode) { errEl.textContent = '❌ 觀看密碼錯誤，請確認後再試'; return; }

            currentTeamCode = foundCode;
            await _cacheCredential(foundCode, 'view', viewPw);
            try {
                localStorage.setItem('lastTeamCode', foundCode);
                localStorage.setItem('lastViewerTeamCode', foundCode);
            } catch(e) {}
            const remCb = document.getElementById('authRememberMe');
            if (remCb && remCb.checked) saveRememberedLogin('', viewPw, 'viewer');
            else forgetSavedLogin();
            showModeSelectionAfterLogin('view');
        } catch(e) {
            errEl.textContent = '❌ 連線失敗，請稍後再試';
        }
    }

    // 從模式選擇頁登出
    function doAuthLogout() {
        logout();
    }

    // ── 買家輸入代碼後動態預覽該球隊的登入頁名稱 ──
    let _brandingTimer = null;
    function previewTeamBranding(rawCode, immediate) {
        clearTimeout(_brandingTimer);
        const code = (rawCode || '').trim().toUpperCase();
        if (!code || code === ADMIN_CODE.toUpperCase()) { loadSiteConfig(); return; }

        // 先從 localStorage 快取立即顯示（無延遲）
        try {
            const cached = localStorage.getItem('_brand_' + code);
            if (cached) {
                const { teamName, teamSub } = JSON.parse(cached);
                const t = document.getElementById('loginPageTitle');
                const s = document.getElementById('loginPageSub');
                if (teamName && t) t.textContent = teamName;
                if (teamSub  && s) s.textContent = teamSub;
            }
        } catch(e) {}

        // 背景向 Firebase 更新（頁面載入時立即執行；手動輸入時防抖）
        const delay = immediate ? 0 : 500;
        _brandingTimer = setTimeout(() => {
            db.ref(`teams/${code}/config`).once('value').then(snap => {
                const cfg = snap.val() || {};
                const t = document.getElementById('loginPageTitle');
                const s = document.getElementById('loginPageSub');
                if (cfg.teamName) {
                    if (t) t.textContent = cfg.teamName;
                    if (s) s.textContent = cfg.teamSub || 'PITCHER SCOUTING';
                    try { localStorage.setItem('_brand_' + code, JSON.stringify({ teamName: cfg.teamName, teamSub: cfg.teamSub })); } catch(e) {}
                } else {
                    try { localStorage.removeItem('_brand_' + code); } catch(e) {}
                    loadSiteConfig();
                }
            }).catch(() => {});
        }, delay);
    }

    // ── 載入登入頁全域名稱（頁面一開啟就執行）──
    function loadSiteConfig() {
        db.ref('systemConfig').once('value').then(snap => {
            const cfg = snap.val() || {};
            const t = document.getElementById('loginPageTitle');
            const s = document.getElementById('loginPageSub');
            if (t) t.textContent = cfg.siteTitle || '投手情蒐系統';
            if (s) s.textContent = cfg.siteSub   || 'PITCHER SCOUTING · CHINESE TAIPEI';
        }).catch(() => {});
    }

    // ── 管理員修改登入頁名稱 ──
    async function adminSetSiteConfig() {
        const snap = await db.ref('systemConfig').once('value');
        const cfg = snap.val() || {};
        const newTitle = prompt('登入頁大字（例：投手情蒐系統）：', cfg.siteTitle || '投手情蒐系統');
        if (newTitle === null) return;
        const newSub = prompt('登入頁小字（例：PITCHER SCOUTING · CHINESE TAIPEI）：', cfg.siteSub || 'PITCHER SCOUTING · CHINESE TAIPEI');
        if (newSub === null) return;
        await db.ref('systemConfig').update({
            siteTitle: newTitle.trim() || '投手情蒐系統',
            siteSub:   newSub.trim()   || 'PITCHER SCOUTING · CHINESE TAIPEI'
        });
        // 即時更新當前頁面
        const t = document.getElementById('loginPageTitle');
        const s = document.getElementById('loginPageSub');
        if (t) t.textContent = newTitle.trim() || '投手情蒐系統';
        if (s) s.textContent = newSub.trim()   || 'PITCHER SCOUTING · CHINESE TAIPEI';
        alert('✅ 登入頁名稱已更新');
    }

    // ── 更新主畫面 Header 隊名 ──
    function loadTeamHeader(code) {
        const nameEl = document.getElementById('headerTeamName');
        const subEl  = document.getElementById('headerTeamSub');
        if (!nameEl || !subEl) return;
        if (!code || code === 'ADMIN') {
            nameEl.textContent = 'CHINESE TAIPEI';
            subEl.textContent  = '投手情蒐系統 · PITCHER SCOUTING';
            return;
        }
        db.ref(`teams/${code}/config`).once('value').then(snap => {
            const cfg = snap.val() || {};
            nameEl.textContent = cfg.teamName || 'CHINESE TAIPEI';
            subEl.textContent  = cfg.teamSub  || '投手情蒐系統 · PITCHER SCOUTING';
        }).catch(() => {});
    }

    // ── 管理員彈窗 ──
    function showAdminLogin() {
        const overlay = document.getElementById('adminLoginOverlay');
        if (overlay) { overlay.style.display = 'flex'; }
        setTimeout(() => { const el = document.getElementById('adminLoginCode'); if (el) el.focus(); }, 80);
    }
    function closeAdminLogin() {
        const overlay = document.getElementById('adminLoginOverlay');
        if (overlay) overlay.style.display = 'none';
        const errEl = document.getElementById('adminLoginError');
        if (errEl) errEl.textContent = '';
    }
    async function doAdminLogin() {
        const code = (document.getElementById('adminLoginCode').value || '').trim();
        const pw   = (document.getElementById('adminLoginPw').value  || '').trim();
        const errEl = document.getElementById('adminLoginError');
        if (!code || !pw) { errEl.textContent = '❌ 請輸入代碼與密碼'; return; }
        const inputHash = await _sha256(pw);
        if (code === ADMIN_CODE && inputHash === ADMIN_PW_HASH) {
            currentTeamCode = 'ADMIN';
            await _cacheCredential(code, 'scout', pw);
            try { localStorage.setItem('lastTeamCode', code); } catch(e) {}
            const remAdminCb = document.getElementById('adminRememberCode');
            if (remAdminCb && remAdminCb.checked) {
                try { localStorage.setItem(REM_ADMIN_CODE, code); localStorage.setItem(REM_ADMIN_PW, _remEncode(pw)); } catch(e) {}
            } else {
                try { localStorage.removeItem(REM_ADMIN_CODE); localStorage.removeItem(REM_ADMIN_PW); } catch(e) {}
            }
            closeAdminLogin();
            showModeSelectionAfterLogin('scout');
        } else {
            errEl.textContent = '❌ 代碼或密碼錯誤';
            document.getElementById('adminLoginPw').value = '';
        }
    }

    // ── 管理後台：帳號列表收合 ──
    function toggleAdminList() {
        const wrap = document.getElementById('adminTeamListWrap');
        const btn  = document.getElementById('adminListToggleBtn');
        if (!wrap || !btn) return;
        const collapsed = wrap.style.display === 'none';
        wrap.style.display = collapsed ? '' : 'none';
        btn.textContent        = collapsed ? '▲ 收合' : '▼ 展開';
        btn.style.background   = collapsed ? 'rgba(255,215,0,0.1)'  : 'rgba(255,215,0,0.22)';
        btn.style.borderColor  = collapsed ? 'rgba(255,215,0,0.25)' : 'rgba(255,215,0,0.55)';
    }
    window.toggleAdminList = toggleAdminList;

    // ── 新增賽事/投手區塊收合 ──
    function toggleTeamManagement() {
        const content = document.getElementById('teamMgmtContent');
        const btn = document.getElementById('teamMgmtToggleBtn');
        if (!content || !btn) return;
        const isOpen = content.style.display !== 'none';
        content.style.display = isOpen ? 'none' : 'block';
        btn.textContent = isOpen ? '▼ 展開' : '▲ 收合';
    }
    window.toggleTeamManagement = toggleTeamManagement;

    // ── 管理後台：帳號列表 ──
    async function adminLoadTeams() {
        const container = document.getElementById('adminTeamList');
        if (!container) return;
        container.innerHTML = '<div style="color:rgba(255,255,255,0.5);font-size:12px;text-align:center;padding:12px;">載入中...</div>';
        try {
            const snap = await db.ref('teams').once('value');
            const teamsData = snap.val() || {};
            const codes = Object.keys(teamsData);
            if (codes.length === 0) {
                container.innerHTML = '<div style="color:rgba(255,255,255,0.4);font-size:12px;text-align:center;padding:12px;">尚無球隊帳號<br>請點下方「建立新球隊帳號」</div>';
                return;
            }
            container.innerHTML = '';
            codes.forEach(code => {
                const config = (teamsData[code] && teamsData[code].config) || {};
                const expiry = config.expiresAt;
                const isExpired = expiry && Date.now() > expiry;
                const expiryText = expiry ? new Date(expiry).toLocaleDateString('zh-TW') : '永久';
                const card = document.createElement('div');
                card.style.cssText = 'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;';
                card.innerHTML = `
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                        <span style="font-size:14px;font-weight:900;color:white;font-family:'Oswald',sans-serif;">${code}</span>
                        <span style="font-size:11px;padding:2px 8px;border-radius:10px;${isExpired ? 'color:#fca5a5;background:rgba(220,0,0,0.2)' : 'color:#86efac;background:rgba(0,200,100,0.15)'};">${isExpired ? '⛔ 已到期' : '✅ 使用中'}</span>
                    </div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:8px;">📅 到期日：${expiryText}</div>
                    <div style="margin-bottom:6px;">
                        <button onclick="adminCopyTeamLink('${code}')" style="width:100%;padding:6px;background:rgba(255,215,0,0.15);color:#ffd700;border:1px solid rgba(255,215,0,0.35);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit;">🔗 複製球隊專屬連結</button>
                    </div>
                    <div style="display:flex;gap:5px;flex-wrap:wrap;">
                        <button onclick="adminChangeTeamPw('${code}')" style="flex:1;min-width:52px;padding:5px 2px;background:rgba(255,165,0,0.2);color:#ffd700;border:1px solid rgba(255,165,0,0.4);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit;">🔑 改密碼</button>
                        <button onclick="adminSetTeamName('${code}')" style="flex:1;min-width:52px;padding:5px 2px;background:rgba(100,255,180,0.15);color:#6ee7b7;border:1px solid rgba(100,255,180,0.35);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit;">✏️ 隊名</button>
                        <button onclick="adminSetExpiry('${code}')" style="flex:1;min-width:52px;padding:5px 2px;background:rgba(100,180,255,0.2);color:#93c5fd;border:1px solid rgba(100,180,255,0.4);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit;">📅 到期日</button>
                        <button onclick="adminClearTeamData('${code}')" style="flex:1;min-width:52px;padding:5px 2px;background:rgba(255,100,0,0.2);color:#fdba74;border:1px solid rgba(255,100,0,0.4);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit;">🧹 清資料</button>
                        <button onclick="adminDeleteTeam('${code}')" style="flex:1;min-width:52px;padding:5px 2px;background:rgba(220,0,0,0.2);color:#fca5a5;border:1px solid rgba(220,0,0,0.4);border-radius:5px;font-size:11px;cursor:pointer;font-family:inherit;">🗑️ 刪除</button>
                    </div>`;
                container.appendChild(card);
            });
        } catch(e) {
            container.innerHTML = `<div style="color:#fca5a5;font-size:12px;text-align:center;padding:10px;">載入失敗：${e.message}</div>`;
        }
    }

    async function adminChangeTeamPw(code) {
        const newScout = prompt(`「${code}」的新情蒐員密碼（留空=不修改）：`);
        if (newScout === null) return;
        const newView = prompt(`「${code}」的新觀看者密碼（留空=不修改）：`);
        if (newView === null) return;
        if (!newScout && !newView) { alert('未輸入任何密碼，取消'); return; }
        if ((newScout && newScout.length < 4) || (newView && newView.length < 4)) { alert('密碼至少需要 4 個字元'); return; }
        const updates = {};
        if (newScout) updates.scoutPw = await _sha256(newScout);
        if (newView)  updates.viewPw  = await _sha256(newView);
        await db.ref(`teams/${code}/config`).update(updates);
        alert(`✅ 「${code}」密碼已更新`);
    }

    async function adminSetExpiry(code) {
        const snap = await db.ref(`teams/${code}/config/expiresAt`).once('value');
        const current = snap.val();
        const currentStr = current ? new Date(current).toISOString().split('T')[0] : '';
        const input = prompt(`設定「${code}」的到期日\n格式：YYYY-MM-DD\n留空 = 永久使用`, currentStr);
        if (input === null) return;
        if (input.trim() === '') {
            await db.ref(`teams/${code}/config/expiresAt`).remove();
            alert(`✅ 「${code}」已設為永久使用`);
        } else {
            const ts = new Date(input.trim()).getTime();
            if (isNaN(ts)) { alert('❌ 日期格式錯誤，請輸入 YYYY-MM-DD'); return; }
            await db.ref(`teams/${code}/config/expiresAt`).set(ts);
            alert(`✅ 「${code}」到期日設為 ${input.trim()}`);
        }
        adminLoadTeams();
    }

    async function adminDeleteTeam(code) {
        if (!confirm(`確定刪除球隊「${code}」？\n\n⚠️ 此操作無法復原，所有比賽記錄將一併刪除！`)) return;
        await db.ref(`teams/${code}`).remove();
        alert(`✅ 「${code}」已刪除`);
        adminLoadTeams();
    }

    function adminCopyTeamLink(code) {
        const base = window.location.origin + window.location.pathname;
        const link = `${base}?team=${encodeURIComponent(code)}`;
        navigator.clipboard.writeText(link).then(() => {
            alert(`✅ 已複製！\n\n${link}\n\n直接傳給球隊，他們打開就能看到自己的名稱。`);
        }).catch(() => {
            prompt('複製以下連結傳給球隊：', link);
        });
    }

    async function adminClearTeamData(code) {
        if (!confirm(`確定清除「${code}」的所有比賽記錄？\n\n⚠️ config（帳號設定）保留，只刪比賽資料。此操作無法復原！`)) return;
        await Promise.all([
            db.ref(`teams/${code}/data`).remove(),
            db.ref(`teams/${code}/pitchers`).remove()
        ]);
        alert(`✅ 「${code}」比賽資料已清除，帳號設定保留`);
    }

    async function adminSetTeamName(code) {
        const snap = await db.ref(`teams/${code}/config`).once('value');
        const cfg = snap.val() || {};
        const newName = prompt(`「${code}」的隊名大字\n（例：CHINESE TAIPEI）：`, cfg.teamName || '');
        if (newName === null) return;
        const newSub = prompt(`「${code}」的隊名小字\n（例：投手情蒐系統）：`, cfg.teamSub || '');
        if (newSub === null) return;
        await db.ref(`teams/${code}/config`).update({
            teamName: newName.trim() || null,
            teamSub:  newSub.trim()  || null
        });
        alert(`✅ 「${code}」隊名已更新`);
    }

    // ── 管理員示範資料注入（僅寫入管理員自己的 pitcherScoutData，不觸碰任何客戶球隊）──
    function adminInjectBmDemoData(evt) {
        if (!confirm(
            '注入打者模式測試資料至管理員帳號？\n\n' +
            '⚠️ 這只會覆蓋管理員帳號的 bm 打者資料，\n' +
            '不影響任何已購買球隊的資料。\n\n確定繼續？'
        )) return;

        const btn = evt && evt.target;
        if (btn) { btn.textContent = '⏳ 注入中...'; btn.disabled = true; }

        const now = Date.now();
        const ago = ms => now - ms;

        // ── 輔助：建立打席記錄 ──
        function ab(num, name, hand, inning, half, outs, bases, phHand, outcome, hitLoc, tactics, teamName, balls, strikes) {
            return {
                number: String(num), name, hand, inning, half, outs,
                bases: bases || [false,false,false],
                pitcherHand: phHand || '右投',
                outcome, tactics: tactics || [],
                hitLocation: hitLoc || null,
                teamName: teamName || '日本',
                balls: balls || 0, strikes: strikes || 0,
                mode: 'linked', pitches: [], gameIdx: 0,
                ts: ago(Math.floor(Math.random()*7200000))
            };
        }
        function hl(zone, x, y) { return { zone, x, y }; }

        // ── 日本隊打者（9人 × 17~18打席，balls/strikes 標記） ──
        // ab(號碼,姓名,慣打,局,上下,出局,壘包,投手手,結果,落點,戰術,球隊,壞球數,好球數)
        const jpAtBats = [
            // 1棒 #1 田中健（右打，高打率.440 威脅型）
            ab(1,'田中健','右打',1,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.68,0.38),[],'日本',1,0),
            ab(1,'田中健','右打',1,'上',2,[false,false,false],'左投','二壘安打',hl('RCF',0.65,0.22),[],'日本',2,1),
            ab(1,'田中健','右打',2,'上',0,[true,false,false],'右投','一壘安打',hl('1B',0.72,0.48),['打帶跑'],'日本',0,1),
            ab(1,'田中健','右打',2,'上',1,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(1,'田中健','右打',3,'上',0,[false,false,false],'右投','全壘打',hl('CF',0.50,0.08),[],'日本',2,0),
            ab(1,'田中健','右打',3,'上',2,[true,false,false],'右投','一壘安打',hl('LCF',0.32,0.42),[],'日本',0,2),
            ab(1,'田中健','右打',4,'上',0,[false,false,false],'左投','二壘安打',hl('LF',0.18,0.24),[],'日本',3,1),
            ab(1,'田中健','右打',4,'上',1,[false,false,false],'右投','滾地球出局',hl('2B',0.58,0.52),[],'日本',1,1),
            ab(1,'田中健','右打',5,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.70,0.40),[],'日本',0,0),
            ab(1,'田中健','右打',5,'上',2,[true,false,false],'左投','二壘安打',hl('LCF',0.30,0.20),[],'日本',2,2),
            ab(1,'田中健','右打',6,'上',0,[false,false,false],'右投','飛球出局',hl('CF',0.50,0.15),[],'日本',1,2),
            ab(1,'田中健','右打',6,'上',1,[false,true,false],'右投','一壘安打',hl('1B',0.74,0.44),['打帶跑'],'日本',0,1),
            ab(1,'田中健','右打',7,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(1,'田中健','右打',7,'上',2,[true,false,false],'右投','一壘安打',hl('SS',0.42,0.45),[],'日本',1,0),
            ab(1,'田中健','右打',8,'上',0,[false,false,false],'左投','全壘打',hl('LF',0.15,0.10),[],'日本',3,2),
            ab(1,'田中健','右打',8,'上',1,[true,true,false],'右投','保送',null,['打帶跑'],'日本',3,1),
            ab(1,'田中健','右打',9,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.68,0.38),[],'日本',1,1),
            ab(1,'田中健','右打',9,'上',2,[false,false,false],'右投','滾地球出局',hl('3B',0.28,0.54),[],'日本',0,2),

            // 2棒 #7 松本遼（左打，犧牲觸擊型 低打率.200 高保送）
            ab(7,'松本遼','左打',1,'上',0,[true,false,false],'右投','犧牲觸擊',hl('三短',0.25,0.78),[],'日本',0,0),
            ab(7,'松本遼','左打',1,'上',2,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(7,'松本遼','左打',2,'上',0,[true,false,false],'右投','犧牲觸擊',hl('一短',0.75,0.80),[],'日本',0,0),
            ab(7,'松本遼','左打',2,'上',1,[false,true,false],'左投','保送',null,[],'日本',3,2),
            ab(7,'松本遼','左打',3,'上',0,[true,true,false],'右投','犧牲觸擊',hl('三短',0.22,0.82),[],'日本',0,0),
            ab(7,'松本遼','左打',3,'上',2,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(7,'松本遼','左打',4,'上',0,[false,true,false],'右投','高飛犧牲打',hl('CF',0.50,0.12),[],'日本',1,2),
            ab(7,'松本遼','左打',4,'上',1,[true,false,false],'右投','一壘安打',hl('SS',0.40,0.45),[],'日本',2,1),
            ab(7,'松本遼','左打',5,'上',0,[false,false,false],'右投','滾地球出局',hl('2B',0.58,0.52),[],'日本',0,1),
            ab(7,'松本遼','左打',5,'上',2,[true,false,false],'左投','保送',null,[],'日本',3,1),
            ab(7,'松本遼','左打',6,'上',0,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(7,'松本遼','左打',6,'上',1,[false,false,false],'右投','犧牲觸擊',hl('三短',0.23,0.80),[],'日本',0,1),
            ab(7,'松本遼','左打',7,'上',0,[true,false,false],'右投','一壘安打',hl('1B',0.76,0.46),[],'日本',1,0),
            ab(7,'松本遼','左打',7,'上',2,[false,false,false],'右投','飛球出局',hl('LF',0.18,0.22),[],'日本',1,2),
            ab(7,'松本遼','左打',8,'上',0,[false,true,false],'左投','保送',null,[],'日本',3,2),
            ab(7,'松本遼','左打',8,'上',1,[false,false,false],'右投','三振',null,[],'日本',2,2),

            // 3棒 #15 大谷翔（右打，強打者 高打率.500 高OPS）
            ab(15,'大谷翔','右打',1,'上',0,[false,false,false],'右投','全壘打',hl('LF',0.15,0.10),[],'日本',2,1),
            ab(15,'大谷翔','右打',1,'上',2,[false,true,false],'右投','二壘安打',hl('LCF',0.30,0.20),[],'日本',1,0),
            ab(15,'大谷翔','右打',2,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.70,0.40),[],'日本',0,0),
            ab(15,'大谷翔','右打',2,'上',1,[true,false,false],'左投','一壘安打',hl('LF',0.20,0.38),['打帶跑'],'日本',2,1),
            ab(15,'大谷翔','右打',3,'上',0,[false,false,false],'右投','二壘安打',hl('LF',0.18,0.25),[],'日本',0,1),
            ab(15,'大谷翔','右打',3,'上',2,[true,true,false],'右投','一壘安打',hl('CF',0.50,0.35),[],'日本',1,2),
            ab(15,'大谷翔','右打',4,'上',0,[false,false,false],'左投','三振',null,[],'日本',2,2),
            ab(15,'大谷翔','右打',4,'上',1,[false,false,false],'右投','全壘打',hl('CF',0.50,0.05),[],'日本',3,2),
            ab(15,'大谷翔','右打',5,'上',0,[false,false,false],'右投','二壘安打',hl('LCF',0.28,0.22),[],'日本',1,0),
            ab(15,'大谷翔','右打',5,'上',2,[false,false,false],'右投','飛球出局',hl('LF',0.16,0.18),[],'日本',0,2),
            ab(15,'大谷翔','右打',6,'上',0,[true,false,false],'右投','一壘安打',hl('SS',0.40,0.42),['打帶跑'],'日本',0,1),
            ab(15,'大谷翔','右打',6,'上',1,[false,false,false],'右投','滾地球出局',hl('SS',0.42,0.48),[],'日本',1,1),
            ab(15,'大谷翔','右打',7,'上',0,[false,false,false],'左投','三振',null,[],'日本',1,2),
            ab(15,'大谷翔','右打',7,'上',2,[false,true,false],'右投','全壘打',hl('LF',0.14,0.08),[],'日本',2,2),
            ab(15,'大谷翔','右打',8,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.68,0.40),[],'日本',0,0),
            ab(15,'大谷翔','右打',8,'上',1,[true,false,false],'右投','二壘安打',hl('LCF',0.30,0.18),[],'日本',2,0),

            // 4棒 #28 佐藤輝（右打，長打力強但三振率極高55%）
            ab(28,'佐藤輝','右打',1,'上',0,[true,true,false],'右投','三振',null,[],'日本',0,2),
            ab(28,'佐藤輝','右打',1,'上',2,[false,false,false],'右投','全壘打',hl('CF',0.50,0.06),[],'日本',2,2),
            ab(28,'佐藤輝','右打',2,'上',0,[false,false,false],'左投','三振',null,[],'日本',1,2),
            ab(28,'佐藤輝','右打',2,'上',1,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(28,'佐藤輝','右打',3,'上',0,[false,true,false],'右投','一壘安打',hl('1B',0.74,0.46),[],'日本',3,2),
            ab(28,'佐藤輝','右打',3,'上',2,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(28,'佐藤輝','右打',4,'上',0,[false,false,false],'左投','三振',null,[],'日本',2,2),
            ab(28,'佐藤輝','右打',4,'上',1,[true,false,false],'右投','飛球出局',hl('CF',0.48,0.14),[],'日本',1,2),
            ab(28,'佐藤輝','右打',5,'上',0,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(28,'佐藤輝','右打',5,'上',2,[false,false,false],'右投','全壘打',hl('LF',0.16,0.08),[],'日本',0,1),
            ab(28,'佐藤輝','右打',6,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(28,'佐藤輝','右打',6,'上',1,[false,true,false],'左投','三振',null,[],'日本',0,2),
            ab(28,'佐藤輝','右打',7,'上',0,[true,false,false],'右投','一壘安打',hl('RF',0.70,0.44),[],'日本',2,1),
            ab(28,'佐藤輝','右打',7,'上',2,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(28,'佐藤輝','右打',8,'上',0,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(28,'佐藤輝','右打',8,'上',1,[false,false,false],'右投','滾地球出局',hl('3B',0.28,0.54),[],'日本',2,2),
            ab(28,'佐藤輝','右打',9,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(28,'佐藤輝','右打',9,'上',2,[false,false,false],'左投','全壘打',hl('CF',0.48,0.07),[],'日本',1,2),

            // 5棒 #21 吉田正（左打，穩打型 打率.350 均衡）
            ab(21,'吉田正','左打',1,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.70,0.38),[],'日本',1,0),
            ab(21,'吉田正','左打',1,'上',2,[true,false,false],'右投','飛球出局',hl('LF',0.20,0.18),[],'日本',0,2),
            ab(21,'吉田正','左打',2,'上',0,[false,false,false],'右投','保送',null,[],'日本',3,1),
            ab(21,'吉田正','左打',2,'上',1,[true,true,false],'右投','一壘安打',hl('SS',0.38,0.45),['打帶跑'],'日本',0,1),
            ab(21,'吉田正','左打',3,'上',0,[false,false,false],'左投','二壘安打',hl('LCF',0.28,0.22),[],'日本',2,0),
            ab(21,'吉田正','左打',3,'上',2,[false,false,true],'右投','高飛犧牲打',hl('CF',0.50,0.15),[],'日本',1,2),
            ab(21,'吉田正','左打',4,'上',0,[false,false,false],'右投','滾地球出局',hl('3B',0.28,0.52),[],'日本',0,1),
            ab(21,'吉田正','左打',4,'上',1,[false,true,false],'右投','一壘安打',hl('RF',0.68,0.40),[],'日本',1,0),
            ab(21,'吉田正','左打',5,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(21,'吉田正','左打',5,'上',2,[true,false,false],'左投','一壘安打',hl('LF',0.22,0.40),[],'日本',0,2),
            ab(21,'吉田正','左打',6,'上',0,[false,false,false],'右投','二壘安打',hl('LCF',0.30,0.20),[],'日本',2,1),
            ab(21,'吉田正','左打',6,'上',1,[false,false,false],'右投','滾地球出局',hl('2B',0.60,0.54),[],'日本',1,2),
            ab(21,'吉田正','左打',7,'上',0,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(21,'吉田正','左打',7,'上',2,[true,false,false],'右投','一壘安打',hl('SS',0.40,0.43),[],'日本',0,0),
            ab(21,'吉田正','左打',8,'上',0,[false,true,false],'右投','犧牲觸擊',hl('三短',0.24,0.80),[],'日本',0,0),
            ab(21,'吉田正','左打',8,'上',1,[false,false,false],'左投','飛球出局',hl('LF',0.18,0.20),[],'日本',2,2),
            ab(21,'吉田正','左打',9,'上',0,[false,false,false],'右投','一壘安打',hl('RF',0.70,0.42),[],'日本',1,1),

            // 6棒 #33 鈴木誠（右打，盜壘型 打率.230）
            ab(33,'鈴木誠','右打',1,'上',0,[false,false,false],'右投','滾地球出局',hl('2B',0.60,0.55),[],'日本',1,0),
            ab(33,'鈴木誠','右打',1,'上',2,[false,false,false],'右投','一壘安打',hl('1B',0.72,0.44),[],'日本',0,2),
            ab(33,'鈴木誠','右打',2,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(33,'鈴木誠','右打',2,'上',1,[false,false,false],'左投','滾地球出局',hl('3B',0.30,0.54),[],'日本',0,1),
            ab(33,'鈴木誠','右打',3,'上',0,[true,false,false],'右投','一壘安打',hl('SS',0.40,0.44),['打帶跑'],'日本',1,1),
            ab(33,'鈴木誠','右打',3,'上',2,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(33,'鈴木誠','右打',4,'上',0,[false,false,false],'右投','飛球出局',hl('RF',0.72,0.20),[],'日本',2,2),
            ab(33,'鈴木誠','右打',4,'上',1,[true,false,false],'右投','滾地球出局',hl('3B',0.32,0.52),[],'日本',1,1),
            ab(33,'鈴木誠','右打',5,'上',0,[false,false,false],'右投','一壘安打',hl('1B',0.74,0.46),[],'日本',0,0),
            ab(33,'鈴木誠','右打',5,'上',2,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(33,'鈴木誠','右打',6,'上',0,[false,true,false],'右投','滾地球出局',hl('2B',0.62,0.52),[],'日本',0,1),
            ab(33,'鈴木誠','右打',6,'上',1,[false,false,false],'左投','一壘安打',hl('SS',0.42,0.44),[],'日本',1,0),
            ab(33,'鈴木誠','右打',7,'上',0,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(33,'鈴木誠','右打',7,'上',2,[true,false,false],'右投','飛球出局',hl('RF',0.70,0.18),[],'日本',0,2),
            ab(33,'鈴木誠','右打',8,'上',0,[false,false,false],'右投','保送',null,[],'日本',3,2),
            ab(33,'鈴木誠','右打',8,'上',1,[false,false,false],'右投','三振',null,[],'日本',2,2),

            // 7棒 #44 中村剛（右打，低威脅 三振率50% 打率.140）
            ab(44,'中村剛','右打',2,'上',0,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(44,'中村剛','右打',2,'上',1,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(44,'中村剛','右打',3,'上',0,[false,false,false],'右投','滾地球出局',hl('2B',0.62,0.54),[],'日本',2,1),
            ab(44,'中村剛','右打',3,'上',2,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(44,'中村剛','右打',4,'上',0,[false,false,false],'左投','一壘安打',hl('CF',0.50,0.32),[],'日本',1,1),
            ab(44,'中村剛','右打',4,'上',1,[false,true,false],'右投','飛球出局',hl('RF',0.68,0.22),[],'日本',2,2),
            ab(44,'中村剛','右打',5,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(44,'中村剛','右打',5,'上',2,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(44,'中村剛','右打',6,'上',0,[false,false,false],'右投','滾地球出局',hl('3B',0.30,0.55),[],'日本',0,1),
            ab(44,'中村剛','右打',6,'上',1,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(44,'中村剛','右打',7,'上',0,[false,false,false],'右投','飛球出局',hl('LF',0.22,0.20),[],'日本',1,2),
            ab(44,'中村剛','右打',7,'上',2,[false,false,false],'左投','一壘安打',hl('LCF',0.32,0.38),[],'日本',0,0),
            ab(44,'中村剛','右打',8,'上',0,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(44,'中村剛','右打',8,'上',1,[false,false,false],'右投','三振',null,[],'日本',2,2),

            // 8棒 #55 西川遙（左打，Squeeze/犧牲觸擊型 打率.200）
            ab(55,'西川遙','左打',2,'上',0,[false,false,true],'右投','犧牲觸擊',hl('三短',0.22,0.80),[],'日本',0,0),
            ab(55,'西川遙','左打',2,'上',2,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(55,'西川遙','左打',3,'上',0,[false,false,true],'左投','犧牲觸擊',hl('一短',0.78,0.82),[],'日本',0,0),
            ab(55,'西川遙','左打',3,'上',1,[false,false,false],'右投','保送',null,[],'日本',3,2),
            ab(55,'西川遙','左打',4,'上',0,[true,false,true],'右投','犧牲觸擊',hl('三短',0.20,0.78),[],'日本',0,0),
            ab(55,'西川遙','左打',4,'上',2,[false,false,false],'右投','滾地球出局',hl('3B',0.28,0.55),[],'日本',2,2),
            ab(55,'西川遙','左打',5,'上',0,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(55,'西川遙','左打',5,'上',1,[false,false,true],'右投','犧牲觸擊',hl('三短',0.22,0.82),[],'日本',0,0),
            ab(55,'西川遙','左打',6,'上',0,[false,false,false],'右投','飛球出局',hl('LF',0.18,0.20),[],'日本',1,2),
            ab(55,'西川遙','左打',6,'上',2,[false,false,false],'左投','一壘安打',hl('3B',0.26,0.45),[],'日本',2,1),
            ab(55,'西川遙','左打',7,'上',0,[false,true,false],'右投','高飛犧牲打',hl('CF',0.50,0.14),[],'日本',1,2),
            ab(55,'西川遙','左打',7,'上',1,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(55,'西川遙','左打',8,'上',0,[false,false,true],'右投','犧牲觸擊',hl('一短',0.76,0.80),[],'日本',0,0),
            ab(55,'西川遙','左打',8,'上',2,[false,false,false],'右投','保送',null,[],'日本',3,1),
            ab(55,'西川遙','左打',9,'上',0,[false,false,false],'右投','一壘安打',hl('LF',0.20,0.40),[],'日本',1,0),

            // 9棒 #2 山田哲（右打，偷點觸擊型 保送率高）
            ab(2,'山田哲','右打',1,'上',0,[false,false,false],'右投','三振',null,[],'日本',0,2),
            ab(2,'山田哲','右打',1,'上',2,[false,false,false],'右投','保送',null,[],'日本',3,2),
            ab(2,'山田哲','右打',2,'上',0,[true,false,false],'右投','犧牲觸擊',hl('三短',0.24,0.80),[],'日本',0,0),
            ab(2,'山田哲','右打',2,'上',2,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(2,'山田哲','右打',3,'上',0,[false,false,false],'右投','保送',null,['打帶跑'],'日本',3,1),
            ab(2,'山田哲','右打',3,'上',1,[true,false,false],'右投','一壘安打',hl('CF',0.50,0.35),['打帶跑'],'日本',0,1),
            ab(2,'山田哲','右打',4,'上',0,[false,false,false],'右投','三振',null,[],'日本',1,2),
            ab(2,'山田哲','右打',4,'上',2,[false,false,false],'右投','滾地球出局',hl('SS',0.42,0.50),[],'日本',0,2),
            ab(2,'山田哲','右打',5,'上',0,[true,true,false],'右投','打帶跑',null,['打帶跑'],'日本',1,0),
            ab(2,'山田哲','右打',5,'上',1,[false,false,false],'右投','保送',null,[],'日本',3,2),
            ab(2,'山田哲','右打',6,'上',0,[false,false,false],'右投','三振',null,[],'日本',2,2),
            ab(2,'山田哲','右打',6,'上',2,[true,false,false],'右投','一壘安打',hl('1B',0.74,0.46),['打帶跑'],'日本',0,0),
            ab(2,'山田哲','右打',7,'上',0,[false,false,false],'右投','犧牲觸擊',hl('三短',0.22,0.82),[],'日本',0,0),
            ab(2,'山田哲','右打',7,'上',2,[false,false,false],'左投','保送',null,[],'日本',3,2),
            ab(2,'山田哲','右打',8,'上',0,[false,true,false],'右投','三振',null,[],'日本',1,2),
            ab(2,'山田哲','右打',8,'上',1,[false,false,false],'右投','滾地球出局',hl('SS',0.40,0.52),[],'日本',2,1),
        ];

        // ── 韓國隊打者（5人 × 15打席） ──
        const krAtBats = [
            // #3 朴賢俊（右打，穩打型 打率.313）
            ab(3,'朴賢俊','右打',1,'下',0,[false,false,false],'右投','一壘安打',hl('1B',0.72,0.42),[],'韓國',0,1),
            ab(3,'朴賢俊','右打',1,'下',2,[false,false,false],'右投','滾地球出局',hl('3B',0.30,0.52),[],'韓國',1,2),
            ab(3,'朴賢俊','右打',2,'下',0,[false,false,false],'左投','一壘安打',hl('RF',0.70,0.40),[],'韓國',2,0),
            ab(3,'朴賢俊','右打',2,'下',1,[true,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(3,'朴賢俊','右打',3,'下',0,[false,false,false],'右投','飛球出局',hl('CF',0.50,0.18),[],'韓國',0,2),
            ab(3,'朴賢俊','右打',3,'下',2,[false,false,false],'右投','一壘安打',hl('2B',0.60,0.40),[],'韓國',2,2),
            ab(3,'朴賢俊','右打',4,'下',0,[false,true,false],'右投','二壘安打',hl('LCF',0.30,0.22),[],'韓國',1,0),
            ab(3,'朴賢俊','右打',4,'下',1,[false,false,false],'右投','滾地球出局',hl('2B',0.58,0.54),[],'韓國',0,1),
            ab(3,'朴賢俊','右打',5,'下',0,[false,false,false],'右投','三振',null,[],'韓國',2,2),
            ab(3,'朴賢俊','右打',5,'下',2,[true,false,false],'左投','一壘安打',hl('SS',0.42,0.44),[],'韓國',1,1),
            ab(3,'朴賢俊','右打',6,'下',0,[false,false,false],'右投','保送',null,[],'韓國',3,2),
            ab(3,'朴賢俊','右打',6,'下',1,[false,false,false],'右投','滾地球出局',hl('3B',0.28,0.52),[],'韓國',0,2),
            ab(3,'朴賢俊','右打',7,'下',0,[false,false,false],'右投','一壘安打',hl('1B',0.74,0.44),[],'韓國',1,1),
            ab(3,'朴賢俊','右打',7,'下',2,[false,false,false],'右投','飛球出局',hl('RF',0.70,0.20),[],'韓國',2,2),
            ab(3,'朴賢俊','右打',8,'下',0,[false,true,false],'右投','二壘安打',hl('LCF',0.28,0.24),[],'韓國',0,0),
            ab(3,'朴賢俊','右打',8,'下',2,[false,false,false],'右投','三振',null,[],'韓國',1,2),

            // #9 金光炫（右打，高三振率 44% 低威脅）
            ab(9,'金光炫','右打',1,'下',0,[false,false,false],'右投','三振',null,[],'韓國',0,2),
            ab(9,'金光炫','右打',1,'下',1,[false,false,false],'右投','保送',null,[],'韓國',3,2),
            ab(9,'金光炫','右打',2,'下',0,[false,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(9,'金光炫','右打',2,'下',2,[false,true,false],'右投','二壘安打',hl('LF',0.18,0.28),[],'韓國',2,2),
            ab(9,'金光炫','右打',3,'下',0,[false,false,false],'左投','三振',null,[],'韓國',2,2),
            ab(9,'金光炫','右打',3,'下',1,[false,false,false],'右投','滾地球出局',hl('SS',0.42,0.50),[],'韓國',0,1),
            ab(9,'金光炫','右打',4,'下',0,[false,false,false],'右投','三振',null,[],'韓國',0,2),
            ab(9,'金光炫','右打',4,'下',2,[false,false,false],'右投','飛球出局',hl('CF',0.50,0.18),[],'韓國',1,2),
            ab(9,'金光炫','右打',5,'下',0,[false,false,false],'右投','三振',null,[],'韓國',2,2),
            ab(9,'金光炫','右打',5,'下',1,[false,false,false],'右投','一壘安打',hl('RF',0.68,0.40),[],'韓國',1,1),
            ab(9,'金光炫','右打',6,'下',0,[false,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(9,'金光炫','右打',6,'下',2,[false,false,false],'右投','滾地球出局',hl('3B',0.30,0.54),[],'韓國',0,2),
            ab(9,'金光炫','右打',7,'下',0,[true,false,false],'右投','三振',null,[],'韓國',2,2),
            ab(9,'金光炫','右打',7,'下',1,[false,false,false],'右投','保送',null,[],'韓國',3,1),
            ab(9,'金光炫','右打',8,'下',0,[false,false,false],'右投','三振',null,[],'韓國',0,2),
            ab(9,'金光炫','右打',8,'下',2,[false,false,false],'右投','滾地球出局',hl('2B',0.60,0.54),[],'韓國',1,2),

            // #22 李泳厚（左打，均衡型 保送率高）
            ab(22,'李泳厚','左打',1,'下',0,[false,false,false],'右投','保送',null,[],'韓國',3,2),
            ab(22,'李泳厚','左打',1,'下',2,[false,false,false],'右投','一壘安打',hl('RF',0.68,0.38),[],'韓國',1,1),
            ab(22,'李泳厚','左打',2,'下',0,[true,false,false],'右投','犧牲觸擊',hl('三短',0.22,0.80),[],'韓國',0,0),
            ab(22,'李泳厚','左打',2,'下',1,[false,false,false],'右投','飛球出局',hl('LF',0.20,0.20),[],'韓國',2,2),
            ab(22,'李泳厚','左打',3,'下',0,[false,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(22,'李泳厚','左打',3,'下',2,[false,false,false],'右投','滾地球出局',hl('2B',0.62,0.54),[],'韓國',0,2),
            ab(22,'李泳厚','左打',4,'下',0,[false,false,false],'左投','保送',null,[],'韓國',3,1),
            ab(22,'李泳厚','左打',4,'下',1,[false,true,false],'右投','二壘安打',hl('LCF',0.28,0.24),[],'韓國',2,1),
            ab(22,'李泳厚','左打',5,'下',0,[false,false,false],'右投','一壘安打',hl('3B',0.26,0.45),[],'韓國',0,0),
            ab(22,'李泳厚','左打',5,'下',2,[false,false,false],'右投','飛球出局',hl('CF',0.50,0.16),[],'韓國',1,2),
            ab(22,'李泳厚','左打',6,'下',0,[true,false,false],'右投','一壘安打',hl('SS',0.40,0.44),['打帶跑'],'韓國',0,1),
            ab(22,'李泳厚','左打',6,'下',2,[false,false,false],'右投','三振',null,[],'韓國',2,2),
            ab(22,'李泳厚','左打',7,'下',0,[false,false,false],'右投','保送',null,[],'韓國',3,2),
            ab(22,'李泳厚','左打',7,'下',1,[false,false,false],'右投','滾地球出局',hl('3B',0.28,0.56),[],'韓國',1,1),
            ab(22,'李泳厚','左打',8,'下',0,[false,true,false],'右投','一壘安打',hl('RF',0.70,0.40),[],'韓國',2,0),

            // #35 崔志元（右打，中長打型 打率.267 三振率偏高）
            ab(35,'崔志元','右打',2,'下',0,[false,false,false],'右投','全壘打',hl('RF',0.70,0.10),[],'韓國',2,2),
            ab(35,'崔志元','右打',2,'下',1,[false,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(35,'崔志元','右打',3,'下',0,[true,false,false],'右投','一壘安打',hl('CF',0.50,0.35),[],'韓國',0,1),
            ab(35,'崔志元','右打',3,'下',2,[false,false,false],'左投','三振',null,[],'韓國',2,2),
            ab(35,'崔志元','右打',4,'下',0,[false,false,false],'右投','飛球出局',hl('LCF',0.30,0.15),[],'韓國',1,2),
            ab(35,'崔志元','右打',4,'下',1,[false,true,false],'右投','二壘安打',hl('RF',0.68,0.20),[],'韓國',0,0),
            ab(35,'崔志元','右打',5,'下',0,[false,false,false],'右投','三振',null,[],'韓國',0,2),
            ab(35,'崔志元','右打',5,'下',2,[false,false,false],'右投','滾地球出局',hl('2B',0.60,0.52),[],'韓國',2,2),
            ab(35,'崔志元','右打',6,'下',0,[false,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(35,'崔志元','右打',6,'下',1,[true,false,false],'右投','一壘安打',hl('1B',0.72,0.44),[],'韓國',2,1),
            ab(35,'崔志元','右打',7,'下',0,[false,false,false],'右投','全壘打',hl('CF',0.50,0.08),[],'韓國',3,2),
            ab(35,'崔志元','右打',7,'下',2,[false,false,false],'右投','三振',null,[],'韓國',0,2),
            ab(35,'崔志元','右打',8,'下',0,[false,true,false],'左投','飛球出局',hl('LF',0.18,0.18),[],'韓國',1,2),
            ab(35,'崔志元','右打',8,'下',1,[false,false,false],'右投','一壘安打',hl('RF',0.70,0.40),[],'韓國',0,0),
            ab(35,'崔志元','右打',9,'下',0,[false,false,false],'右投','三振',null,[],'韓國',2,2),

            // #17 朴勝昱（左打，盜壘型 打率.267）
            ab(17,'朴勝昱','左打',2,'下',0,[false,false,false],'右投','一壘安打',hl('3B',0.28,0.45),[],'韓國',1,0),
            ab(17,'朴勝昱','左打',2,'下',2,[false,false,false],'右投','三振',null,[],'韓國',2,2),
            ab(17,'朴勝昱','左打',3,'下',0,[false,false,false],'右投','滾地球出局',hl('3B',0.25,0.55),[],'韓國',0,1),
            ab(17,'朴勝昱','左打',3,'下',1,[true,false,false],'右投','二壘安打',hl('LF',0.15,0.25),['打帶跑'],'韓國',2,0),
            ab(17,'朴勝昱','左打',4,'下',0,[false,false,false],'右投','保送',null,[],'韓國',3,2),
            ab(17,'朴勝昱','左打',4,'下',2,[false,false,false],'右投','飛球出局',hl('LCF',0.30,0.18),[],'韓國',1,2),
            ab(17,'朴勝昱','左打',5,'下',0,[true,false,false],'右投','一壘安打',hl('SS',0.40,0.44),['打帶跑'],'韓國',0,0),
            ab(17,'朴勝昱','左打',5,'下',2,[false,false,false],'左投','三振',null,[],'韓國',0,2),
            ab(17,'朴勝昱','左打',6,'下',0,[false,false,false],'右投','滾地球出局',hl('2B',0.60,0.54),[],'韓國',2,1),
            ab(17,'朴勝昱','左打',6,'下',1,[false,true,false],'右投','一壘安打',hl('LF',0.20,0.42),[],'韓國',1,0),
            ab(17,'朴勝昱','左打',7,'下',0,[false,false,false],'右投','三振',null,[],'韓國',1,2),
            ab(17,'朴勝昱','左打',7,'下',2,[true,false,false],'右投','保送',null,[],'韓國',3,2),
            ab(17,'朴勝昱','左打',8,'下',0,[false,false,false],'右投','滾地球出局',hl('3B',0.26,0.54),[],'韓國',0,2),
            ab(17,'朴勝昱','左打',8,'下',1,[false,false,false],'右投','一壘安打',hl('RF',0.68,0.42),[],'韓國',2,1),
            ab(17,'朴勝昱','左打',9,'下',0,[false,false,false],'右投','飛球出局',hl('CF',0.50,0.17),[],'韓國',1,2),
        ];

        // ── 盜壘紀錄（日本隊） ──
        const demoSteals = [
            { number:'1', name:'田中健', fromBase:1, toBase:2, success:true,  inning:2, half:'上', outs:0, balls:1, strikes:0, ts: ago(3200000) },
            { number:'33',name:'鈴木誠', fromBase:1, toBase:2, success:true,  inning:3, half:'上', outs:1, balls:2, strikes:1, ts: ago(2800000) },
            { number:'1', name:'田中健', fromBase:2, toBase:3, success:false, inning:4, half:'上', outs:0, balls:0, strikes:0, ts: ago(2400000) },
            { number:'33',name:'鈴木誠', fromBase:1, toBase:2, success:true,  inning:5, half:'上', outs:1, balls:1, strikes:1, ts: ago(2000000) },
            { number:'2', name:'山田哲', fromBase:1, toBase:2, success:true,  inning:1, half:'上', outs:2, balls:2, strikes:0, ts: ago(3600000) },
            { number:'7', name:'松本遼', fromBase:1, toBase:2, success:false, inning:6, half:'上', outs:0, balls:0, strikes:1, ts: ago(1600000) },
            { number:'1', name:'田中健', fromBase:1, toBase:2, success:true,  inning:7, half:'上', outs:1, balls:3, strikes:1, ts: ago(1200000) },
        ];

        // 注入到 allData.bm
        _initBmData();
        allData.bm.atBats  = [...jpAtBats, ...krAtBats];
        allData.bm.steals  = demoSteals; // 統一存在 bm.steals，分析頁直接讀

        allData.bm.lineupA = [
            {number:'1', name:'田中健', hand:'右打', trait:'速球強打'},
            {number:'7', name:'松本遼', hand:'左打', trait:'觸擊犧牲型'},
            {number:'15',name:'大谷翔', hand:'右打', trait:'全能強打'},
            {number:'28',name:'佐藤輝', hand:'右打', trait:'長打三振型'},
            {number:'21',name:'吉田正', hand:'左打', trait:'穩打型'},
            {number:'33',name:'鈴木誠', hand:'右打', trait:'盜壘型'},
            {number:'44',name:'中村剛', hand:'右打', trait:''},
            {number:'55',name:'西川遙', hand:'左打', trait:'Squeeze型'},
            {number:'2', name:'山田哲', hand:'右打', trait:''},
        ];

        saveToLocalStorage();
        saveBmToFirebase();

        if (btn) { btn.textContent = '✅ 注入完成'; btn.disabled = false; }
        alert(`✅ 打者測試資料注入完成！\n\n日本隊：${jpAtBats.length} 打席（9人 × 約18打席）\n韓國隊：${krAtBats.length} 打席（5人 × 約15打席）\n盜壘記錄：${demoSteals.length} 筆\n\n請切換到「打者模式」查看統計、分析頁面。`);
    }

    async function adminInjectDemoData(evt) {
        if (!confirm(
            '注入女子快速壘球示範資料至管理員帳號？\n\n' +
            '⚠️ 這只會覆蓋管理員自己的測試資料庫（pitcherScoutData），\n' +
            '完全不影響任何已購買球隊的資料。\n\n確定繼續？'
        )) return;

        const btn = evt && evt.target;
        if (btn) { btn.textContent = '⏳ 注入中...'; btn.disabled = true; }

        try {
            function sp(type, zone, speed, o = {}) {
                const good = !String(zone).startsWith('B');
                return {
                    type, zone: String(zone),
                    result: good ? '好球' : '壞球',
                    speed: speed || null,
                    swing: o.sw  || false,
                    foul:  o.fo  || false,
                    wild:  false,
                    batterHand:   o.hand  || '右打',
                    batterNumber: o.num   != null ? String(o.num) : null,
                    batterOrder:  o.order != null ? String(o.order) : null,
                    outcomes: o.out ? [o.out] : [],
                    outcome:  o.out || null,
                    balls:    o.b ?? 0,
                    strikes:  o.s ?? 0,
                    runnersOn: o.ro || false,
                    basesSnapshot: [false, false, false],
                    timestamp: new Date().toISOString()
                };
            }

            // ════════════════════════════════════════════════
            // 陳雅婷 #1 右投 先發 速球型 ─ vs 日本 2026-08-10（7局，95球）
            // 球速 112-120｜主球種：快速球/上飄球｜含 1 支全壘打
            // ════════════════════════════════════════════════
            // ════════════════════════════════════════════════
            // 陳雅婷 #1 右投 先發 速球型 — vs 日本 2026-08-10
            // 球速 113-120｜7局完投｜92球｜1支全壘打（5局）
            // ════════════════════════════════════════════════
            const chen_jp = [
                // 1局上 (10球) #7左三振, #3右滾地球, #22右飛球
                sp('快速球','5',116,{hand:'左打',order:1,num:7,   b:0,s:0}),
                sp('快速球','2',118,{hand:'左打',order:1,num:7,   b:0,s:1,sw:true}),
                sp('上飄球','B14',107,{hand:'左打',order:1,num:7, b:1,s:1}),
                sp('快速球','6',117,{hand:'左打',order:1,num:7,   b:1,s:1,sw:true,out:'三振'}),
                sp('上飄球','8',110,{hand:'右打',order:2,num:3,   b:0,s:0}),
                sp('快速球','B1',115,{hand:'右打',order:2,num:3,  b:1,s:0}),
                sp('下墜球','3',103,{hand:'右打',order:2,num:3,   b:1,s:0,out:'滾地球出局'}),
                sp('快速球','4',117,{hand:'右打',order:3,num:22,  b:0,s:0}),
                sp('快速球','B2',115,{hand:'右打',order:3,num:22, b:1,s:0}),
                sp('上飄球','9',110,{hand:'右打',order:3,num:22,  b:1,s:0,out:'飛球出局'}),
                // 2局上 (13球) #15右三振, #11左一安, #18右飛球, #2右滾地球
                sp('快速球','5',116,{hand:'右打',order:4,num:15,  b:0,s:0}),
                sp('變速球','2',91, {hand:'右打',order:4,num:15,  b:0,s:1}),
                sp('快速球','B3',114,{hand:'右打',order:4,num:15, b:1,s:1}),
                sp('上飄球','7',108,{hand:'右打',order:4,num:15,  b:1,s:1}),
                sp('快速球','6',117,{hand:'右打',order:4,num:15,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'左打',order:5,num:11,  b:0,s:0}),
                sp('下墜球','B12',102,{hand:'左打',order:5,num:11,b:1,s:0}),
                sp('快速球','3',115,{hand:'左打',order:5,num:11,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',115,{hand:'右打',order:6,num:18,  b:0,s:0,ro:true}),
                sp('上飄球','8',109,{hand:'右打',order:6,num:18,  b:0,s:1,ro:true}),
                sp('內曲','B1',97, {hand:'右打',order:6,num:18,   b:1,s:1,ro:true}),
                sp('上飄球','9',109,{hand:'右打',order:6,num:18,  b:1,s:1,ro:true,out:'飛球出局'}),
                sp('下墜球','1',103,{hand:'右打',order:7,num:2,   b:0,s:0}),
                // 3局上 (13球) #2右滾地球, #24左三振, #1右一安, #7左滾地球
                sp('快速球','5',117,{hand:'右打',order:7,num:2,   b:0,s:1}),
                sp('快速球','B5',114,{hand:'右打',order:7,num:2,  b:1,s:1}),
                sp('下墜球','1',103,{hand:'右打',order:7,num:2,   b:1,s:1,out:'滾地球出局'}),
                sp('快速球','4',116,{hand:'左打',order:8,num:24,  b:0,s:0}),
                sp('下墜球','2',104,{hand:'左打',order:8,num:24,  b:0,s:1}),
                sp('快速球','B4',115,{hand:'左打',order:8,num:24, b:1,s:1}),
                sp('上飄球','6',108,{hand:'左打',order:8,num:24,  b:1,s:1,sw:true,out:'三振'}),
                sp('快速球','5',116,{hand:'右打',order:9,num:1,   b:0,s:0}),
                sp('快速球','B1',114,{hand:'右打',order:9,num:1,  b:1,s:0}),
                sp('上飄球','7',109,{hand:'右打',order:9,num:1,   b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'左打',order:1,num:7,   b:0,s:0,ro:true}),
                sp('變速球','2',90, {hand:'左打',order:1,num:7,   b:0,s:1,ro:true}),
                sp('快速球','3',115,{hand:'左打',order:1,num:7,   b:0,s:1,ro:true,out:'滾地球出局'}),
                // 4局上 (12球) #3右二安, #22右三振, #15右飛球, #11左滾地球
                sp('上飄球','8',109,{hand:'右打',order:2,num:3,   b:0,s:0}),
                sp('快速球','B2',115,{hand:'右打',order:2,num:3,  b:1,s:0}),
                sp('快速球','5',116,{hand:'右打',order:2,num:3,   b:1,s:0,out:'二壘安打'}),
                sp('快速球','6',117,{hand:'右打',order:3,num:22,  b:0,s:0,ro:true}),
                sp('變速球','2',90, {hand:'右打',order:3,num:22,  b:0,s:1,ro:true}),
                sp('快速球','5',118,{hand:'右打',order:3,num:22,  b:0,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'右打',order:4,num:15,  b:0,s:0,ro:true}),
                sp('上飄球','8',108,{hand:'右打',order:4,num:15,  b:0,s:1,ro:true}),
                sp('快速球','9',117,{hand:'右打',order:4,num:15,  b:0,s:2,ro:true,out:'飛球出局'}),
                sp('快速球','5',116,{hand:'左打',order:5,num:11,  b:0,s:0}),
                sp('內曲','1',98,   {hand:'左打',order:5,num:11,  b:0,s:1}),
                sp('快速球','3',115,{hand:'左打',order:5,num:11,  b:0,s:1,out:'滾地球出局'}),
                // 5局上 (16球) #18右保送, #2右全壘打!, #24左三振, #1右飛球
                sp('快速球','5',116,{hand:'右打',order:6,num:18,  b:0,s:0}),
                sp('快速球','B6',114,{hand:'右打',order:6,num:18, b:1,s:0}),
                sp('快速球','4',117,{hand:'右打',order:6,num:18,  b:1,s:0}),
                sp('快速球','B5',115,{hand:'右打',order:6,num:18, b:2,s:0}),
                sp('上飄球','B2',107,{hand:'右打',order:6,num:18, b:3,s:0,out:'保送'}),
                sp('快速球','5',116,{hand:'右打',order:7,num:2,   b:0,s:0,ro:true}),
                sp('上飄球','8',109,{hand:'右打',order:7,num:2,   b:0,s:1,ro:true}),
                sp('快速球','2',118,{hand:'右打',order:7,num:2,   b:0,s:1,ro:true,out:'全壘打'}),
                sp('下墜球','2',104,{hand:'左打',order:8,num:24,  b:0,s:0}),
                sp('快速球','5',116,{hand:'左打',order:8,num:24,  b:0,s:1}),
                sp('快速球','B3',114,{hand:'左打',order:8,num:24, b:1,s:1}),
                sp('快速球','6',117,{hand:'左打',order:8,num:24,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'右打',order:9,num:1,   b:0,s:0}),
                sp('上飄球','7',109,{hand:'右打',order:9,num:1,   b:0,s:1}),
                sp('上飄球','B8',107,{hand:'右打',order:9,num:1,  b:1,s:1}),
                sp('快速球','9',117,{hand:'右打',order:9,num:1,   b:1,s:1,out:'飛球出局'}),
                // 6局上 (14球) #7左三振, #3右一安, #22右三振, #15右滾地球
                sp('快速球','5',115,{hand:'左打',order:1,num:7,   b:0,s:0}),
                sp('快速球','2',117,{hand:'左打',order:1,num:7,   b:0,s:1}),
                sp('上飄球','B14',107,{hand:'左打',order:1,num:7, b:1,s:1}),
                sp('快速球','6',116,{hand:'左打',order:1,num:7,   b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',118,{hand:'右打',order:2,num:3,   b:0,s:0}),
                sp('快速球','B1',115,{hand:'右打',order:2,num:3,  b:1,s:0}),
                sp('上飄球','9',109,{hand:'右打',order:2,num:3,   b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'右打',order:3,num:22,  b:0,s:0,ro:true}),
                sp('變速球','2',90, {hand:'右打',order:3,num:22,  b:0,s:1,ro:true}),
                sp('快速球','B2',114,{hand:'右打',order:3,num:22, b:1,s:1,ro:true}),
                sp('快速球','6',117,{hand:'右打',order:3,num:22,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','5',116,{hand:'右打',order:4,num:15,  b:0,s:0,ro:true}),
                sp('下墜球','3',103,{hand:'右打',order:4,num:15,  b:0,s:1,ro:true}),
                sp('快速球','1',115,{hand:'右打',order:4,num:15,  b:0,s:1,ro:true,out:'滾地球出局'}),
                // 7局上 (14球) #11左一安, #18右三振, #2右飛球, #24左滾地球
                sp('快速球','5',116,{hand:'左打',order:5,num:11,  b:0,s:0}),
                sp('快速球','B6',114,{hand:'左打',order:5,num:11, b:1,s:0}),
                sp('快速球','4',117,{hand:'左打',order:5,num:11,  b:1,s:0}),
                sp('下墜球','3',103,{hand:'左打',order:5,num:11,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',115,{hand:'右打',order:6,num:18,  b:0,s:0,ro:true}),
                sp('上飄球','8',108,{hand:'右打',order:6,num:18,  b:0,s:1,ro:true}),
                sp('快速球','B1',114,{hand:'右打',order:6,num:18, b:1,s:1,ro:true}),
                sp('快速球','6',116,{hand:'右打',order:6,num:18,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'右打',order:7,num:2,   b:0,s:0,ro:true}),
                sp('上飄球','7',109,{hand:'右打',order:7,num:2,   b:0,s:1,ro:true}),
                sp('快速球','9',117,{hand:'右打',order:7,num:2,   b:0,s:2,ro:true,out:'飛球出局'}),
                sp('快速球','5',116,{hand:'左打',order:8,num:24,  b:0,s:0}),
                sp('內曲','1',97,   {hand:'左打',order:8,num:24,  b:0,s:1}),
                sp('快速球','3',115,{hand:'左打',order:8,num:24,  b:0,s:1,out:'滾地球出局'}),
            ]; // chen_jp: 10+13+13+12+16+14+14 = 92球

            // ════════════════════════════════════════════════
            // 林佳蓉 #18 左投 先發 變化球型 — vs 美國 2026-08-14
            // 球速 快速球100-108｜外曲95-103｜下墜球92-98｜變速球82-89
            // 7局先發｜90球｜1支全壘打（4局）
            // ════════════════════════════════════════════════
            const lin_us = [
                // 1局上 (10球) #4左飛球, #12左三振, #25右滾地球
                sp('外曲','6',100, {hand:'左打',order:1,num:4,   b:0,s:0}),
                sp('下墜球','2',95,{hand:'左打',order:1,num:4,   b:0,s:1}),
                sp('外曲','B7',98, {hand:'左打',order:1,num:4,   b:1,s:1}),
                sp('下墜球','9',96,{hand:'左打',order:1,num:4,   b:1,s:1,out:'飛球出局'}),
                sp('快速球','5',104,{hand:'左打',order:2,num:12, b:0,s:0}),
                sp('外曲','B3',99,{hand:'左打',order:2,num:12,  b:1,s:0}),
                sp('外曲','6',100,{hand:'左打',order:2,num:12,  b:1,s:0}),
                sp('變速球','4',85,{hand:'左打',order:2,num:12, b:1,s:1,sw:true,out:'三振'}),
                sp('下墜球','1',96,{hand:'右打',order:3,num:25, b:0,s:0}),
                sp('外曲','3',99, {hand:'右打',order:3,num:25,  b:0,s:0,out:'滾地球出局'}),
                // 2局上 (13球) #8右三振, #16右一安, #22右飛球, #3左滾地球
                sp('快速球','5',105,{hand:'右打',order:4,num:8,  b:0,s:0}),
                sp('外曲','6',101,{hand:'右打',order:4,num:8,   b:0,s:1}),
                sp('下墜球','B12',93,{hand:'右打',order:4,num:8,b:1,s:1}),
                sp('外曲','B8',99, {hand:'右打',order:4,num:8,  b:2,s:1}),
                sp('下墜球','2',95,{hand:'右打',order:4,num:8,  b:2,s:1,sw:true,out:'三振'}),
                sp('外曲','4',100,{hand:'右打',order:5,num:16,  b:0,s:0}),
                sp('快速球','B2',103,{hand:'右打',order:5,num:16,b:1,s:0}),
                sp('下墜球','3',96,{hand:'右打',order:5,num:16, b:1,s:0,out:'一壘安打'}),
                sp('外曲','6',101,{hand:'右打',order:6,num:22,  b:0,s:0,ro:true}),
                sp('變速球','1',84,{hand:'右打',order:6,num:22, b:0,s:1,ro:true}),
                sp('外曲','7',100,{hand:'右打',order:6,num:22,  b:0,s:2,ro:true,out:'飛球出局'}),
                sp('下墜球','2',96,{hand:'左打',order:7,num:3,  b:0,s:0}),
                sp('外曲','B7',99,{hand:'左打',order:7,num:3,   b:1,s:0}),
                // 3局上 (13球) #3左一安, #9右三振, #1左飛球, #4左滾地球
                sp('外曲','4',100,{hand:'左打',order:7,num:3,   b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',104,{hand:'右打',order:8,num:9, b:0,s:0,ro:true}),
                sp('外曲','9',100,{hand:'右打',order:8,num:9,   b:0,s:1,ro:true}),
                sp('下墜球','B13',93,{hand:'右打',order:8,num:9,b:1,s:1,ro:true}),
                sp('外曲','6',101,{hand:'右打',order:8,num:9,   b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('外曲','7',100,{hand:'左打',order:9,num:1,   b:0,s:0}),
                sp('下墜球','1',95,{hand:'左打',order:9,num:1,  b:0,s:1}),
                sp('外曲','9',101,{hand:'左打',order:9,num:1,   b:0,s:2,out:'飛球出局'}),
                sp('快速球','5',105,{hand:'左打',order:1,num:4, b:0,s:0}),
                sp('外曲','B2',99, {hand:'左打',order:1,num:4,  b:1,s:0}),
                sp('變速球','4',84,{hand:'左打',order:1,num:4,  b:1,s:0}),
                sp('外曲','3',100,{hand:'左打',order:1,num:4,   b:1,s:1,out:'滾地球出局'}),
                sp('外曲','6',101,{hand:'左打',order:2,num:12,  b:0,s:0}),
                // 4局上 (14球) #12左飛球, #25右三振, #8右全壘打!, #16右三振
                sp('下墜球','2',96,{hand:'左打',order:2,num:12, b:0,s:1}),
                sp('外曲','B7',99,{hand:'左打',order:2,num:12,  b:1,s:1}),
                sp('外曲','8',100,{hand:'左打',order:2,num:12,  b:1,s:2,out:'飛球出局'}),
                sp('快速球','5',106,{hand:'右打',order:3,num:25, b:0,s:0}),
                sp('外曲','6',101,{hand:'右打',order:3,num:25,  b:0,s:1}),
                sp('下墜球','B12',93,{hand:'右打',order:3,num:25,b:1,s:1}),
                sp('變速球','4',84,{hand:'右打',order:3,num:25, b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',105,{hand:'右打',order:4,num:8, b:0,s:0}),
                sp('外曲','B7',99, {hand:'右打',order:4,num:8,  b:1,s:0}),
                sp('快速球','5',106,{hand:'右打',order:4,num:8, b:1,s:0}),
                sp('外曲','9',101,{hand:'右打',order:4,num:8,   b:1,s:1}),
                sp('快速球','2',107,{hand:'右打',order:4,num:8, b:1,s:1,out:'全壘打'}),
                sp('外曲','6',100,{hand:'右打',order:5,num:16,  b:0,s:0}),
                sp('下墜球','3',95,{hand:'右打',order:5,num:16, b:0,s:1,out:'三振'}),
                // 5局上 (12球) #22右一安, #3左三振, #9右飛球, #1左滾地球
                sp('快速球','5',104,{hand:'右打',order:6,num:22, b:0,s:0}),
                sp('外曲','B8',99,{hand:'右打',order:6,num:22,  b:1,s:0}),
                sp('下墜球','3',96,{hand:'右打',order:6,num:22, b:1,s:0,out:'一壘安打'}),
                sp('外曲','6',101,{hand:'左打',order:7,num:3,   b:0,s:0,ro:true}),
                sp('變速球','1',84,{hand:'左打',order:7,num:3,  b:0,s:1,ro:true}),
                sp('外曲','B7',98,{hand:'左打',order:7,num:3,   b:1,s:1,ro:true}),
                sp('外曲','7',100,{hand:'左打',order:7,num:3,   b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','5',105,{hand:'右打',order:8,num:9, b:0,s:0}),
                sp('外曲','8',100,{hand:'右打',order:8,num:9,   b:0,s:1,out:'飛球出局'}),
                sp('下墜球','1',95,{hand:'左打',order:9,num:1,  b:0,s:0}),
                sp('外曲','4',100,{hand:'左打',order:9,num:1,   b:0,s:1}),
                sp('外曲','3',101,{hand:'左打',order:9,num:1,   b:0,s:2,out:'滾地球出局'}),
                // 6局上 (13球) #4左三振, #12左一安, #25右三振, #8右飛球
                sp('快速球','5',104,{hand:'左打',order:1,num:4, b:0,s:0}),
                sp('外曲','6',100,{hand:'左打',order:1,num:4,   b:0,s:1}),
                sp('下墜球','B12',93,{hand:'左打',order:1,num:4,b:1,s:1}),
                sp('外曲','7',101,{hand:'左打',order:1,num:4,   b:1,s:2,sw:true,out:'三振'}),
                sp('外曲','4',100,{hand:'左打',order:2,num:12,  b:0,s:0}),
                sp('快速球','B2',103,{hand:'左打',order:2,num:12,b:1,s:0}),
                sp('下墜球','3',96,{hand:'左打',order:2,num:12, b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',105,{hand:'右打',order:3,num:25, b:0,s:0,ro:true}),
                sp('外曲','6',101,{hand:'右打',order:3,num:25,  b:0,s:1,ro:true}),
                sp('下墜球','B13',93,{hand:'右打',order:3,num:25,b:1,s:1,ro:true}),
                sp('外曲','7',100,{hand:'右打',order:3,num:25,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('外曲','5',101,{hand:'右打',order:4,num:8,   b:0,s:0}),
                sp('下墜球','9',96,{hand:'右打',order:4,num:8,  b:0,s:1,out:'飛球出局'}),
                // 7局上 (15球) #16右一安, #22右三振, #3左飛球, #9右保送, #1左滾地球
                sp('外曲','4',100,{hand:'右打',order:5,num:16,  b:0,s:0}),
                sp('快速球','B2',103,{hand:'右打',order:5,num:16,b:1,s:0}),
                sp('外曲','3',99, {hand:'右打',order:5,num:16,  b:1,s:0,out:'一壘安打'}),
                sp('外曲','6',101,{hand:'右打',order:6,num:22,  b:0,s:0,ro:true}),
                sp('快速球','5',105,{hand:'右打',order:6,num:22, b:0,s:1,ro:true}),
                sp('外曲','B8',99,{hand:'右打',order:6,num:22,  b:1,s:1,ro:true}),
                sp('下墜球','2',96,{hand:'右打',order:6,num:22, b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('外曲','7',100,{hand:'左打',order:7,num:3,   b:0,s:0}),
                sp('快速球','B6',103,{hand:'左打',order:7,num:3,b:1,s:0}),
                sp('外曲','9',101,{hand:'左打',order:7,num:3,   b:1,s:0,out:'飛球出局'}),
                sp('外曲','B7',99,{hand:'右打',order:8,num:9,   b:0,s:0}),
                sp('外曲','B9',98,{hand:'右打',order:8,num:9,   b:1,s:0}),
                sp('快速球','B3',102,{hand:'右打',order:8,num:9,b:2,s:0}),
                sp('外曲','B5',99,{hand:'右打',order:8,num:9,   b:3,s:0,out:'保送'}),
                sp('快速球','5',104,{hand:'左打',order:9,num:1, b:0,s:0,ro:true}),
                // 保送後 #1滾地球結束 ── 等下補一球
                sp('外曲','3',100,{hand:'左打',order:9,num:1,   b:0,s:1,ro:true,out:'滾地球出局'}),
            ]; // lin_us: 10+13+13+14+12+13+16 = 91球 (最後16球含保送補2球)

            // ════════════════════════════════════════════════
            // 王美琪 #7 左投 先發 速度控制型 — vs 韓國 2026-08-16
            // 球速 快速球100-109｜內曲/外曲90-98｜變速球82-90
            // 7局先發｜90球｜1支全壘打（3局）
            // ════════════════════════════════════════════════
            const wang_kr = [
                // 1局上 (11球) #5左三振, #14右滾地球, #28右三振
                sp('快速球','5',106,{hand:'左打',order:1,num:5,  b:0,s:0}),
                sp('內曲','1',94,   {hand:'左打',order:1,num:5,  b:0,s:1}),
                sp('快速球','B6',104,{hand:'左打',order:1,num:5, b:1,s:1}),
                sp('外曲','6',93,   {hand:'左打',order:1,num:5,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',107,{hand:'右打',order:2,num:14, b:0,s:0}),
                sp('外曲','B8',92, {hand:'右打',order:2,num:14,  b:1,s:0}),
                sp('內曲','3',94,  {hand:'右打',order:2,num:14,  b:1,s:0,out:'滾地球出局'}),
                sp('快速球','5',108,{hand:'右打',order:3,num:28, b:0,s:0}),
                sp('變速球','2',86,{hand:'右打',order:3,num:28,  b:0,s:1}),
                sp('快速球','B4',106,{hand:'右打',order:3,num:28,b:1,s:1}),
                sp('內曲','1',94,   {hand:'右打',order:3,num:28, b:1,s:2,sw:true,out:'三振'}),
                // 2局上 (12球) #6右一安, #19左三振, #33右飛球, #5左滾地球
                sp('外曲','5',93,   {hand:'右打',order:4,num:6,  b:0,s:0}),
                sp('快速球','B1',105,{hand:'右打',order:4,num:6, b:1,s:0}),
                sp('變速球','3',87, {hand:'右打',order:4,num:6,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',107,{hand:'左打',order:5,num:19, b:0,s:0,ro:true}),
                sp('內曲','1',94,   {hand:'左打',order:5,num:19, b:0,s:1,ro:true}),
                sp('外曲','6',92,   {hand:'左打',order:5,num:19, b:0,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',108,{hand:'右打',order:6,num:33, b:0,s:0}),
                sp('變速球','8',86,{hand:'右打',order:6,num:33,  b:0,s:0,out:'飛球出局'}),
                sp('快速球','5',106,{hand:'左打',order:1,num:5,  b:0,s:0}),
                sp('外曲','B7',92, {hand:'左打',order:1,num:5,   b:1,s:0}),
                sp('快速球','3',107,{hand:'左打',order:1,num:5,  b:1,s:0}),
                sp('內曲','1',95,  {hand:'左打',order:1,num:5,   b:1,s:1,out:'滾地球出局'}),
                // 3局上 (14球) #14右二安, #28右全壘打!, #6右三振, #19左飛球
                sp('快速球','5',105,{hand:'右打',order:2,num:14, b:0,s:0}),
                sp('外曲','B8',92, {hand:'右打',order:2,num:14,  b:1,s:0}),
                sp('快速球','4',107,{hand:'右打',order:2,num:14, b:1,s:0,out:'二壘安打'}),
                sp('快速球','5',108,{hand:'右打',order:3,num:28, b:0,s:0,ro:true}),
                sp('內曲','1',94,   {hand:'右打',order:3,num:28, b:0,s:1,ro:true}),
                sp('快速球','B2',105,{hand:'右打',order:3,num:28,b:1,s:1,ro:true}),
                sp('外曲','4',93,   {hand:'右打',order:3,num:28, b:1,s:1,ro:true,out:'全壘打'}),
                sp('快速球','5',107,{hand:'右打',order:4,num:6,  b:0,s:0}),
                sp('變速球','2',87,{hand:'右打',order:4,num:6,   b:0,s:1}),
                sp('外曲','B7',92, {hand:'右打',order:4,num:6,   b:1,s:1}),
                sp('內曲','6',94,  {hand:'右打',order:4,num:6,   b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',108,{hand:'左打',order:5,num:19, b:0,s:0}),
                sp('外曲','7',93,  {hand:'左打',order:5,num:19,  b:0,s:1}),
                sp('快速球','9',107,{hand:'左打',order:5,num:19, b:0,s:2,out:'飛球出局'}),
                // 4局上 (12球) #33右三振, #5左一安, #14右飛球, #28右滾地球
                sp('快速球','5',107,{hand:'右打',order:6,num:33, b:0,s:0}),
                sp('內曲','1',94,   {hand:'右打',order:6,num:33, b:0,s:1}),
                sp('外曲','B8',91, {hand:'右打',order:6,num:33,  b:1,s:1}),
                sp('快速球','6',108,{hand:'右打',order:6,num:33, b:1,s:2,sw:true,out:'三振'}),
                sp('外曲','5',93,  {hand:'左打',order:1,num:5,   b:0,s:0}),
                sp('快速球','B6',105,{hand:'左打',order:1,num:5, b:1,s:0}),
                sp('變速球','3',86,{hand:'左打',order:1,num:5,   b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',107,{hand:'右打',order:2,num:14, b:0,s:0,ro:true}),
                sp('外曲','B7',92, {hand:'右打',order:2,num:14,  b:1,s:0,ro:true}),
                sp('快速球','9',108,{hand:'右打',order:2,num:14, b:1,s:0,ro:true,out:'飛球出局'}),
                sp('快速球','4',106,{hand:'右打',order:3,num:28, b:0,s:0}),
                sp('內曲','3',95,  {hand:'右打',order:3,num:28,  b:0,s:0,out:'滾地球出局'}),
                // 5局上 (13球) #6右保送, #19左三振, #33右飛球, #5左滾地球
                sp('快速球','B5',104,{hand:'右打',order:4,num:6, b:0,s:0}),
                sp('外曲','B8',91, {hand:'右打',order:4,num:6,   b:1,s:0}),
                sp('變速球','B4',86,{hand:'右打',order:4,num:6,  b:2,s:0}),
                sp('內曲','B1',93, {hand:'右打',order:4,num:6,   b:3,s:0,out:'保送'}),
                sp('快速球','5',107,{hand:'左打',order:5,num:19, b:0,s:0,ro:true}),
                sp('內曲','1',94,   {hand:'左打',order:5,num:19, b:0,s:1,ro:true}),
                sp('外曲','6',92,   {hand:'左打',order:5,num:19, b:0,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',108,{hand:'右打',order:6,num:33, b:0,s:0,ro:true}),
                sp('外曲','7',93,  {hand:'右打',order:6,num:33,  b:0,s:1,ro:true}),
                sp('快速球','8',107,{hand:'右打',order:6,num:33, b:0,s:2,ro:true,out:'飛球出局'}),
                sp('快速球','5',106,{hand:'左打',order:1,num:5,  b:0,s:0}),
                sp('變速球','2',87,{hand:'左打',order:1,num:5,   b:0,s:1}),
                sp('外曲','3',93,  {hand:'左打',order:1,num:5,   b:0,s:1,out:'滾地球出局'}),
                // 6局上 (14球) #14右二安, #28右三振, #6右飛球, #19左滾地球
                sp('快速球','5',107,{hand:'右打',order:2,num:14, b:0,s:0}),
                sp('外曲','B7',92, {hand:'右打',order:2,num:14,  b:1,s:0}),
                sp('快速球','4',108,{hand:'右打',order:2,num:14, b:1,s:0}),
                sp('內曲','B1',94, {hand:'右打',order:2,num:14,  b:2,s:0}),
                sp('快速球','5',107,{hand:'右打',order:2,num:14, b:2,s:0,out:'二壘安打'}),
                sp('快速球','5',108,{hand:'右打',order:3,num:28, b:0,s:0,ro:true}),
                sp('變速球','2',86,{hand:'右打',order:3,num:28,  b:0,s:1,ro:true}),
                sp('外曲','B8',92, {hand:'右打',order:3,num:28,  b:1,s:1,ro:true}),
                sp('內曲','6',95,  {hand:'右打',order:3,num:28,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',106,{hand:'右打',order:4,num:6,  b:0,s:0,ro:true}),
                sp('外曲','7',93,  {hand:'右打',order:4,num:6,   b:0,s:1,ro:true}),
                sp('快速球','9',107,{hand:'右打',order:4,num:6,  b:0,s:2,ro:true,out:'飛球出局'}),
                sp('快速球','5',106,{hand:'左打',order:5,num:19, b:0,s:0}),
                sp('內曲','3',94,  {hand:'左打',order:5,num:19,  b:0,s:0,out:'滾地球出局'}),
                // 7局上 (14球) #33右一安, #5左三振, #14右飛球, #28右滾地球
                sp('外曲','5',93,  {hand:'右打',order:6,num:33,  b:0,s:0}),
                sp('快速球','B1',105,{hand:'右打',order:6,num:33,b:1,s:0}),
                sp('變速球','3',87,{hand:'右打',order:6,num:33,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',107,{hand:'左打',order:1,num:5,  b:0,s:0,ro:true}),
                sp('內曲','1',94,   {hand:'左打',order:1,num:5,  b:0,s:1,ro:true}),
                sp('外曲','B7',92, {hand:'左打',order:1,num:5,   b:1,s:1,ro:true}),
                sp('快速球','6',108,{hand:'左打',order:1,num:5,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',107,{hand:'右打',order:2,num:14, b:0,s:0}),
                sp('外曲','8',93,  {hand:'右打',order:2,num:14,  b:0,s:1}),
                sp('快速球','B3',105,{hand:'右打',order:2,num:14,b:1,s:1}),
                sp('快速球','9',108,{hand:'右打',order:2,num:14, b:1,s:2,out:'飛球出局'}),
                sp('快速球','5',107,{hand:'右打',order:3,num:28, b:0,s:0}),
                sp('變速球','2',86,{hand:'右打',order:3,num:28,  b:0,s:1}),
                sp('內曲','3',94,  {hand:'右打',order:3,num:28,  b:0,s:1,out:'滾地球出局'}),
            ]; // wang_kr: 11+12+14+12+13+14+14 = 90球

            // ════════════════════════════════════════════════
            // 張淑芬 #23 右投 先發 全能型 — vs 澳洲 2026-08-18
            // 球速 快速球108-118｜上飄球103-111｜下墜球96-104｜外曲94-102｜變速球84-92
            // 7局先發｜94球｜1支全壘打（5局）
            // ════════════════════════════════════════════════
            const zhang_au = [
                // 1局上 (11球) #9右三振, #21左滾地球, #6右三振
                sp('快速球','5',113,{hand:'右打',order:1,num:9,  b:0,s:0}),
                sp('上飄球','8',106,{hand:'右打',order:1,num:9,  b:0,s:1}),
                sp('快速球','B3',111,{hand:'右打',order:1,num:9, b:1,s:1}),
                sp('快速球','6',114,{hand:'右打',order:1,num:9,  b:1,s:2,sw:true,out:'三振'}),
                sp('外曲','4',97,   {hand:'左打',order:2,num:21, b:0,s:0}),
                sp('快速球','B1',112,{hand:'左打',order:2,num:21,b:1,s:0}),
                sp('下墜球','3',100,{hand:'左打',order:2,num:21, b:1,s:0,out:'滾地球出局'}),
                sp('快速球','5',115,{hand:'右打',order:3,num:6,  b:0,s:0}),
                sp('快速球','2',116,{hand:'右打',order:3,num:6,  b:0,s:1}),
                sp('上飄球','B9',104,{hand:'右打',order:3,num:6, b:1,s:1}),
                sp('快速球','6',114,{hand:'右打',order:3,num:6,  b:1,s:2,sw:true,out:'三振'}),
                // 2局上 (13球) #15右一安, #30左三振, #8右飛球, #9右滾地球
                sp('快速球','5',112,{hand:'右打',order:4,num:15, b:0,s:0}),
                sp('外曲','B7',96, {hand:'右打',order:4,num:15,  b:1,s:0}),
                sp('下墜球','3',99,{hand:'右打',order:4,num:15,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',114,{hand:'左打',order:5,num:30, b:0,s:0,ro:true}),
                sp('上飄球','8',106,{hand:'左打',order:5,num:30, b:0,s:1,ro:true}),
                sp('快速球','B4',111,{hand:'左打',order:5,num:30,b:1,s:1,ro:true}),
                sp('快速球','6',115,{hand:'左打',order:5,num:30, b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',113,{hand:'右打',order:6,num:8,  b:0,s:0,ro:true}),
                sp('下墜球','7',100,{hand:'右打',order:6,num:8,  b:0,s:1,ro:true}),
                sp('快速球','9',115,{hand:'右打',order:6,num:8,  b:0,s:2,ro:true,out:'飛球出局'}),
                sp('快速球','5',113,{hand:'右打',order:1,num:9,  b:0,s:0}),
                sp('外曲','B8',95, {hand:'右打',order:1,num:9,   b:1,s:0}),
                sp('快速球','3',114,{hand:'右打',order:1,num:9,  b:1,s:0,out:'滾地球出局'}),
                // 3局上 (12球) #21左三振, #6右一安, #15右飛球, #30左滾地球
                sp('快速球','5',114,{hand:'左打',order:2,num:21, b:0,s:0}),
                sp('上飄球','8',107,{hand:'左打',order:2,num:21, b:0,s:1}),
                sp('快速球','6',116,{hand:'左打',order:2,num:21, b:0,s:2,sw:true,out:'三振'}),
                sp('外曲','5',97,  {hand:'右打',order:3,num:6,   b:0,s:0}),
                sp('快速球','B2',112,{hand:'右打',order:3,num:6, b:1,s:0}),
                sp('下墜球','3',100,{hand:'右打',order:3,num:6,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',114,{hand:'右打',order:4,num:15, b:0,s:0,ro:true}),
                sp('上飄球','9',106,{hand:'右打',order:4,num:15, b:0,s:1,ro:true}),
                sp('快速球','B3',111,{hand:'右打',order:4,num:15,b:1,s:1,ro:true}),
                sp('快速球','7',115,{hand:'右打',order:4,num:15, b:1,s:2,ro:true,out:'飛球出局'}),
                sp('變速球','4',87,{hand:'左打',order:5,num:30,  b:0,s:0}),
                sp('快速球','3',113,{hand:'左打',order:5,num:30, b:0,s:0,out:'滾地球出局'}),
                // 4局上 (12球) #8右二安, #9右三振, #21左飛球, #6右滾地球
                sp('快速球','5',113,{hand:'右打',order:6,num:8,  b:0,s:0}),
                sp('外曲','B7',95, {hand:'右打',order:6,num:8,   b:1,s:0}),
                sp('快速球','4',114,{hand:'右打',order:6,num:8,  b:1,s:0}),
                sp('下墜球','B12',98,{hand:'右打',order:6,num:8, b:2,s:0}),
                sp('快速球','5',115,{hand:'右打',order:6,num:8,  b:2,s:0,out:'二壘安打'}),
                sp('快速球','5',114,{hand:'右打',order:1,num:9,  b:0,s:0,ro:true}),
                sp('上飄球','8',107,{hand:'右打',order:1,num:9,  b:0,s:1,ro:true}),
                sp('快速球','6',116,{hand:'右打',order:1,num:9,  b:0,s:2,ro:true,sw:true,out:'三振'}),
                sp('外曲','4',97,   {hand:'左打',order:2,num:21, b:0,s:0,ro:true}),
                sp('快速球','7',114,{hand:'左打',order:2,num:21, b:0,s:1,ro:true}),
                sp('快速球','9',115,{hand:'左打',order:2,num:21, b:0,s:2,ro:true,out:'飛球出局'}),
                sp('快速球','5',113,{hand:'右打',order:3,num:6,  b:0,s:0}),
                // 5局上 (16球) #6右一安, #15右全壘打!, #30左三振, #8右飛球
                sp('外曲','B8',95, {hand:'右打',order:3,num:6,   b:1,s:0}),
                sp('快速球','4',114,{hand:'右打',order:3,num:6,  b:1,s:0}),
                sp('下墜球','B13',98,{hand:'右打',order:3,num:6, b:2,s:0}),
                sp('快速球','5',115,{hand:'右打',order:3,num:6,  b:2,s:0,out:'一壘安打'}),
                sp('快速球','5',114,{hand:'右打',order:4,num:15, b:0,s:0,ro:true}),
                sp('上飄球','8',107,{hand:'右打',order:4,num:15, b:0,s:1,ro:true}),
                sp('快速球','B2',112,{hand:'右打',order:4,num:15,b:1,s:1,ro:true}),
                sp('快速球','2',116,{hand:'右打',order:4,num:15, b:1,s:1,ro:true,out:'全壘打'}),
                sp('快速球','5',114,{hand:'左打',order:5,num:30, b:0,s:0}),
                sp('上飄球','8',107,{hand:'左打',order:5,num:30, b:0,s:1}),
                sp('快速球','B4',111,{hand:'左打',order:5,num:30,b:1,s:1}),
                sp('下墜球','6',100,{hand:'左打',order:5,num:30, b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',113,{hand:'右打',order:6,num:8,  b:0,s:0}),
                sp('外曲','7',97,   {hand:'右打',order:6,num:8,  b:0,s:1}),
                sp('快速球','B3',111,{hand:'右打',order:6,num:8, b:1,s:1}),
                sp('快速球','9',115,{hand:'右打',order:6,num:8,  b:1,s:2,out:'飛球出局'}),
                // 6局上 (15球) #9右一安, #21左三振, #6右保送, #15右飛球, #30左滾地球
                sp('快速球','5',113,{hand:'右打',order:1,num:9,  b:0,s:0}),
                sp('外曲','B7',95, {hand:'右打',order:1,num:9,   b:1,s:0}),
                sp('快速球','4',114,{hand:'右打',order:1,num:9,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',115,{hand:'左打',order:2,num:21, b:0,s:0,ro:true}),
                sp('上飄球','8',106,{hand:'左打',order:2,num:21, b:0,s:1,ro:true}),
                sp('快速球','6',116,{hand:'左打',order:2,num:21, b:0,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','B5',112,{hand:'右打',order:3,num:6, b:0,s:0,ro:true}),
                sp('外曲','B8',95, {hand:'右打',order:3,num:6,   b:1,s:0,ro:true}),
                sp('上飄球','B9',104,{hand:'右打',order:3,num:6, b:2,s:0,ro:true}),
                sp('快速球','B2',111,{hand:'右打',order:3,num:6, b:3,s:0,ro:true,out:'保送'}),
                sp('快速球','5',114,{hand:'右打',order:4,num:15, b:0,s:0,ro:true}),
                sp('快速球','8',115,{hand:'右打',order:4,num:15, b:0,s:1,ro:true}),
                sp('快速球','9',116,{hand:'右打',order:4,num:15, b:0,s:2,ro:true,out:'飛球出局'}),
                sp('變速球','4',87,{hand:'左打',order:5,num:30,  b:0,s:0,ro:true}),
                sp('快速球','3',113,{hand:'左打',order:5,num:30, b:0,s:0,ro:true,out:'滾地球出局'}),
                // 7局上 (15球) #8右三振, #9右一安, #21左三振, #6右滾地球
                sp('快速球','5',112,{hand:'右打',order:6,num:8,  b:0,s:0}),
                sp('上飄球','8',106,{hand:'右打',order:6,num:8,  b:0,s:1}),
                sp('快速球','B3',110,{hand:'右打',order:6,num:8, b:1,s:1}),
                sp('快速球','6',114,{hand:'右打',order:6,num:8,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','5',113,{hand:'右打',order:1,num:9,  b:0,s:0}),
                sp('外曲','B7',95, {hand:'右打',order:1,num:9,   b:1,s:0}),
                sp('下墜球','3',100,{hand:'右打',order:1,num:9,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',114,{hand:'左打',order:2,num:21, b:0,s:0,ro:true}),
                sp('快速球','2',116,{hand:'左打',order:2,num:21, b:0,s:1,ro:true}),
                sp('上飄球','B9',105,{hand:'左打',order:2,num:21,b:1,s:1,ro:true}),
                sp('快速球','6',115,{hand:'左打',order:2,num:21, b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',113,{hand:'右打',order:3,num:6,  b:0,s:0,ro:true}),
                sp('變速球','2',87,{hand:'右打',order:3,num:6,   b:0,s:1,ro:true}),
                sp('外曲','B8',95,{hand:'右打',order:3,num:6,    b:1,s:1,ro:true}),
                sp('快速球','3',113,{hand:'右打',order:3,num:6,  b:1,s:1,ro:true,out:'滾地球出局'}),
            ]; // zhang_au: 11+13+12+12+16+15+15 = 94球

            // ════════════════════════════════════════════════
            // 陳雅婷 #1 右投 先發 速球型 — vs 日本（複賽）2026-08-21
            // 球速 113-119｜7局先發｜91球｜1支全壘打（6局）
            // ════════════════════════════════════════════════
            const chen_jp2 = [
                // 1局上 (10球) #7左三振, #3右滾地球, #22右飛球
                sp('快速球','5',115,{hand:'左打',order:1,num:7,   b:0,s:0}),
                sp('上飄球','2',108,{hand:'左打',order:1,num:7,   b:0,s:1}),
                sp('快速球','B14',113,{hand:'左打',order:1,num:7, b:1,s:1}),
                sp('快速球','6',116,{hand:'左打',order:1,num:7,   b:1,s:2,sw:true,out:'三振'}),
                sp('下墜球','8',102,{hand:'右打',order:2,num:3,   b:0,s:0}),
                sp('快速球','5',115,{hand:'右打',order:2,num:3,   b:0,s:1}),
                sp('下墜球','3',101,{hand:'右打',order:2,num:3,   b:0,s:1,out:'滾地球出局'}),
                sp('快速球','4',117,{hand:'右打',order:3,num:22,  b:0,s:0}),
                sp('快速球','B2',115,{hand:'右打',order:3,num:22, b:1,s:0}),
                sp('上飄球','9',109,{hand:'右打',order:3,num:22,  b:1,s:0,out:'飛球出局'}),
                // 2局上 (14球) #15右保送, #11左三振, #18右二安, #2右飛球
                sp('快速球','B5',113,{hand:'右打',order:4,num:15, b:0,s:0}),
                sp('快速球','B3',114,{hand:'右打',order:4,num:15, b:1,s:0}),
                sp('上飄球','B8',107,{hand:'右打',order:4,num:15, b:2,s:0}),
                sp('快速球','B1',113,{hand:'右打',order:4,num:15, b:3,s:0,out:'保送'}),
                sp('快速球','4',116,{hand:'左打',order:5,num:11,  b:0,s:0,ro:true}),
                sp('下墜球','2',103,{hand:'左打',order:5,num:11,  b:0,s:1,ro:true}),
                sp('快速球','B6',113,{hand:'左打',order:5,num:11, b:1,s:1,ro:true}),
                sp('快速球','6',117,{hand:'左打',order:5,num:11,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','5',115,{hand:'右打',order:6,num:18,  b:0,s:0,ro:true}),
                sp('上飄球','B9',107,{hand:'右打',order:6,num:18, b:1,s:0,ro:true}),
                sp('快速球','5',116,{hand:'右打',order:6,num:18,  b:1,s:0,ro:true,out:'二壘安打'}),
                sp('快速球','4',116,{hand:'右打',order:7,num:2,   b:0,s:0,ro:true}),
                sp('上飄球','8',109,{hand:'右打',order:7,num:2,   b:0,s:1,ro:true}),
                sp('快速球','9',117,{hand:'右打',order:7,num:2,   b:0,s:2,ro:true,out:'飛球出局'}),
                // 3局上 (12球) #24左三振, #1右一安, #7左三振, #3右滾地球
                sp('快速球','5',116,{hand:'左打',order:8,num:24,  b:0,s:0}),
                sp('變速球','2',90, {hand:'左打',order:8,num:24,  b:0,s:1}),
                sp('快速球','B4',114,{hand:'左打',order:8,num:24, b:1,s:1}),
                sp('上飄球','6',108,{hand:'左打',order:8,num:24,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','5',115,{hand:'右打',order:9,num:1,   b:0,s:0}),
                sp('快速球','B1',113,{hand:'右打',order:9,num:1,  b:1,s:0}),
                sp('下墜球','3',102,{hand:'右打',order:9,num:1,   b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'左打',order:1,num:7,   b:0,s:0,ro:true}),
                sp('快速球','6',117,{hand:'左打',order:1,num:7,   b:0,s:1,ro:true}),
                sp('上飄球','7',108,{hand:'左打',order:1,num:7,   b:0,s:2,ro:true,sw:true,out:'三振'}),
                sp('下墜球','2',102,{hand:'右打',order:2,num:3,   b:0,s:0}),
                sp('快速球','1',115,{hand:'右打',order:2,num:3,   b:0,s:0,out:'滾地球出局'}),
                // 4局上 (12球) #22右三振, #15右飛球, #11左一安, #18右三振
                sp('快速球','5',117,{hand:'右打',order:3,num:22,  b:0,s:0}),
                sp('快速球','2',118,{hand:'右打',order:3,num:22,  b:0,s:1}),
                sp('上飄球','B3',108,{hand:'右打',order:3,num:22, b:1,s:1}),
                sp('快速球','6',117,{hand:'右打',order:3,num:22,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'右打',order:4,num:15,  b:0,s:0}),
                sp('上飄球','8',108,{hand:'右打',order:4,num:15,  b:0,s:1}),
                sp('快速球','9',117,{hand:'右打',order:4,num:15,  b:0,s:2,out:'飛球出局'}),
                sp('快速球','5',115,{hand:'左打',order:5,num:11,  b:0,s:0}),
                sp('下墜球','B12',102,{hand:'左打',order:5,num:11,b:1,s:0}),
                sp('快速球','3',116,{hand:'左打',order:5,num:11,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'右打',order:6,num:18,  b:0,s:0,ro:true}),
                sp('快速球','6',117,{hand:'右打',order:6,num:18,  b:0,s:1,ro:true}),
                // 5局上 (13球) #18右三振(延), #2右飛球, #24左一安, #1右滾地球
                sp('上飄球','B9',108,{hand:'右打',order:6,num:18, b:1,s:1,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'右打',order:7,num:2,   b:0,s:0}),
                sp('上飄球','8',109,{hand:'右打',order:7,num:2,   b:0,s:1}),
                sp('快速球','9',117,{hand:'右打',order:7,num:2,   b:0,s:2,out:'飛球出局'}),
                sp('快速球','5',115,{hand:'左打',order:8,num:24,  b:0,s:0}),
                sp('快速球','B6',113,{hand:'左打',order:8,num:24, b:1,s:0}),
                sp('下墜球','3',102,{hand:'左打',order:8,num:24,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'右打',order:9,num:1,   b:0,s:0,ro:true}),
                sp('變速球','2',90, {hand:'右打',order:9,num:1,   b:0,s:1,ro:true}),
                sp('快速球','B2',114,{hand:'右打',order:9,num:1,  b:1,s:1,ro:true}),
                sp('快速球','3',115,{hand:'右打',order:9,num:1,   b:1,s:1,ro:true,out:'滾地球出局'}),
                sp('快速球','5',116,{hand:'左打',order:1,num:7,   b:0,s:0}),
                sp('上飄球','7',108,{hand:'左打',order:1,num:7,   b:0,s:1}),
                // 6局上 (16球) #7左全壘打!, #3右三振, #22右飛球, #15右一安, #11左滾地球
                sp('快速球','2',117,{hand:'左打',order:1,num:7,   b:0,s:1,out:'全壘打'}),
                sp('快速球','5',116,{hand:'右打',order:2,num:3,   b:0,s:0}),
                sp('下墜球','2',102,{hand:'右打',order:2,num:3,   b:0,s:1}),
                sp('快速球','B3',114,{hand:'右打',order:2,num:3,  b:1,s:1}),
                sp('快速球','6',117,{hand:'右打',order:2,num:3,   b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','4',116,{hand:'右打',order:3,num:22,  b:0,s:0}),
                sp('上飄球','8',109,{hand:'右打',order:3,num:22,  b:0,s:1}),
                sp('快速球','9',117,{hand:'右打',order:3,num:22,  b:0,s:2,out:'飛球出局'}),
                sp('快速球','5',115,{hand:'右打',order:4,num:15,  b:0,s:0}),
                sp('快速球','B5',113,{hand:'右打',order:4,num:15, b:1,s:0}),
                sp('下墜球','3',101,{hand:'右打',order:4,num:15,  b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'左打',order:5,num:11,  b:0,s:0,ro:true}),
                sp('快速球','B6',113,{hand:'左打',order:5,num:11, b:1,s:0,ro:true}),
                sp('內曲','1',97,   {hand:'左打',order:5,num:11,  b:1,s:0,ro:true}),
                sp('快速球','B4',114,{hand:'左打',order:5,num:11, b:2,s:0,ro:true}),
                sp('快速球','3',115,{hand:'左打',order:5,num:11,  b:2,s:0,ro:true,out:'滾地球出局'}),
                // 7局上 (14球) #18右三振, #2右一安, #24左三振, #1右飛球
                sp('快速球','5',114,{hand:'右打',order:6,num:18,  b:0,s:0}),
                sp('上飄球','8',107,{hand:'右打',order:6,num:18,  b:0,s:1}),
                sp('快速球','B3',112,{hand:'右打',order:6,num:18, b:1,s:1}),
                sp('快速球','6',115,{hand:'右打',order:6,num:18,  b:1,s:2,sw:true,out:'三振'}),
                sp('快速球','5',115,{hand:'右打',order:7,num:2,   b:0,s:0}),
                sp('快速球','B1',113,{hand:'右打',order:7,num:2,  b:1,s:0}),
                sp('下墜球','3',101,{hand:'右打',order:7,num:2,   b:1,s:0,out:'一壘安打'}),
                sp('快速球','5',116,{hand:'左打',order:8,num:24,  b:0,s:0,ro:true}),
                sp('下墜球','2',102,{hand:'左打',order:8,num:24,  b:0,s:1,ro:true}),
                sp('快速球','B4',113,{hand:'左打',order:8,num:24, b:1,s:1,ro:true}),
                sp('快速球','6',116,{hand:'左打',order:8,num:24,  b:1,s:2,ro:true,sw:true,out:'三振'}),
                sp('快速球','4',115,{hand:'右打',order:9,num:1,   b:0,s:0,ro:true}),
                sp('上飄球','7',108,{hand:'右打',order:9,num:1,   b:0,s:1,ro:true}),
                sp('快速球','9',116,{hand:'右打',order:9,num:1,   b:0,s:2,ro:true,out:'飛球出局'}),
            ]; // chen_jp2: 10+14+12+12+13+16+14 = 91球

            // ── 組裝比賽資料（5場，4位投手）──
            const demoTeams = [
                {
                    gameName: '2026 世界女壘錦標賽',
                    name: '中華台北', opponent: '日本',
                    date: '2026-08-10',
                    pitchers: [{
                        name: '陳雅婷', number: '1',
                        hand: '右投', role: '先發', style: '速球型',
                        pitches: chen_jp,
                        score: { home: 3, away: 2, inning: 7, half: '上' }
                    }]
                },
                {
                    gameName: '2026 世界女壘錦標賽',
                    name: '中華台北', opponent: '美國',
                    date: '2026-08-14',
                    pitchers: [{
                        name: '林佳蓉', number: '18',
                        hand: '左投', role: '先發', style: '變化球型',
                        pitches: lin_us,
                        score: { home: 2, away: 3, inning: 7, half: '上' }
                    }]
                },
                {
                    gameName: '2026 世界女壘錦標賽',
                    name: '中華台北', opponent: '韓國',
                    date: '2026-08-16',
                    pitchers: [{
                        name: '王美琪', number: '7',
                        hand: '左投', role: '先發', style: '速度控制型',
                        pitches: wang_kr,
                        score: { home: 4, away: 3, inning: 7, half: '上' }
                    }]
                },
                {
                    gameName: '2026 世界女壘錦標賽',
                    name: '中華台北', opponent: '澳洲',
                    date: '2026-08-18',
                    pitchers: [{
                        name: '張淑芬', number: '23',
                        hand: '右投', role: '先發', style: '全能型',
                        pitches: zhang_au,
                        score: { home: 5, away: 2, inning: 7, half: '上' }
                    }]
                },
                {
                    gameName: '2026 世界女壘錦標賽',
                    name: '中華台北', opponent: '日本（複賽）',
                    date: '2026-08-21',
                    pitchers: [{
                        name: '陳雅婷', number: '1',
                        hand: '右投', role: '先發', style: '速球型',
                        pitches: chen_jp2,
                        score: { home: 2, away: 1, inning: 7, half: '上' }
                    }]
                }
            ];

            // ── 為示範資料附加打者姓名 + 打擊落點（讓打者情蒐功能有可看的資料）──
            // 依對手球隊 + 背號 對應到打者姓名
            const BATTER_NAMES = {
                '日本': { 7:'山田由香', 3:'佐藤美咲', 22:'鈴木花子', 15:'高橋愛', 11:'伊藤茜', 18:'渡邊麻衣', 2:'田中沙織', 24:'中村優子', 1:'小林彩香' },
                '美國': { 5:'Smith', 9:'Johnson', 12:'Williams', 23:'Brown', 8:'Jones', 14:'Garcia', 3:'Miller', 17:'Davis', 6:'Rodriguez' },
                '韓國': { 4:'金智妍', 8:'李秀珍', 16:'朴敏惠', 21:'崔恩珠', 9:'鄭素英', 25:'姜美京', 13:'尹智慧', 7:'吳善花', 19:'林娜英' },
                '加拿大': { 10:'Anderson', 22:'Thompson', 6:'Wilson', 18:'Martin', 3:'Taylor', 14:'Lee', 27:'White', 5:'Harris', 8:'Clark' },
                '澳洲': { 11:'Walker', 23:'Hall', 7:'Allen', 4:'Young', 16:'King', 28:'Wright', 9:'Scott', 12:'Green', 19:'Baker' }
            };
            // 落點隨機產生器：根據打擊結果決定落點區域
            function generateHitLocation(outcome) {
                const r = () => Math.random();
                let zone, x, y;
                if (outcome === '全壘打') {
                    zone = ['LF','CF','RF'][Math.floor(r()*3)];
                    y = 0.05 + r() * 0.15;
                } else if (outcome === '三壘安打' || outcome === '二壘安打') {
                    zone = ['LF','LCF','CF','RCF','RF'][Math.floor(r()*5)];
                    y = 0.15 + r() * 0.2;
                } else if (outcome === '一壘安打' || outcome === '飛球出局' || outcome === '高飛犧牲打') {
                    zone = ['LF','LCF','CF','RCF','RF'][Math.floor(r()*5)];
                    y = 0.2 + r() * 0.3;
                } else if (outcome === '內野安打' || outcome === '滾地球出局') {
                    zone = ['3B','SS','2B','1B','P'][Math.floor(r()*5)];
                    y = 0.45 + r() * 0.25;
                } else if (outcome === '犧牲觸擊') {
                    zone = ['三短','本壘前','一短'][Math.floor(r()*3)];
                    y = 0.78 + r() * 0.15;
                } else if (outcome === '平飛球出局') {
                    zone = ['LCF','CF','RCF'][Math.floor(r()*3)];
                    y = 0.3 + r() * 0.2;
                } else {
                    zone = ['LF','CF','RF'][Math.floor(r()*3)];
                    y = 0.3 + r() * 0.3;
                }
                // 依 zone 設定 x（加些隨機）
                const zoneXBase = { 'LF':0.1, 'LCF':0.27, 'CF':0.5, 'RCF':0.73, 'RF':0.9,
                                   '3B':0.34, 'SS':0.45, 'P':0.5, '2B':0.55, '1B':0.66,
                                   '三短':0.32, '本壘前':0.5, '一短':0.68 };
                x = (zoneXBase[zone] || 0.5) + (r() - 0.5) * 0.08;
                x = Math.max(0.05, Math.min(0.95, x));
                return { x: parseFloat(x.toFixed(3)), y: parseFloat(y.toFixed(3)), zone };
            }
            // 處理每場每球：附加 batterName + hitLocation
            const PA_END = ['滾地球出局','飛球出局','平飛球出局','高飛犧牲打','犧牲觸擊','三振','不死三振',
                '內野安打','一壘安打','二壘安打','三壘安打','全壘打','保送','觸身球','野選','失誤'];
            const BIP = ['滾地球出局','飛球出局','平飛球出局','高飛犧牲打','犧牲觸擊','雙殺',
                '內野安打','一壘安打','二壘安打','三壘安打','全壘打','野選','失誤'];
            demoTeams.forEach(team => {
                const names = BATTER_NAMES[team.opponent] || {};
                team.pitchers.forEach(pitcher => {
                    pitcher.pitches.forEach(pitch => {
                        // batterName
                        if (pitch.batterNumber && names[pitch.batterNumber]) {
                            pitch.batterName = names[pitch.batterNumber];
                        }
                        // hitLocation（球有進場時）
                        if (pitch.outcomes && pitch.outcomes.some(o => BIP.includes(o))) {
                            const outcome = pitch.outcomes.find(o => BIP.includes(o));
                            pitch.hitLocation = generateHitLocation(outcome);
                        }
                    });
                });
            });

            // ── 獨立打者情蒐示範資料（3 位打者，每位 5-7 個打席）──
            const demoBatterData = [
                {
                    id: Date.now(), name: '張育成', number: '5', hand: '右打',
                    team: '富邦悍將', gameName: '2026 中職春訓對抗賽', date: '2026-03-15',
                    atBats: [
                        { inning:1, half:'上', balls:1, strikes:2, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'一壘安打', hitLocation:{x:0.28,y:0.32,zone:'LCF'}, note:'高滑球推打反向', timestamp:'2026-03-15T13:10:00Z' },
                        { inning:3, half:'上', balls:0, strikes:1, runnersOn:true, isBunt:false, isRunAndHit:true, isPinch:false,
                          outcome:'二壘安打', hitLocation:{x:0.72,y:0.25,zone:'RCF'}, note:'跑打成功', timestamp:'2026-03-15T13:35:00Z' },
                        { inning:5, half:'上', balls:0, strikes:2, runnersOn:true, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'三振', hitLocation:null, note:'外角滑球揮空', timestamp:'2026-03-15T14:00:00Z' },
                        { inning:7, half:'上', balls:3, strikes:1, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'保送', hitLocation:null, note:null, timestamp:'2026-03-15T14:25:00Z' },
                        { inning:9, half:'上', balls:1, strikes:1, runnersOn:true, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'全壘打', hitLocation:{x:0.18,y:0.08,zone:'LF'}, note:'掃出左外野', timestamp:'2026-03-15T14:55:00Z' },
                    ]
                },
                {
                    id: Date.now()+1, name: '陳子豪', number: '32', hand: '左打',
                    team: '中信兄弟', gameName: '2026 中職春訓對抗賽', date: '2026-03-18',
                    atBats: [
                        { inning:1, half:'下', balls:0, strikes:0, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'滾地球出局', hitLocation:{x:0.66,y:0.55,zone:'1B'}, note:'內角速球擠到右半邊', timestamp:'2026-03-18T18:35:00Z' },
                        { inning:3, half:'下', balls:2, strikes:1, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'一壘安打', hitLocation:{x:0.86,y:0.32,zone:'RF'}, note:'拉右外野空檔', timestamp:'2026-03-18T19:05:00Z' },
                        { inning:5, half:'下', balls:1, strikes:0, runnersOn:true, isBunt:true, isRunAndHit:false, isPinch:false,
                          outcome:'犧牲觸擊', hitLocation:{x:0.32,y:0.82,zone:'三短'}, note:'戰術短打', timestamp:'2026-03-18T19:30:00Z' },
                        { inning:7, half:'下', balls:0, strikes:2, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'飛球出局', hitLocation:{x:0.78,y:0.22,zone:'RCF'}, note:null, timestamp:'2026-03-18T20:00:00Z' },
                        { inning:8, half:'下', balls:3, strikes:2, runnersOn:true, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'二壘安打', hitLocation:{x:0.88,y:0.18,zone:'RF'}, note:'追平比數', timestamp:'2026-03-18T20:25:00Z' },
                        { inning:10, half:'下', balls:1, strikes:1, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:true,
                          outcome:'三振', hitLocation:null, note:'代打三振', timestamp:'2026-03-18T20:55:00Z' },
                    ]
                },
                {
                    id: Date.now()+2, name: '林安可', number: '12', hand: '右打',
                    team: '統一獅', gameName: '2026 中職春訓對抗賽', date: '2026-03-22',
                    atBats: [
                        { inning:2, half:'上', balls:1, strikes:1, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'平飛球出局', hitLocation:{x:0.5,y:0.42,zone:'CF'}, note:'平飛被接殺', timestamp:'2026-03-22T13:20:00Z' },
                        { inning:4, half:'上', balls:2, strikes:2, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'全壘打', hitLocation:{x:0.5,y:0.05,zone:'CF'}, note:'扛中外野大牆', timestamp:'2026-03-22T13:50:00Z' },
                        { inning:6, half:'上', balls:0, strikes:1, runnersOn:true, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'三壘安打', hitLocation:{x:0.12,y:0.12,zone:'LF'}, note:null, timestamp:'2026-03-22T14:20:00Z' },
                        { inning:8, half:'上', balls:1, strikes:2, runnersOn:false, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'三振', hitLocation:null, note:null, timestamp:'2026-03-22T14:50:00Z' },
                        { inning:9, half:'上', balls:2, strikes:0, runnersOn:true, isBunt:false, isRunAndHit:false, isPinch:false,
                          outcome:'一壘安打', hitLocation:{x:0.62,y:0.36,zone:'RCF'}, note:'掃中右外野', timestamp:'2026-03-22T15:15:00Z' },
                    ]
                }
            ];

            // 寫入管理員專屬路徑（pitcherScoutData），不觸碰 teams/{code}
            await db.ref('pitcherScoutData').set({ teams: demoTeams, batterData: demoBatterData });

            // 注入完成後立即更新本地狀態與 UI（不等 Firebase listener）
            allData.teams    = JSON.parse(JSON.stringify(demoTeams));
            allData.batterData = JSON.parse(JSON.stringify(demoBatterData));
            allData.pitcherDB = {};
            rebuildPitcherDB();
            saveToLocalStorage();
            updateTeamList();
            updateSlotDisplay();
            updatePitchLog();
            updateStats();
            updateScoreboard();

            const totals = demoTeams.map(t =>
                `• vs ${t.opponent}（${t.date}）：${t.pitchers.map(p => `${p.name} #${p.number}（${p.pitches.length}球）`).join('、')}`
            ).join('\n');

            if (btn) {
                btn.textContent = '✅ 注入完成';
                setTimeout(() => { btn.textContent = '🎽 注入女子壘球示範資料'; btn.disabled = false; }, 2500);
            }
            alert(
                '✅ 女子快速壘球示範資料已注入！\n\n' +
                '📊 5場比賽 × 4位投手：\n' + totals + '\n\n' +
                '側邊欄已更新，展開「2026 世界女壘錦標賽」即可選擇投手。'
            );
        } catch (e) {
            if (btn) { btn.textContent = '❌ 失敗'; btn.disabled = false; }
            alert('注入失敗：' + e.message);
        }
    }

    // ====== 打者情蒐模組 ======

    let _hitLocCallback = null;
    let _hitLocSelectedLoc = null;
    let _runsChipContext = null;
    let _selectedRunsCount = 0;
    let _buntBasesContext = null;
    let _buntBasesSelected = [false, false, false];
    let _batterSource = 'pitcher'; // 'pitcher' | 'standalone'
    let _batterTeamFilter = null;  // null = 全部；string = 選定隊名
    let _currentBatterView = null; // { name, source, idx, teamName }
    let _bmBatterCardMap = {};     // mapKey → { entry, stats } — 供 showBmBatterCard() 使用
    let _batterSortKey = 'threat'; // default sort by threat
    let _batterSortDir = 'desc';   // 'asc' | 'desc'
    let _editingAtBatBatterIdx = null;
    let _atBatHitLocation = null;
    let _newBatterHand = '右打';

    function initBatterData() {
        if (!allData.batterData) allData.batterData = [];
    }

    // ── 得分確認 Chip（球有進場跑者時，確認實際得分 → 修正 ERA / RBI）──

    function showRunsChip(ctx) {
        _runsChipContext = ctx;
        _selectedRunsCount = ctx.autoRuns;

        // 壘況顯示
        const baseLabels = ['一壘', '二壘', '三壘'];
        const basesHtml = ctx.preBasesSnapshot.map((b, i) =>
            b ? `<span style="color:#ea580c;font-weight:900;">◆${baseLabels[i]}</span>`
              : `<span style="color:#d1d5db;">◇${baseLabels[i]}</span>`
        ).join('　');
        const el = document.getElementById('runsChipBasesInfo');
        if (el) el.innerHTML = basesHtml;

        const autoEl = document.getElementById('runsChipAutoRuns');
        if (autoEl) autoEl.textContent = ctx.autoRuns;

        // 預選系統推算值
        document.querySelectorAll('.runs-count-btn').forEach(btn => {
            const n = parseInt(btn.dataset.runs);
            const active = n === ctx.autoRuns;
            btn.style.background = active ? '#003d79' : '#f9fafb';
            btn.style.color      = active ? 'white'   : '#111827';
            btn.style.borderColor = active ? '#003d79' : '#e5e7eb';
        });

        const modal = document.getElementById('runsChipModal');
        if (modal) modal.style.display = 'flex';
    }

    function selectRunsCount(n) {
        _selectedRunsCount = n;
        document.querySelectorAll('.runs-count-btn').forEach(btn => {
            const active = parseInt(btn.dataset.runs) === n;
            btn.style.background  = active ? '#003d79' : '#f9fafb';
            btn.style.color       = active ? 'white'   : '#111827';
            btn.style.borderColor = active ? '#003d79' : '#e5e7eb';
        });
    }

    function confirmRunsChip() {
        const ctx = _runsChipContext;
        closeRunsChip();
        if (!ctx) return;

        const actualRuns = _selectedRunsCount;
        const autoRuns   = ctx.autoRuns;

        const pitcherPitches = allData.teams[ctx.bipTeam] &&
            allData.teams[ctx.bipTeam].pitchers[ctx.bipPitcher] &&
            allData.teams[ctx.bipTeam].pitchers[ctx.bipPitcher].pitches;
        const pitch = pitcherPitches && pitcherPitches[ctx.bipIdx];
        if (!pitch) return;

        pitch.runsScored = actualRuns;

        // RBI：安打/犧牲打才計打點；失誤/野選不計
        const RBI_OUTCOMES = ['一壘安打','二壘安打','三壘安打','全壘打','內野安打','高飛犧牲打','犧牲觸擊'];
        pitch.rbi = RBI_OUTCOMES.some(o => (pitch.outcomes||[]).includes(o)) ? actualRuns : 0;

        // 修正比分（比 autoRuns 多或少）
        if (actualRuns !== autoRuns) {
            const delta = actualRuns - autoRuns;
            if (currentTeam !== null) {
                const score = getTeamScore();
                if (ctx.half === '上') score.away = Math.max(0, (score.away || 0) + delta);
                else                   score.home = Math.max(0, (score.home || 0) + delta);
                updateScoreboard();
            }
        }

        rebuildPitcherDB();
        saveToLocalStorage();
        saveToFirebase(ctx.bipTeam);
        updatePitchLog();
        updateStats();
    }

    function skipRunsChip()  { closeRunsChip(); }
    function closeRunsChip() {
        _runsChipContext = null;
        const m = document.getElementById('runsChipModal');
        if (m) m.style.display = 'none';
        if (window._pendingBuntCtx) {
            const ctx = window._pendingBuntCtx;
            window._pendingBuntCtx = null;
            showBuntBasesModal(ctx);
        }
    }

    // ── 犧牲觸擊壘況確認 Modal ──

    function showBuntBasesModal(ctx) {
        _buntBasesContext = ctx;
        _buntBasesSelected = [...ctx.autoBases];
        _renderBuntBasesBtns();
        const modal = document.getElementById('buntBasesModal');
        if (modal) modal.style.display = 'flex';
    }

    function _renderBuntBasesBtns() {
        const labels = ['一壘', '二壘', '三壘'];
        ['1b', '2b', '3b'].forEach((id, i) => {
            const btn = document.getElementById('buntBaseBtn_' + id);
            if (!btn) return;
            const on = _buntBasesSelected[i];
            btn.style.background  = on ? '#003d79' : '#f9fafb';
            btn.style.color       = on ? 'white'   : '#9ca3af';
            btn.style.borderColor = on ? '#003d79' : '#e5e7eb';
            btn.innerHTML = `<div style="font-size:22px;">${on ? '◆' : '◇'}</div><div style="font-size:12px;font-weight:700;">${labels[i]}</div>`;
        });
    }

    function toggleBuntBase(idx) {
        _buntBasesSelected[idx] = !_buntBasesSelected[idx];
        _renderBuntBasesBtns();
    }

    function confirmBuntBases() {
        const ctx = _buntBasesContext;
        closeBuntBasesModal();
        if (!ctx) return;
        const oldRunners = [...gameState.runners];
        const autoBases  = ctx.autoBases;
        gameState.bases   = [..._buntBasesSelected];
        gameState.runners = _buntBasesSelected.map((on, i) => (on && autoBases[i]) ? oldRunners[i] : null);
        renderBases();
        saveToLocalStorage();
        saveToFirebase(currentTeam);
    }

    function skipBuntBases() { closeBuntBasesModal(); }
    function closeBuntBasesModal() {
        _buntBasesContext = null;
        const m = document.getElementById('buntBasesModal');
        if (m) m.style.display = 'none';
    }

    // ── 球場圖模式開關（單人操作：確認進場球後自動跳出落點選擇）──

    function toggleFieldMap() {
        fieldMapEnabled = !fieldMapEnabled;
        localStorage.setItem('fieldMapEnabled', fieldMapEnabled ? '1' : '0');
        updateFieldMapToggleBtn();
    }

    function updateFieldMapToggleBtn() {
        const btn = document.getElementById('fieldMapToggleBtn');
        if (!btn) return;
        if (fieldMapEnabled) {
            btn.style.background = '#003d79';
            btn.style.color = 'white';
            btn.style.borderColor = '#0051a5';
            btn.innerHTML = '⚾<br>球場圖<br>ON';
        } else {
            btn.style.background = '#f9fafb';
            btn.style.color = '#9ca3af';
            btn.style.borderColor = '#d1d5db';
            btn.innerHTML = '⚾<br>球場圖<br>OFF';
        }
    }

    // ── 打擊落點 Modal ──

    function showHitLocationModal(callback) {
        initBatterData();
        _hitLocCallback = callback;
        _hitLocSelectedLoc = null;

        // 每次顯示都重新注入帶互動的 SVG（確保事件綁定正確）
        const wrap = document.getElementById('hitLocFieldWrap');
        if (wrap) wrap.innerHTML = buildFieldSVG('', true);

        const modal = document.getElementById('hitLocationModal');
        const confirmBtn = document.getElementById('hitLocConfirmBtn');
        const zoneLabel = document.getElementById('hitLocZoneLabel');
        if (modal) modal.style.display = 'flex';
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.style.opacity = '0.4'; }
        if (zoneLabel) zoneLabel.textContent = '請點擊球場位置';
    }

    function closeHitLocationModal() {
        const modal = document.getElementById('hitLocationModal');
        if (modal) modal.style.display = 'none';
        _hitLocCallback = null;
        _hitLocSelectedLoc = null;
    }

    // ── 打擊落點：區域選擇 ──

    // 各區域代表座標（SVG 座標系，本壘板在 150,272；viewBox -20 0 340 315）
    const ZONE_SVG_COORDS = {
        // 外野舊名稱（相容舊資料）
        'LF':  { x: 66,  y: 159 }, 'LCF': { x: 106, y: 136 },
        'CF':  { x: 150, y: 125 }, 'RCF': { x: 194, y: 136 }, 'RF': { x: 234, y: 159 },
        // 淺外野（R 100→140）
        '淺LF': { x: 80, y: 175 }, '淺LCF': { x: 113, y: 158 },
        '淺CF': { x: 150, y: 152 }, '淺RCF': { x: 187, y: 158 }, '淺RF': { x: 220, y: 175 },
        // 深外野（R 140→180）
        '深LF': { x: 56, y: 143 }, '深LCF': { x: 101, y: 120 },
        '深CF': { x: 150, y: 112 }, '深RCF': { x: 199, y: 120 }, '深RF': { x: 244, y: 143 },
        // 深內野 8 區
        '3B': { x: 102, y: 213 }, '三游之間': { x: 114, y: 205 },
        'SS': { x: 128, y: 199 }, '中線靠左': { x: 143, y: 196 },
        '中線靠右': { x: 157, y: 196 }, '2B': { x: 172, y: 199 },
        '一二壘之間': { x: 186, y: 205 }, '1B': { x: 198, y: 213 },
        // 淺內野
        '三短': { x: 125, y: 249 }, 'P': { x: 150, y: 250 }, '一短': { x: 175, y: 249 },
        // 界外區
        '左界外': { x: 18, y: 255 }, '左外界外': { x: 18, y: 162 },
        '右界外': { x: 282, y: 255 }, '右外界外': { x: 282, y: 162 },
        '捕手區': { x: 150, y: 293 }, '捕手': { x: 150, y: 263 },
        // 全壘打區
        'HR左': { x: 39, y: 119 }, 'HR左中': { x: 92, y: 92 }, 'HR中': { x: 150, y: 82 }, 'HR右中': { x: 208, y: 92 }, 'HR右': { x: 261, y: 119 },
    };

    // 共用：清除 SVG 內所有高亮，並高亮 el
    function _zoneHighlight(el, svg) {
        if (svg) {
            svg.querySelectorAll('[data-zone]').forEach(z => {
                z.setAttribute('data-selected', '0');
                z.style.fill = z.getAttribute('data-fill') || '';
                z.style.fillOpacity = '0.88';
                z.style.stroke = 'rgba(0,0,0,0.35)';
                z.style.strokeWidth = '0.8';
            });
        }
        if (el) {
            el.setAttribute('data-selected', '1');
            el.style.fill = '#fbbf24';
            el.style.fillOpacity = '1';
            el.style.stroke = '#ea580c';
            el.style.strokeWidth = '2';
        }
    }

    // Modal 落點選擇（彈窗使用）
    function selectHitZone(zone, el) {
        _zoneHighlight(el, el ? el.closest('svg') : document.getElementById('fieldSVGInteractive'));
        const c = ZONE_SVG_COORDS[zone] || { x: 150, y: 200 };
        _hitLocSelectedLoc = { zone, x: c.x / 300, y: c.y / 280 };
        const zoneLabel = document.getElementById('hitLocZoneLabel');
        if (zoneLabel) zoneLabel.textContent = `落點：${zone}`;
        const confirmBtn = document.getElementById('hitLocConfirmBtn');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.style.opacity = '1'; }
    }

    // 聯動模式內嵌球場圖落點選擇
    function selectBmHitZone(zone, el) {
        _zoneHighlight(el, el ? el.closest('svg') : document.getElementById('fieldSVG_bm'));
        const c = ZONE_SVG_COORDS[zone] || { x: 150, y: 200 };
        _bmState.hitLoc = { zone, x: c.x / 300, y: c.y / 280 };
        const lbl = document.getElementById('bmHitZoneLabel');
        if (lbl) lbl.textContent = zone;
    }

    // 獨立模式打席結果選擇器中的落點選擇
    function selectSpHitZone(zone, el) {
        _zoneHighlight(el, el ? el.closest('svg') : document.getElementById('fieldSVG_sp'));
        const c = ZONE_SVG_COORDS[zone] || { x: 150, y: 200 };
        _bmState.spHitLoc = { zone, x: c.x / 300, y: c.y / 280 };
        const lbl = document.getElementById('spHitZoneLabel');
        if (lbl) lbl.textContent = zone;
    }

    function confirmHitLocation() {
        if (!_hitLocSelectedLoc) return;
        const loc = _hitLocSelectedLoc;
        const cb = _hitLocCallback;
        closeHitLocationModal();
        if (cb) cb(loc);
    }

    function skipHitLocation() {
        const cb = _hitLocCallback;
        closeHitLocationModal();
        if (cb) cb(null);
    }

    // ── 建立球場 SVG（真實扇形球場，本壘板在底部） ──
    // viewBox 300x280，本壘板 (150,272)
    // interactive: false=靜態  true=彈窗  'bm'=聯動內嵌  'sp'=獨立內嵌
    function buildFieldSVG(dotsHTML = '', interactive = false, cleanFan = false, hrDotsHTML = '') {
        const isBm   = interactive === 'bm';
        const isSp   = interactive === 'sp';
        const isAny  = interactive !== false;
        const id     = isBm ? 'fieldSVG_bm' : isSp ? 'fieldSVG_sp' :
                       (interactive === true) ? 'fieldSVGInteractive' : `fieldSVGStatic_${Date.now()}`;
        const fn     = isBm ? 'selectBmHitZone' : isSp ? 'selectSpHitZone' : 'selectHitZone';

        // 靜態模式（落點圖）：單色扇形，無區域色彩區分
        // 互動模式（選區）：保留完整色彩方便識別
        const FAIR_S = '#5aad4a';  // 靜態-公平區（淺草地綠）
        const FOUL_S = '#3d8a30';  // 靜態-界外區（稍深綠，與公平區區分）

        const GR1 = isAny ? '#3a8428' : FAIR_S;
        const GR2 = isAny ? '#1f5215' : FAIR_S;
        const HRC = isAny ? '#7a1f20' : FAIR_S;
        const DT  = isAny ? '#c45e00' : FAIR_S;
        const DC  = isAny ? '#e8870a' : FAIR_S;
        const DS  = isAny ? '#f5a832' : FAIR_S;
        const FC  = isAny ? '#3a5040' : FOUL_S;
        const CA  = isAny ? '#6b4d30' : FOUL_S;

        // 產生可點擊或靜態的區域 path
        function zp(name, d, fill) {
            if (isAny) {
                return `<path d="${d}" fill="${fill}" fill-opacity="0.88"
                    stroke="rgba(0,0,0,0.35)" stroke-width="0.8"
                    data-zone="${name}" data-fill="${fill}" data-selected="0"
                    onclick="${fn}('${name}',this)"
                    ontouchstart="${fn}('${name}',this);event.preventDefault()"
                    onmouseenter="if(this.dataset.selected!=='1'){this.style.fillOpacity='1';}"
                    onmouseleave="if(this.dataset.selected!=='1'){this.style.fillOpacity='0.88';}"
                    style="cursor:pointer;"/>`;
            }
            // 靜態：無區域邊框，乾淨扇形輪廓
            return `<path d="${d}" fill="${fill}" fill-opacity="1"
                stroke="none" style="pointer-events:none;"/>`;
        }

        // ── 全壘打區（R 180→205）──
        const hrLF  = zp('HR左',  'M 23 145 L 6 128 A 205 205 0 0 1 57 90 L 68 112 A 180 180 0 0 0 23 145 Z',  HRC);
        const hrLCF = zp('HR左中','M 68 112 L 57 90 A 205 205 0 0 1 118 69 L 122 94 A 180 180 0 0 0 68 112 Z', HRC);
        const hrCF  = zp('HR中',  'M 122 94 L 118 69 A 205 205 0 0 1 182 69 L 178 94 A 180 180 0 0 0 122 94 Z',  HRC);
        const hrRCF = zp('HR右中','M 178 94 L 182 69 A 205 205 0 0 1 243 90 L 232 112 A 180 180 0 0 0 178 94 Z', HRC);
        const hrRF  = zp('HR右',  'M 232 112 L 243 90 A 205 205 0 0 1 295 128 L 277 145 A 180 180 0 0 0 232 112 Z', HRC);

        // ── 淺外野五區（R 100→140）──
        const sLF  = zp('淺LF',  'M 79 201 L 51 173 A 140 140 0 0 1 86 147 L 105 183 A 100 100 0 0 0 79 201 Z',  GR1);
        const sLCF = zp('淺LCF', 'M 105 183 L 86 147 A 140 140 0 0 1 128 134 L 134 173 A 100 100 0 0 0 105 183 Z', GR1);
        const sCF  = zp('淺CF',  'M 134 173 L 128 134 A 140 140 0 0 1 172 134 L 166 173 A 100 100 0 0 0 134 173 Z',  GR1);
        const sRCF = zp('淺RCF', 'M 166 173 L 172 134 A 140 140 0 0 1 214 147 L 195 183 A 100 100 0 0 0 166 173 Z', GR1);
        const sRF  = zp('淺RF',  'M 195 183 L 214 147 A 140 140 0 0 1 249 173 L 221 201 A 100 100 0 0 0 195 183 Z', GR1);

        // ── 深外野五區（R 140→180）──
        const dLF  = zp('深LF',  'M 51 173 L 23 145 A 180 180 0 0 1 68 112 L 86 147 A 140 140 0 0 0 51 173 Z',  GR2);
        const dLCF = zp('深LCF', 'M 86 147 L 68 112 A 180 180 0 0 1 122 94 L 128 134 A 140 140 0 0 0 86 147 Z', GR2);
        const dCF  = zp('深CF',  'M 128 134 L 122 94 A 180 180 0 0 1 178 94 L 172 134 A 140 140 0 0 0 128 134 Z',  GR2);
        const dRCF = zp('深RCF', 'M 172 134 L 178 94 A 180 180 0 0 1 232 112 L 214 147 A 140 140 0 0 0 172 134 Z', GR2);
        const dRF  = zp('深RF',  'M 214 147 L 232 112 A 180 180 0 0 1 277 145 L 249 173 A 140 140 0 0 0 214 147 Z', GR2);

        // ── 深內野八區（R 42→100，每區 11.25°）──
        const i3B  = zp('3B',      'M 120 242 L 79 201 A 100 100 0 0 1 94 189 L 127 237 A 42 42 0 0 0 120 242 Z', DT);
        const iSS3 = zp('三游之間','M 127 237 L 94 189 A 100 100 0 0 1 112 180 L 134 233 A 42 42 0 0 0 127 237 Z', DC);
        const iSS  = zp('SS',      'M 134 233 L 112 180 A 100 100 0 0 1 130 174 L 142 231 A 42 42 0 0 0 134 233 Z', DT);
        const iML  = zp('中線靠左','M 142 231 L 130 174 A 100 100 0 0 1 150 172 L 150 230 A 42 42 0 0 0 142 231 Z', DC);
        const iMR  = zp('中線靠右','M 150 230 L 150 172 A 100 100 0 0 1 170 174 L 158 231 A 42 42 0 0 0 150 230 Z', DC);
        const i2B  = zp('2B',      'M 158 231 L 170 174 A 100 100 0 0 1 188 180 L 166 233 A 42 42 0 0 0 158 231 Z', DT);
        const i12  = zp('一二壘之間','M 166 233 L 188 180 A 100 100 0 0 1 206 189 L 173 237 A 42 42 0 0 0 166 233 Z', DC);
        const i1B  = zp('1B',      'M 173 237 L 206 189 A 100 100 0 0 1 221 201 L 180 242 A 42 42 0 0 0 173 237 Z', DT);

        // ── 淺內野三區（R 25→42）──
        const san = zp('三短', 'M 132 254 L 120 242 A 42 42 0 0 1 139 231 L 144 248 A 25 25 0 0 0 132 254 Z', DS);
        const P   = zp('P',   'M 144 248 L 139 231 A 42 42 0 0 1 161 232 L 157 248 A 25 25 0 0 0 144 248 Z', DS);
        const yi  = zp('一短', 'M 157 248 L 161 232 A 42 42 0 0 1 180 242 L 168 254 A 25 25 0 0 0 157 248 Z', DS);
        // ── 捕手區（R 0→25，對齊短打寬度，同色）──
        const catZone = isAny
            ? `<path d="M 150 272 L 132 254 A 25 25 0 0 1 168 254 Z" fill="${DS}" fill-opacity="0.88"
                stroke="none"
                data-zone="捕手" data-fill="${DS}" data-selected="0"
                onclick="${fn}('捕手',this)"
                ontouchstart="${fn}('捕手',this);event.preventDefault()"
                onmouseenter="if(this.dataset.selected!=='1'){this.style.fillOpacity='1';}"
                onmouseleave="if(this.dataset.selected!=='1'){this.style.fillOpacity='0.88';}"
                style="cursor:pointer;"/>`
            : `<path d="M 150 272 L 132 254 A 25 25 0 0 1 168 254 Z" fill="${DS}" fill-opacity="0.88"
                stroke="none" style="pointer-events:none;"/>`;

        // ── 界外區（viewBox 擴展至 -20 左、320 右、315 底）──
        // 界外區：以 R=100（y=201）為界分成內野界外 + 外野界外
        const fLi = zp('左界外',   'M 150 272 L 79 201 L -20 201 L -20 315 L 105 315 L 105 272 Z', FC);
        const fLo = zp('左外界外', 'M 79 201 L 23 145 L -20 103 L -20 201 Z', FC);
        const fRi = zp('右界外',   'M 150 272 L 221 201 L 320 201 L 320 315 L 195 315 L 195 272 Z', FC);
        const fRo = zp('右外界外', 'M 221 201 L 277 145 L 320 103 L 320 201 Z', FC);
        // 捕手區：本壘後方中央 — 矩形填滿 x=105~195, y=272~305（viewBox底）
        const fC = zp('捕手區', 'M 105 272 L 195 272 L 195 305 L 105 305 Z', FC);

      // cleanFan 模式：透明背景、只顯示扇形、落點線 clip 到公平區
      const _vb  = cleanFan ? '-4 58 308 220' : '-20 55 340 250';
      const _bg  = cleanFan ? '#fef9e7'      : '#162e12';
      const _clipId   = `${id}_fc`;
      const _hrClipId = `${id}_hrc`;
      return `<svg id="${id}" viewBox="${_vb}"
            style="width:100%;border-radius:${cleanFan?'8px':'12px'};display:block;background:${_bg};touch-action:none;overflow:visible;">

          ${cleanFan ? `<defs>
            <clipPath id="${_clipId}">
              <path d="M 150 272 L 23 145 A 180 180 0 0 1 277 145 Z"/>
            </clipPath>
            <clipPath id="${_hrClipId}">
              <path d="M 150 272 L 6 128 A 205 205 0 0 1 295 128 Z"/>
            </clipPath>
          </defs>` : ''}

          <!-- 全壘打區（R 180→205） -->
          ${hrLF}${hrLCF}${hrCF}${hrRCF}${hrRF}

          <!-- 界外區（底層先畫，cleanFan 模式省略） -->
          ${cleanFan ? '' : fLi+fLo+fRi+fRo+fC}

          <!-- 公平區域底色 -->
          <path d="M 150 272 L 23 145 A 180 180 0 0 1 277 145 Z" fill="${isAny ? '#1f4a18' : FAIR_S}"/>

          <!-- 深外野（R 140→180） -->
          ${dLF}${dLCF}${dCF}${dRCF}${dRF}

          <!-- 淺外野（R 100→140） -->
          ${sLF}${sLCF}${sCF}${sRCF}${sRF}

          <!-- 淺/深外野分界虛線弧（互動模式才顯示） -->
          ${isAny ? `<path d="M 51 173 A 140 140 0 0 1 249 173" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1" stroke-dasharray="4,3" style="pointer-events:none;"/>` : ''}

          <!-- 深內野（8區） -->
          ${i3B}${iSS3}${iSS}${iML}${iMR}${i2B}${i12}${i1B}

          <!-- 淺內野 -->
          ${san}${P}${yi}${catZone}

          <!-- 界外線 -->
          <line x1="150" y1="272" x2="23" y2="145" stroke="white" stroke-width="1.5" opacity="0.6" style="pointer-events:none;"/>
          <line x1="150" y1="272" x2="277" y2="145" stroke="white" stroke-width="1.5" opacity="0.6" style="pointer-events:none;"/>
          <!-- 外野牆弧線 -->
          <path d="M 23 145 A 180 180 0 0 1 277 145" fill="none" stroke="white" stroke-width="1.5" opacity="0.45" style="pointer-events:none;"/>
          <!-- 捕手區分隔線（cleanFan 模式省略） -->
          ${cleanFan ? '' : `
          <line x1="105" y1="272" x2="105" y2="315" stroke="rgba(255,255,255,0.3)" stroke-width="1" style="pointer-events:none;"/>
          <line x1="195" y1="272" x2="195" y2="315" stroke="rgba(255,255,255,0.3)" stroke-width="1" style="pointer-events:none;"/>`}

          <!-- 壘包路徑（菱形） -->
          <polyline points="150,272 203,219 150,166 97,219 150,272"
            fill="none" stroke="white" stroke-width="1.5" opacity="0.5" style="pointer-events:none;"/>

          <!-- 壘包 -->
          <polygon points="150,265 155,272 150,279 145,272" fill="white" style="pointer-events:none;"/>
          <rect x="200" y="216" width="7" height="7" fill="white" style="pointer-events:none;"/>
          <rect x="147" y="163" width="7" height="7" fill="white" transform="rotate(45 150.5 166.5)" style="pointer-events:none;"/>
          <rect x="94"  y="216" width="7" height="7" fill="white" style="pointer-events:none;"/>

          <!-- 左中右標籤（cleanFan 模式顯示） -->
          ${cleanFan ? `
          <text x="38"  y="175" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="11" font-weight="700" font-family="sans-serif" style="pointer-events:none;">左</text>
          <text x="150" y="95"  text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="11" font-weight="700" font-family="sans-serif" style="pointer-events:none;">中</text>
          <text x="262" y="175" text-anchor="middle" fill="rgba(255,255,255,0.7)" font-size="11" font-weight="700" font-family="sans-serif" style="pointer-events:none;">右</text>
          ` : ''}

          ${isAny ? `
          <!-- 淺外野標籤（互動模式才顯示） -->
          <text x="80"  y="179" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">淺LF</text>
          <text x="113" y="162" text-anchor="middle" fill="white" font-size="7" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">淺LCF</text>
          <text x="150" y="156" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">淺CF</text>
          <text x="187" y="162" text-anchor="middle" fill="white" font-size="7" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">淺RCF</text>
          <text x="220" y="179" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">淺RF</text>
          <text x="35"  y="116" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="7" font-weight="700" font-family="sans-serif" style="pointer-events:none;">HR LF</text>
          <text x="88"  y="88"  text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="7" font-weight="700" font-family="sans-serif" style="pointer-events:none;">HR LCF</text>
          <text x="150" y="78"  text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">HR CF</text>
          <text x="212" y="88"  text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="7" font-weight="700" font-family="sans-serif" style="pointer-events:none;">HR RCF</text>
          <text x="265" y="116" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="7" font-weight="700" font-family="sans-serif" style="pointer-events:none;">HR RF</text>
          <text x="56"  y="148" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">深LF</text>
          <text x="101" y="125" text-anchor="middle" fill="white" font-size="7" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">深LCF</text>
          <text x="150" y="117" text-anchor="middle" fill="white" font-size="9" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">深CF</text>
          <text x="199" y="125" text-anchor="middle" fill="white" font-size="7" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">深RCF</text>
          <text x="244" y="148" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.9" style="pointer-events:none;">深RF</text>
          <text x="102" y="215" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">3B</text>
          <text x="114" y="207" text-anchor="middle" fill="white" font-size="7" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">三游</text>
          <text x="128" y="200" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">SS</text>
          <text x="142" y="197" text-anchor="middle" fill="white" font-size="6.5" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">中左</text>
          <text x="158" y="197" text-anchor="middle" fill="white" font-size="6.5" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">中右</text>
          <text x="172" y="200" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">2B</text>
          <text x="186" y="207" text-anchor="middle" fill="white" font-size="7" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">一二</text>
          <text x="198" y="215" text-anchor="middle" fill="white" font-size="8" font-weight="700" font-family="sans-serif" opacity="0.95" style="pointer-events:none;">1B</text>
          <text x="128" y="243" text-anchor="middle" fill="white" font-size="8" font-family="sans-serif" opacity="0.85" style="pointer-events:none;">三短</text>
          <text x="150" y="242" text-anchor="middle" fill="white" font-size="8" font-family="sans-serif" opacity="0.85" style="pointer-events:none;">P</text>
          <text x="172" y="243" text-anchor="middle" fill="white" font-size="8" font-family="sans-serif" opacity="0.85" style="pointer-events:none;">一短</text>
          <text x="150" y="266" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">捕手</text>
          <text x="18"  y="240" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="9" font-weight="700" font-family="sans-serif" style="pointer-events:none;">左</text>
          <text x="18"  y="253" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="9" font-weight="700" font-family="sans-serif" style="pointer-events:none;">界</text>
          <text x="18"  y="266" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="9" font-weight="700" font-family="sans-serif" style="pointer-events:none;">外</text>
          <text x="18"  y="152" text-anchor="middle" fill="rgba(255,255,255,0.65)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">左</text>
          <text x="18"  y="163" text-anchor="middle" fill="rgba(255,255,255,0.65)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">外</text>
          <text x="282" y="240" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="9" font-weight="700" font-family="sans-serif" style="pointer-events:none;">右</text>
          <text x="282" y="253" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="9" font-weight="700" font-family="sans-serif" style="pointer-events:none;">界</text>
          <text x="282" y="266" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="9" font-weight="700" font-family="sans-serif" style="pointer-events:none;">外</text>
          <text x="282" y="152" text-anchor="middle" fill="rgba(255,255,255,0.65)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">右</text>
          <text x="282" y="163" text-anchor="middle" fill="rgba(255,255,255,0.65)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">外</text>
          <text x="150" y="288" text-anchor="middle" fill="rgba(255,255,255,0.75)" font-size="8" font-weight="700" font-family="sans-serif" style="pointer-events:none;">捕手區</text>
          ` : ''}

          ${cleanFan
            ? `<g clip-path="url(#${_clipId})">${dotsHTML}</g><g clip-path="url(#${_hrClipId})">${hrDotsHTML}</g>`
            : dotsHTML}
        </svg>`;
    }

    // ── 打者 Tab ──

    // 從 lineup 反推打者所屬隊伍（舊資料無 batterTeam 時的 fallback）
    function _inferBatterTeam(pitch, team) {
        const lineupA = team.lineups?.teamA || [];
        const lineupB = team.lineups?.teamB || [];
        const num  = String(pitch.batterNumber || '').trim();
        const name = (pitch.batterName || '').trim();
        const inA = lineupA.some(p => p && ((num && String(p.number || '') === num) || (name && (p.name || '').trim() === name)));
        const inB = lineupB.some(p => p && ((num && String(p.number || '') === num) || (name && (p.name || '').trim() === name)));
        if (inA) return team.name || '';
        if (inB) return team.opponent || '';
        return '';
    }

    function selectBatterTeam(teamName) {
        _batterTeamFilter = teamName || null;
        refreshBatterList();
    }

    function setBatterSort(key) {
        if (_batterSortKey === key) {
            _batterSortDir = _batterSortDir === 'desc' ? 'asc' : 'desc';
        } else {
            _batterSortKey = key;
            _batterSortDir = key === 'name' ? 'asc' : 'desc';
        }
        refreshBatterList();
    }

    function switchBatterSource(src) {
        _batterSource = src;
        _batterTeamFilter = null; // 切換來源時重置隊伍篩選
        document.getElementById('batterSrcPitcher').classList.toggle('active', src === 'pitcher');
        document.getElementById('batterSrcStandalone').classList.toggle('active', src === 'standalone');
        const addBtn = document.getElementById('batterAddNewBtn');
        if (addBtn) addBtn.style.display = src === 'standalone' ? 'inline-block' : 'none';
        refreshBatterList();
    }

    function refreshBatterList() {
        _initBmData();
        const listEl = document.getElementById('batterList');
        if (!listEl) return;

        const HIT_OUTCOMES_BL = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const PA_ENDING = [...HIT_OUTCOMES_BL,'保送','觸身球','故意四壞','捕逸','三振','不死三振',
            '滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤'];

        // ── 聚合打者（投手記錄 + bm.atBats）──
        const batterMap = new Map();

        // 從投手記錄
        allData.teams.forEach((team, ti) => {
            if (currentTeam !== null && ti !== currentTeam) return;
            (team.pitchers || []).forEach(pitcher => {
                (pitcher.pitches || []).forEach(pitch => {
                    const name = (pitch.batterName || '').trim();
                    const num  = String(pitch.batterNumber || '').trim();
                    const nameKey = name || (num ? `#${num}` : '');
                    if (!nameKey) return;
                    const bTeam = pitch.batterTeam || _inferBatterTeam(pitch, team) || '未分類';
                    const mapKey = `${bTeam}||${nameKey}`;
                    if (!batterMap.has(mapKey)) {
                        batterMap.set(mapKey, {
                            name: name || `背號 ${num}`, nameKey, teamName: bTeam,
                            pitches: [], games: new Set(), hand: pitch.batterHand || '',
                        });
                    }
                    const entry = batterMap.get(mapKey);
                    entry.pitches.push({ ...pitch, _ti: ti });
                    const gk = [team.gameName, team.date].filter(Boolean).join(' ');
                    if (gk) entry.games.add(gk);
                });
            });
        });

        // 從 bm.atBats
        (allData.bm?.atBats || []).forEach(ab => {
            if (!ab.outcome) return;
            const name = (ab.name || '').trim();
            const num  = String(ab.number || '').trim();
            const nameKey = name || (num ? `#${num}` : '');
            if (!nameKey) return;
            const bTeam = ab.teamName || '未分類';
            const mapKey = `${bTeam}||${nameKey}`;
            if (!batterMap.has(mapKey)) {
                batterMap.set(mapKey, {
                    name: name || `背號 ${num}`, nameKey, teamName: bTeam,
                    pitches: [], games: new Set(), hand: ab.hand || '', _bmNum: num,
                });
            }
            const entry = batterMap.get(mapKey);
            if (!entry._bmNum && num) entry._bmNum = num;
            entry.pitches.push({
                outcomes:      [ab.outcome, ...(ab.tactics || [])],
                batterHand:    ab.hand || '',
                batterName:    ab.name || '',
                batterNumber:  ab.number || '',
                batterTeam:    ab.teamName || '',
                hitLocation:   ab.hitLocation || null,
                basesSnapshot: ab.bases || [false, false, false],
                pitcherHand:   ab.pitcherHand || '右投',
                balls:         ab.balls   || 0,
                strikes:       ab.strikes || 0,
                inning:        ab.inning  || null,
                half:          ab.half    || null,
                type:          null,
                _fromBm:       true,
            });
            const gk = ab.gameName || ab.teamName || '';
            if (gk) entry.games.add(gk);
        });

        // ── 統計計算 ──
        function _calcStats(entry) {
            const pp = entry.pitches;
            const pa    = pp.filter(p => (p.outcomes||[]).some(o => PA_ENDING.includes(o))).length;
            const hits  = pp.filter(p => (p.outcomes||[]).some(o => HIT_OUTCOMES_BL.includes(o))).length;
            const k     = pp.filter(p => (p.outcomes||[]).some(o => ['三振','不死三振'].includes(o))).length;
            const bb    = pp.filter(p => (p.outcomes||[]).some(o => ['保送','故意四壞'].includes(o))).length;
            const hbp   = pp.filter(p => (p.outcomes||[]).includes('觸身球')).length;
            const sf    = pp.filter(p => (p.outcomes||[]).includes('高飛犧牲打')).length;
            const sh    = pp.filter(p => (p.outcomes||[]).includes('犧牲觸擊')).length;
            const singles = pp.filter(p => (p.outcomes||[]).some(o => ['一壘安打','內野安打'].includes(o))).length;
            const doubles = pp.filter(p => (p.outcomes||[]).includes('二壘安打')).length;
            const triples = pp.filter(p => (p.outcomes||[]).includes('三壘安打')).length;
            const hrs     = pp.filter(p => (p.outcomes||[]).includes('全壘打')).length;
            const ab_n  = Math.max(0, pa - bb - hbp - sf - sh);
            const tb    = singles + doubles * 2 + triples * 3 + hrs * 4;
            const obp_n = (pa - sh) > 0 ? (hits + bb + hbp) / (pa - sh) : 0;
            const slg_n = ab_n > 0 ? tb / ab_n : 0;
            const ops_n = obp_n + slg_n;
            const avgNum = pa > 0 ? hits / pa : 0;
            const kRate  = pa > 0 ? k  / pa : 0;
            const bbRate = pa > 0 ? bb / pa : 0;
            const threatScore = avgNum * 100 - kRate * 25;
            const threatLevel = threatScore >= 22 ? 'high' : threatScore >= 11 ? 'mid' : 'low';
            return { pa, hits, k, bb, hbp, sf, sh, tb, avgNum, kRate, bbRate, ops_n, threatScore, threatLevel };
        }

        // ── 球隊篩選器 ──
        const teamNameSet = new Set();
        batterMap.forEach(e => { if (e.teamName !== '未分類') teamNameSet.add(e.teamName); });
        const selectorEl = document.getElementById('batterTeamSelector');
        if (selectorEl) {
            if (teamNameSet.size > 0) {
                const teams = ['全部', ...[...teamNameSet].sort()];
                selectorEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">
                    ${teams.map(t => {
                        const active = (t === '全部' && !_batterTeamFilter) || t === _batterTeamFilter;
                        const tArg = t === '全部' ? 'null' : `'${t.replace(/'/g,"\\'"  )}'`;
                        return `<button onclick="selectBatterTeam(${tArg})"
                            style="padding:7px 16px;border-radius:20px;font-size:14px;font-weight:700;
                                   border:2px solid ${active ? '#003d79' : '#d1d5db'};
                                   background:${active ? '#003d79' : 'white'};
                                   color:${active ? 'white' : '#374151'};
                                   cursor:pointer;font-family:inherit;">${t}</button>`;
                    }).join('')}
                </div>`;
            } else {
                selectorEl.innerHTML = '';
            }
        }

        // ── 篩選 + 排序 ──
        const filtered = [...batterMap.entries()]
            .filter(([, e]) => !_batterTeamFilter || e.teamName === _batterTeamFilter);

        if (filtered.length === 0) {
            listEl.innerHTML = `<div style="text-align:center;padding:40px 16px;color:#6b7280;">
                <div style="font-size:36px;margin-bottom:10px;">📋</div>
                <div style="font-weight:700;margin-bottom:6px;">尚無打者資料</div>
                <div style="font-size:13px;">注入測試資料或開始記錄打席後將顯示打者卡片</div>
            </div>`;
            return;
        }

        const enriched = filtered.map(([mapKey, entry]) => ({ mapKey, entry, stats: _calcStats(entry) }));
        enriched.sort((a, b) => b.stats.threatScore - a.stats.threatScore);

        // 存入全域 map 供點擊時取用
        _bmBatterCardMap = {};
        enriched.forEach(r => { _bmBatterCardMap[r.mapKey] = r; });

        // ── 輔助：弱點摘要 ──
        function _fmtAvg(n) { return n > 0 ? '.' + String(Math.round(n * 1000)).padStart(3,'0') : '.000'; }
        function _weaknessBlurb(s, entry) {
            if (s.pa < 3) return '資料尚少，累積更多打席後顯示分析';
            const pp   = entry.pitches;
            const hand = entry.hand || '';

            // ── A. 球種 / 區域揮空弱點（投手記錄有 zone/swing 資料時）──
            const zonePP = pp.filter(p => !p._fromBm && p.zone);
            if (zonePP.length >= 6) {
                // 各區域揮空率（揮棒次數>=3才納入）
                const isRHH = hand !== '左打';
                const ZONE_GROUPS = [
                    { label:'低球',   zones:['7','8','9'] },
                    { label:'高球',   zones:['1','2','3'] },
                    { label:'外角',   zones: isRHH ? ['3','6','9'] : ['1','4','7'] },
                    { label:'內角',   zones: isRHH ? ['1','4','7'] : ['3','6','9'] },
                    { label:'外角低', zones: isRHH ? ['9']         : ['7']         },
                    { label:'內角高', zones: isRHH ? ['1']         : ['3']         },
                ];
                let bestZone = null, bestZoneRate = 0;
                ZONE_GROUPS.forEach(({ label, zones }) => {
                    const inZ   = zonePP.filter(p => zones.includes(p.zone));
                    const swings = inZ.filter(p => p.swing);
                    const misses = swings.filter(p => !p.foul);
                    if (swings.length >= 3) {
                        const r = misses.length / swings.length;
                        if (r > bestZoneRate) { bestZoneRate = r; bestZone = label; }
                    }
                });
                if (bestZone && bestZoneRate >= 0.45)
                    return `${bestZone}球揮空率 ${Math.round(bestZoneRate*100)}%，主攻${bestZone}可製造三振`;

                // 各球種揮空率
                const typeMap = {};
                zonePP.filter(p => p.type && p.swing).forEach(p => {
                    if (!typeMap[p.type]) typeMap[p.type] = { sw:0, miss:0 };
                    typeMap[p.type].sw++;
                    if (!p.foul) typeMap[p.type].miss++;
                });
                let bestType = null, bestTypeRate = 0;
                Object.entries(typeMap).forEach(([t, d]) => {
                    if (d.sw >= 3 && d.miss/d.sw > bestTypeRate) { bestTypeRate = d.miss/d.sw; bestType = t; }
                });
                if (bestType && bestTypeRate >= 0.50)
                    return `${bestType}揮空率 ${Math.round(bestTypeRate*100)}%，為主要剋星球種`;
            }

            // ── B. 投手慣用手對戰分析（左/右投手分開看打率差異）──
            const paEnds = pp.filter(p => (p.outcomes||[]).some(o => PA_ENDING.includes(o)));
            const vsR = paEnds.filter(p => p.pitcherHand === '右投');
            const vsL = paEnds.filter(p => p.pitcherHand === '左投');
            const vsRH = vsR.filter(p => (p.outcomes||[]).some(o => HIT_OUTCOMES_BL.includes(o))).length;
            const vsLH = vsL.filter(p => (p.outcomes||[]).some(o => HIT_OUTCOMES_BL.includes(o))).length;
            const vsRAvg = vsR.length >= 4 ? vsRH / vsR.length : -1;
            const vsLAvg = vsL.length >= 4 ? vsLH / vsL.length : -1;
            if (vsRAvg >= 0 && vsLAvg >= 0 && Math.abs(vsRAvg - vsLAvg) >= 0.15) {
                if (vsLAvg < vsRAvg)
                    return `對左投弱（打率 ${_fmtAvg(vsLAvg)} vs 右投 ${_fmtAvg(vsRAvg)}），左投手可壓制`;
                else
                    return `對右投弱（打率 ${_fmtAvg(vsRAvg)} vs 左投 ${_fmtAvg(vsLAvg)}），右投手可壓制`;
            }

            // ── C. 兩好球後三振率 ──
            const twoS = paEnds.filter(p => (p.strikes||0) >= 2);
            if (twoS.length >= 4) {
                const k2 = twoS.filter(p => (p.outcomes||[]).some(o => ['三振','不死三振'].includes(o))).length;
                const r2 = k2 / twoS.length;
                if (r2 >= 0.60) return `兩好球後三振率 ${Math.round(r2*100)}%，搶先取得好球數優勢`;
                if (r2 >= 0.50) return `兩好球後三振率 ${Math.round(r2*100)}%，快速製造好球數佔優`;
            }

            // ── D. 打擊方向傾向 ──
            const hitLocs = pp
                .filter(p => p.hitLocation && (p.outcomes||[]).some(o => HIT_OUTCOMES_BL.includes(o)))
                .map(p => p.hitLocation.x);
            if (hitLocs.length >= 4) {
                const avgX = hitLocs.reduce((a,b) => a+b, 0) / hitLocs.length;
                const isPull = (hand === '右打' && avgX < 0.37) || (hand === '左打' && avgX > 0.63);
                const isOpp  = (hand === '右打' && avgX > 0.62) || (hand === '左打' && avgX < 0.38);
                if (isPull) return `強力拉打型，外角或低球可破壞打擊節奏`;
                if (isOpp)  return `逆向打型，內角快速球可有效壓制`;
            }

            // ── E. 統計兜底 ──
            if (s.kRate  >= 0.40) return `三振率 ${Math.round(s.kRate*100)}%，積極配球可製造出局`;
            if (s.kRate  >= 0.30) return `三振率偏高 ${Math.round(s.kRate*100)}%，配速差球有效`;
            if (s.avgNum <= 0.200) return `打擊率偏低 ${_fmtAvg(s.avgNum)}，可強勢配球`;
            if (s.avgNum >= 0.380) return `⚠️ 危險打者，打率 ${_fmtAvg(s.avgNum)}，謹慎配球`;
            if (s.bbRate >= 0.20)  return `⚠️ 選球佳，保送率 ${Math.round(s.bbRate*100)}%，勿輕易給壞球`;
            return `均衡型，無明顯破綻`;
        }
        function _threatBadge(level) {
            const cfg = {
                high: { bg:'#dcfce7', color:'#15803d', border:'#16a34a', label:'高威脅' },
                mid:  { bg:'#f3f4f6', color:'#6b7280', border:'#9ca3af', label:'中威脅' },
                low:  { bg:'#fee2e2', color:'#b91c1c', border:'#ef4444', label:'低威脅' },
            };
            const c = cfg[level];
            return `<span style="display:inline-block;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:800;background:${c.bg};color:${c.color};border:1.5px solid ${c.border};">${c.label}</span>`;
        }

        // ── 渲染打者卡片（緊湊小卡片，點擊開 modal）──
        const _threatBorderColor = { high:'#16a34a', mid:'#9ca3af', low:'#ef4444' };
        listEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">` +
            enriched.map(({ mapKey, entry, stats }) => {
                const safeKey  = mapKey.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
                const numLabel = entry._bmNum ? `#${entry._bmNum}` : (entry.nameKey.startsWith('#') ? entry.nameKey : '');
                const bColor   = _threatBorderColor[stats.threatLevel] || '#9ca3af';
                return `<div onclick="showBmBatterCard('${safeKey}')"
                    style="background:white;border-radius:10px;padding:16px 14px;
                           border-left:4px solid ${bColor};
                           box-shadow:0 1px 4px rgba(0,0,0,0.08);cursor:pointer;
                           display:flex;flex-direction:column;gap:6px;
                           flex:1 1 130px;max-width:210px;min-width:120px;
                           transition:transform 0.12s,box-shadow 0.12s;"
                    onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)'"
                    onmouseout="this.style.transform='';this.style.boxShadow='0 1px 4px rgba(0,0,0,0.08)'">
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:10px;color:#9ca3af;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70px;">${entry.teamName || ''}</span>
                    ${_threatBadge(stats.threatLevel)}
                  </div>
                  <div style="display:flex;align-items:baseline;gap:5px;flex-wrap:wrap;">
                    <span style="font-size:20px;font-weight:900;font-family:'Oswald',sans-serif;color:#003d79;line-height:1.2;">${entry.name}</span>
                    ${numLabel ? `<span style="font-size:13px;font-weight:700;color:#6b7280;">${numLabel}</span>` : ''}
                  </div>
                  <span style="font-size:12px;color:#9ca3af;">${entry.hand || ''}</span>
                </div>`;
            }).join('') +
        `</div>`;

        /* ── 舊程式碼已移除 ── */
        if (false) {
            const HIT_OUTCOMES_BL_UNUSED = [];
            allData.teams.forEach((team, ti) => {
                if (currentTeam !== null && ti !== currentTeam) return;
                team.pitchers.forEach(pitcher => {
                    pitcher.pitches.forEach(pitch => {
                        const name = (pitch.batterName || '').trim();
                        const num  = String(pitch.batterNumber || '').trim();
                        const nameKey = name || (num ? `#${num}` : '');
                        if (!nameKey) return;
                        const displayName = name || `背號 ${num}`;
                        const bTeam = pitch.batterTeam || _inferBatterTeam(pitch, team) || '未分類';
                        const mapKey = `${bTeam}||${nameKey}`;
                        if (!batterMap.has(mapKey)) {
                            batterMap.set(mapKey, { name: displayName, nameKey, teamName: bTeam, pitches: [], games: new Set(), hand: pitch.batterHand || '' });
                        }
                        const entry = batterMap.get(mapKey);
                        entry.pitches.push({ ...pitch, _ti: ti });
                        const gk = [team.gameName, team.date].filter(Boolean).join(' ');
                        if (gk) entry.games.add(gk);
                    });
                });
            });

            // 合併打者模式 (bm.atBats) 的打席記錄
            (allData.bm?.atBats || []).forEach(ab => {
                if (!ab.outcome) return;
                const name = (ab.name || '').trim();
                const num  = String(ab.number || '').trim();
                const nameKey = name || (num ? `#${num}` : '');
                if (!nameKey) return;
                const bTeam = ab.teamName || '未分類';
                const mapKey = `${bTeam}||${nameKey}`;
                if (!batterMap.has(mapKey)) {
                    batterMap.set(mapKey, {
                        name: name || `背號 ${num}`, nameKey,
                        teamName: bTeam, pitches: [], games: new Set(),
                        hand: ab.hand || '', _bmNum: num,
                    });
                }
                const entry = batterMap.get(mapKey);
                if (!entry._bmNum && num) entry._bmNum = num;
                entry.pitches.push({
                    outcomes: [ab.outcome, ...(ab.tactics || [])],
                    batterHand: ab.hand || '',
                    batterName: ab.name || '',
                    batterNumber: ab.number || '',
                    batterTeam: ab.teamName || '',
                    hitLocation: ab.hitLocation || null,
                    balls: ab.balls || 0, strikes: ab.strikes || 0,
                    inning: ab.inning || null, half: ab.half || null,
                    _fromBm: true,
                });
                const gk = ab.gameName || ab.teamName || '';
                if (gk) entry.games.add(gk);
            });

            // 取出所有隊名（排除未分類）
            const teamNameSet = new Set();
            batterMap.forEach(e => { if (e.teamName !== '未分類') teamNameSet.add(e.teamName); });
            const hasUnclassified = [...batterMap.values()].some(e => e.teamName === '未分類');

            // 渲染隊伍選擇器
            const selectorEl = document.getElementById('batterTeamSelector');
            if (selectorEl) {
                if (batterMap.size > 0 && (teamNameSet.size > 0 || hasUnclassified)) {
                    const tabs = ['全部', ...[...teamNameSet].sort(), ...(hasUnclassified ? ['未分類'] : [])];
                    selectorEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
                        ${tabs.map(t => {
                            const active = (t === '全部' && !_batterTeamFilter) || t === _batterTeamFilter;
                            const tArg = t === '全部' ? 'null' : `'${t.replace(/'/g, "\\'")}'`;
                            return `<button onclick="selectBatterTeam(${tArg})" style="padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;border:2px solid ${active ? '#003d79' : '#d1d5db'};background:${active ? '#003d79' : 'white'};color:${active ? 'white' : '#374151'};cursor:pointer;font-family:inherit;touch-action:manipulation;">${t}</button>`;
                        }).join('')}
                    </div>`;
                } else {
                    selectorEl.innerHTML = '';
                }
            }

            // 依選定隊伍篩選
            const filteredEntries = _batterTeamFilter
                ? [...batterMap.values()].filter(e => e.teamName === _batterTeamFilter)
                : [...batterMap.values()];

            if (filteredEntries.length === 0) {
                listEl.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#6b7280;">
                  <div style="font-size:36px;margin-bottom:10px;">📋</div>
                  <div style="font-weight:700;margin-bottom:4px;">尚無打者資料</div>
                  <div style="font-size:12px;">記錄投球時系統將自動聚合打者資料。</div>
                </div>`;
                return;
            }

            // 計算各打者統計 & 威脅指數
            function _calcBatterStats(entry) {
                const pa    = entry.pitches.filter(p => p.outcomes && p.outcomes.some(o => PA_ENDING.includes(o))).length;
                const hits  = entry.pitches.filter(p => p.outcomes && p.outcomes.some(o => HIT_OUTCOMES_BL.includes(o))).length;
                const k     = entry.pitches.filter(p => p.outcomes && (p.outcomes.includes('三振') || p.outcomes.includes('不死三振'))).length;
                const bb    = entry.pitches.filter(p => p.outcomes && p.outcomes.includes('保送')).length;
                const avgNum = pa > 0 ? hits / pa : 0;
                const kRate  = pa > 0 ? k / pa : 0;
                // 威脅分數：高打率 = 危險（綠），高三振率 = 我方有利（紅）
                const threatScore = avgNum * 100 - kRate * 25;
                const threatLevel = threatScore >= 22 ? 'high' : threatScore >= 11 ? 'mid' : 'low';
                return { pa, hits, k, bb, avgNum, kRate, threatScore, threatLevel };
            }

            const enriched = filteredEntries.map(entry => ({ entry, stats: _calcBatterStats(entry) }));

            // 排序
            enriched.sort((a, b) => {
                let va, vb;
                switch (_batterSortKey) {
                    case 'name':   va = a.entry.name; vb = b.entry.name; break;
                    case 'pa':     va = a.stats.pa;   vb = b.stats.pa;   break;
                    case 'avg':    va = a.stats.avgNum; vb = b.stats.avgNum; break;
                    case 'k':      va = a.stats.k;    vb = b.stats.k;    break;
                    case 'bb':     va = a.stats.bb;   vb = b.stats.bb;   break;
                    default:       va = a.stats.threatScore; vb = b.stats.threatScore;
                }
                if (typeof va === 'string') return _batterSortDir === 'asc' ? va.localeCompare(vb,'zh-TW') : vb.localeCompare(va,'zh-TW');
                return _batterSortDir === 'asc' ? va - vb : vb - va;
            });

            // 球隊摘要
            const totalPA   = enriched.reduce((s, r) => s + r.stats.pa, 0);
            const totalHits = enriched.reduce((s, r) => s + r.stats.hits, 0);
            const totalK    = enriched.reduce((s, r) => s + r.stats.k, 0);
            const teamAvg   = totalPA > 0 ? (totalHits / totalPA) : 0;
            const teamKRate = totalPA > 0 ? (totalK / totalPA * 100) : 0;
            const topThreat = enriched.length > 0
                ? enriched.reduce((best, r) => r.stats.threatScore > best.stats.threatScore ? r : best)
                : null;
            const teamAvgFmt  = totalPA > 0 ? '.' + String(Math.round(teamAvg * 1000)).padStart(3,'0') : '---';
            const teamKFmt    = totalPA > 0 ? teamKRate.toFixed(1) + '%' : '---';
            const topName     = topThreat ? topThreat.entry.name : '---';
            const teamAvgColor = teamAvg >= 0.300 ? '#15803d' : teamAvg >= 0.200 ? '#374151' : '#dc2626';

            // 排序指示箭頭
            function _sortArrow(key) {
                if (_batterSortKey !== key) return '<span style="color:#d1d5db;font-size:10px;"> ↕</span>';
                return `<span style="color:#003d79;font-size:10px;"> ${_batterSortDir === 'desc' ? '↓' : '↑'}</span>`;
            }

            // 打擊率 inline bar
            function _avgBar(avgNum) {
                const pct = Math.min(avgNum / 0.400, 1);
                const w = Math.round(pct * 72);
                const barColor = avgNum >= 0.300 ? '#10b981' : avgNum >= 0.200 ? '#9ca3af' : '#ef4444';
                const fmt = avgNum > 0 ? '.' + String(Math.round(avgNum * 1000)).padStart(3,'0') : '.000';
                return `<span style="font-weight:800;font-size:13px;color:${barColor};">${fmt}</span>
                        <span style="display:inline-block;width:${w}px;height:6px;background:${barColor};border-radius:3px;margin-left:5px;vertical-align:middle;opacity:0.75;"></span>`;
            }

            // 威脅 badge
            function _threatBadge(level) {
                const cfg = {
                    high: { bg:'#dcfce7', color:'#15803d', border:'#16a34a', label:'高威脅' },
                    mid:  { bg:'#f3f4f6', color:'#6b7280', border:'#9ca3af', label:'中威脅' },
                    low:  { bg:'#fee2e2', color:'#b91c1c', border:'#ef4444', label:'低威脅' },
                };
                const c = cfg[level];
                return `<span style="display:inline-block;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:800;background:${c.bg};color:${c.color};border:1.5px solid ${c.border};white-space:nowrap;">${c.label}</span>`;
            }

            // 三振顏色
            function _kStyle(k, pa) {
                const rate = pa > 0 ? k / pa : 0;
                return rate >= 0.35 ? 'color:#dc2626;font-weight:800;' : 'color:#111827;';
            }

            // 欄位標題樣式
            const thStyle = 'padding:8px 6px;text-align:center;font-size:11px;font-weight:700;color:#6b7280;cursor:pointer;user-select:none;white-space:nowrap;border-bottom:2px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;';
            const thNameStyle = 'padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:#6b7280;cursor:pointer;user-select:none;border-bottom:2px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;';

            listEl.innerHTML = `
              <!-- 球隊摘要列 -->
              <div style="background:linear-gradient(135deg,#003d79,#0051a5);border-radius:10px;padding:14px 16px;margin-bottom:14px;color:white;">
                <div style="font-size:11px;font-weight:700;opacity:0.75;margin-bottom:8px;letter-spacing:0.05em;">⚡ 對手整體分析 ${_batterTeamFilter ? '— ' + _batterTeamFilter : ''}</div>
                <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;">
                  <div style="text-align:center;">
                    <div style="font-size:22px;font-weight:900;font-family:'Oswald',sans-serif;color:${teamAvg>=0.300?'#4ade80':teamAvg>=0.200?'#fbbf24':'#f87171'};">${teamAvgFmt}</div>
                    <div style="font-size:10px;opacity:0.75;">整體打擊率</div>
                  </div>
                  <div style="text-align:center;">
                    <div style="font-size:22px;font-weight:900;font-family:'Oswald',sans-serif;color:${parseFloat(teamKFmt)>=30?'#4ade80':'#fbbf24'};">${teamKFmt}</div>
                    <div style="font-size:10px;opacity:0.75;">整體三振率</div>
                  </div>
                  <div style="text-align:center;flex:1;min-width:80px;">
                    <div style="font-size:14px;font-weight:900;">${topName}</div>
                    <div style="font-size:10px;opacity:0.75;">最高威脅打者</div>
                  </div>
                  <div style="text-align:center;">
                    <div style="font-size:18px;font-weight:900;">${enriched.length}</div>
                    <div style="font-size:10px;opacity:0.75;">登錄打者</div>
                  </div>
                </div>
              </div>

              <!-- 可排序表格 -->
              <div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                  <tr style="background:#f9fafb;">
                    <th style="${thNameStyle}" onclick="setBatterSort('name')">姓名${_sortArrow('name')}</th>
                    <th style="${thStyle}" onclick="setBatterSort('pa')">打席${_sortArrow('pa')}</th>
                    <th style="${thStyle}min-width:130px;" onclick="setBatterSort('avg')">打擊率${_sortArrow('avg')}</th>
                    <th style="${thStyle}" onclick="setBatterSort('k')">三振${_sortArrow('k')}</th>
                    <th style="${thStyle}" onclick="setBatterSort('bb')">保送${_sortArrow('bb')}</th>
                    <th style="${thStyle}" onclick="setBatterSort('threat')">威脅${_sortArrow('threat')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${enriched.map(({ entry, stats }, i) => {
                    const teamBadge = !_batterTeamFilter
                        ? `<span style="font-size:9px;background:#e0e7ff;color:#3730a3;padding:1px 5px;border-radius:8px;margin-right:4px;vertical-align:middle;">${entry.teamName}</span>`
                        : '';
                    const rowBg = i % 2 === 0 ? 'white' : '#fafafa';
                    // bm-only 打者用 showBmBatterDetail，混合/投手打者用 showBatterDetail
                    const isBmOnly = entry._bmNum && entry.pitches.every(p => p._fromBm);
                    const clickFn  = isBmOnly
                        ? `showBmBatterDetail('${String(entry._bmNum).replace(/'/g,"\\'")}')`
                        : `showBatterDetail('${entry.nameKey.replace(/'/g,"\\'")}','pitcher','${entry.teamName.replace(/'/g,"\\'")}')`;
                    return `<tr style="background:${rowBg};cursor:pointer;transition:background 0.1s;"
                              onmouseover="this.style.background='#eff6ff'"
                              onmouseout="this.style.background='${rowBg}'"
                              onclick="${clickFn}">
                      <td style="padding:10px 10px;border-bottom:1px solid #f3f4f6;">
                        <div style="font-weight:900;color:#111827;">${teamBadge}${entry.name}</div>
                        <div style="font-size:11px;color:#9ca3af;margin-top:1px;">${entry.hand}　${entry.games.size}場</div>
                      </td>
                      <td style="padding:10px 6px;text-align:center;border-bottom:1px solid #f3f4f6;font-weight:700;color:#374151;">${stats.pa}</td>
                      <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;white-space:nowrap;">${_avgBar(stats.avgNum)}</td>
                      <td style="padding:10px 6px;text-align:center;border-bottom:1px solid #f3f4f6;${_kStyle(stats.k,stats.pa)}">${stats.k}</td>
                      <td style="padding:10px 6px;text-align:center;border-bottom:1px solid #f3f4f6;color:#374151;">${stats.bb}</td>
                      <td style="padding:10px 8px;text-align:center;border-bottom:1px solid #f3f4f6;">${_threatBadge(stats.threatLevel)}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
              </div>
              <div style="font-size:11px;color:#9ca3af;text-align:center;margin-top:8px;padding-bottom:4px;">點擊列查看詳情 · 點擊欄位標題排序</div>`;

        }
    } // end refreshBatterList

    // ── 打者卡片點擊 → 詳細分析頁 ──
    function showBmBatterCard(mapKey) {
        const data = _bmBatterCardMap && _bmBatterCardMap[mapKey];
        if (!data) return;
        const { entry, stats } = data;
        document.getElementById('batterListView').style.display = 'none';
        document.getElementById('batterDetailView').style.display = 'block';
        const numPart = entry._bmNum ? ` #${entry._bmNum}` : '';
        document.getElementById('batterDetailName').textContent = `${entry.name}${numPart}（${entry.teamName}）`;
        renderBmBatterProfile(entry.pitches, entry, stats);
    }

    // ── 個人打者分析頁（渲染至 #bmBatterProfileContent）──
    function renderBmBatterProfile(pitches, entry, stats) {
        const container = document.getElementById('bmBatterProfileContent');
        if (!container) return;

        const HIT = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const PA_END = [...HIT,'保送','觸身球','故意四壞','捕逸','三振','不死三振',
            '滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤'];
        const BIP = [...HIT,'飛球出局','滾地球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤'];

        const paPitches = pitches.filter(p => (p.outcomes||[]).some(o => PA_END.includes(o)));

        function fmtAvg(n) { return n > 0 ? '.' + String(Math.round(n * 1000)).padStart(3,'0') : '.000'; }

        // ── 1. 頂部 header ──
        const avgColor = stats.avgNum >= 0.300 ? '#4ade80' : stats.avgNum >= 0.200 ? '#fbbf24' : '#f87171';
        const opsColor = stats.ops_n  >= 0.800 ? '#4ade80' : stats.ops_n  >= 0.600 ? '#fbbf24' : '#f87171';
        const tCfg = {
            high: { bg:'#dcfce7', color:'#15803d', border:'#16a34a', label:'高威脅打者' },
            mid:  { bg:'#f3f4f6', color:'#6b7280', border:'#9ca3af', label:'中威脅打者' },
            low:  { bg:'#fee2e2', color:'#b91c1c', border:'#ef4444', label:'低威脅打者' },
        }[stats.threatLevel];
        const numPart  = entry._bmNum ? ` #${entry._bmNum}` : '';
        const opsFmt   = stats.pa >= 3 ? stats.ops_n.toFixed(3) : '---';
        const kRateFmt = stats.pa > 0 ? Math.round(stats.kRate  * 100) : '---';
        const bbRateFmt = stats.pa > 0 ? Math.round(stats.bbRate * 100) : '---';

        const sec0 = `
        <div style="background:linear-gradient(135deg,#003d79,#0051a5);padding:18px;border-radius:12px;color:white;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <div>
              <div style="font-size:11px;opacity:0.65;letter-spacing:0.05em;margin-bottom:4px;">${entry.teamName}</div>
              <div style="font-size:26px;font-weight:900;font-family:'Oswald',sans-serif;">${entry.name}${numPart}</div>
              <div style="font-size:13px;opacity:0.75;margin-top:3px;">${entry.hand||''} · ${entry.games.size} 場出賽</div>
            </div>
            <span style="display:inline-block;padding:5px 12px;border-radius:14px;font-size:13px;font-weight:800;background:${tCfg.bg};color:${tCfg.color};border:2px solid ${tCfg.border};">${tCfg.label}</span>
          </div>
          <div style="display:flex;gap:0;background:rgba(255,255,255,0.1);border-radius:10px;overflow:hidden;flex-wrap:wrap;">
            ${[
              { lbl:'打擊率', val: fmtAvg(stats.avgNum), col: avgColor },
              { lbl:'OPS',    val: opsFmt,    col: opsColor },
              { lbl:'打席',   val: stats.pa,  col: 'white'  },
              { lbl:'三振率', val: kRateFmt+'%', col: stats.kRate>=0.35?'#fbbf24':'white' },
              { lbl:'保送率', val: bbRateFmt+'%', col: 'white' },
            ].map((d,i) => `<div style="flex:1;min-width:60px;text-align:center;padding:10px 6px;${i>0?'border-left:1px solid rgba(255,255,255,0.15);':''}">
                <div style="font-size:9px;opacity:0.65;letter-spacing:0.05em;">${d.lbl}</div>
                <div style="font-size:22px;font-weight:900;font-family:'Oswald',sans-serif;color:${d.col};">${d.val}</div>
              </div>`).join('')}
          </div>
        </div>`;

        // ── 2. 球種弱點（保留供 sec6 使用）──
        const pitchW = {};
        paPitches.forEach(p => {
            if (!p.type) return;
            if (!pitchW[p.type]) pitchW[p.type] = {pa:0, k:0, hits:0};
            pitchW[p.type].pa++;
            if ((p.outcomes||[]).some(x => ['三振','不死三振'].includes(x))) pitchW[p.type].k++;
            if ((p.outcomes||[]).some(x => HIT.includes(x))) pitchW[p.type].hits++;
        });
        const ptchEntries = Object.entries(pitchW).sort((a,b) => b[1].pa - a[1].pa);
        const sec1 = ptchEntries.length === 0 ? '' : `
        <div style="background:white;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:10px;">🎯 球種弱點</div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="background:#f9fafb;">
              <th style="padding:7px 8px;text-align:left;color:#6b7280;font-size:11px;font-weight:700;">球種</th>
              <th style="padding:7px 6px;text-align:center;color:#6b7280;font-size:11px;font-weight:700;">打席</th>
              <th style="padding:7px 6px;text-align:center;color:#15803d;font-size:11px;font-weight:700;">安打率</th>
              <th style="padding:7px 6px;text-align:center;color:#dc2626;font-size:11px;font-weight:700;">三振率</th>
            </tr></thead><tbody>
            ${ptchEntries.map(([t,r]) => {
              const hp = r.pa>0 ? Math.round(r.hits/r.pa*100) : 0;
              const kp = r.pa>0 ? Math.round(r.k/r.pa*100)   : 0;
              return `<tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:8px;font-weight:700;">${t}</td>
                <td style="padding:8px;text-align:center;color:#6b7280;">${r.pa}</td>
                <td style="padding:8px;text-align:center;font-weight:700;color:${hp>=30?'#15803d':hp>=15?'#374151':'#9ca3af'};">${hp}%</td>
                <td style="padding:8px;text-align:center;font-weight:700;color:${kp>=35?'#dc2626':'#374151'};">${kp}%</td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>
        </div>`;

        // ── 3. 打擊落點圖 + 方向/型態分析 ──
        const locs = pitches.filter(p => p.hitLocation && (p.outcomes||[]).some(o => BIP.includes(o)));
        const _isHR = p => (p.outcomes||[]).includes('全壘打');
        function _makeLine(p) {
            const sx = (p.hitLocation.x * 300).toFixed(1), sy = (p.hitLocation.y * 280).toFixed(1);
            const col = (p.outcomes||[]).some(o => HIT.includes(o)) ? '#ef4444' : '#3b82f6';
            return `<line x1="150" y1="272" x2="${sx}" y2="${sy}" stroke="${col}" stroke-width="2.5" opacity="0.85" stroke-linecap="round" style="pointer-events:none;"/>`;
        }
        const linesHTML   = locs.filter(p => !_isHR(p)).map(_makeLine).join('');
        const hrLinesHTML = locs.filter(p =>  _isHR(p)).map(_makeLine).join('');
        // 方向分析（x：0=左場線, 1=右場線）
        const leftLocs   = locs.filter(p => p.hitLocation.x < 0.43);
        const centerLocs = locs.filter(p => p.hitLocation.x >= 0.43 && p.hitLocation.x <= 0.57);
        const rightLocs  = locs.filter(p => p.hitLocation.x > 0.57);
        const leftPct    = locs.length > 0 ? Math.round(leftLocs.length   / locs.length * 100) : 0;
        const centerPct  = locs.length > 0 ? Math.round(centerLocs.length / locs.length * 100) : 0;
        const rightPct   = locs.length > 0 ? 100 - leftPct - centerPct : 0;
        // 型態分析（y < 0.62 = 外野/飛球；y >= 0.62 = 內野/滾地）
        const flyLocs    = locs.filter(p => p.hitLocation.y < 0.62);
        const groundLocs = locs.filter(p => p.hitLocation.y >= 0.62);
        const flyPct     = locs.length > 0 ? Math.round(flyLocs.length / locs.length * 100) : 0;
        const groundPct  = 100 - flyPct;
        function _dH(arr) { return arr.filter(p => (p.outcomes||[]).some(o => HIT.includes(o))).length; }
        function _dA(arr) { return arr.length >= 2 ? _dH(arr) / arr.length : null; }
        const leftAvg = _dA(leftLocs), centerAvg = _dA(centerLocs), rightAvg = _dA(rightLocs);
        const flyAvg  = _dA(flyLocs),  groundAvg  = _dA(groundLocs);
        function _aC(n) { return n >= 0.300 ? '#dc2626' : n >= 0.200 ? '#374151' : '#9ca3af'; }
        // 情蒐建議
        const _ps = entry.hand === '右打' ? '左' : '右';
        const _pp = entry.hand === '右打' ? leftPct : rightPct;
        let _adv = '';
        if (locs.length >= 4) {
            if (_pp > 45 && flyPct > 55)    _adv = `偏${_ps}打者，飛球比例高。建議${_ps}外野守深，避免失分。`;
            else if (_pp > 45 && groundPct > 55) _adv = `偏${_ps}打者，滾地球為主。加強${_ps}側內野守備。`;
            else if (_pp > 45)              _adv = `拉打傾向（${_ps}場 ${_pp}%），建議${_ps}側防守強化。`;
            else if (flyPct > 60)           _adv = `飛球比例高（${flyPct}%），外野宜守深，防長打。`;
            else if (groundPct > 60)        _adv = `滾地球比例高（${groundPct}%），內野手宜前衝，留意穿越。`;
            else                            _adv = `打擊方向均衡，全場防守皆需注意。`;
        }
        const _hitCnt = _dH(locs);
        const sec2 = `
        <div style="background:#fffdf5;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">🗺️ 打擊落點圖</div>
          ${locs.length === 0
            ? `<div style="text-align:center;padding:20px 0;font-size:12px;color:#9ca3af;">尚無落點資料</div>`
            : `<div style="display:grid;grid-template-columns:55% 1fr;gap:16px;align-items:start;">
            <!-- 落點圖 左側 -->
            <div style="min-width:0;">
              ${buildFieldSVG(linesHTML, false, true, hrLinesHTML)}
              <div style="display:flex;gap:12px;margin-top:8px;font-size:12px;color:#374151;flex-wrap:wrap;align-items:center;">
                <span><svg width="20" height="12" style="vertical-align:middle;margin-right:3px;"><line x1="0" y1="6" x2="20" y2="6" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/></svg>安打（${_hitCnt}）</span>
                <span><svg width="20" height="12" style="vertical-align:middle;margin-right:3px;"><line x1="0" y1="6" x2="20" y2="6" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round"/></svg>非安打（${locs.length - _hitCnt}）</span>
                <span style="margin-left:auto;color:#9ca3af;">共 ${locs.length} 筆</span>
              </div>
            </div>
            <!-- 統計面板 右側 -->
            <div style="min-width:0;display:flex;flex-direction:column;gap:16px;">
              <div>
                <div style="font-size:13px;font-weight:700;color:#6b7280;letter-spacing:0.05em;margin-bottom:8px;">方向分佈</div>
                <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;margin-bottom:7px;">
                  <span style="color:#ef4444;">左 ${leftPct}%</span>
                  <span style="color:#10b981;">中 ${centerPct}%</span>
                  <span style="color:#3b82f6;">右 ${rightPct}%</span>
                </div>
                <div style="height:12px;border-radius:6px;overflow:hidden;display:flex;">
                  <div style="flex:${leftPct||0.1};background:#ef4444;"></div>
                  <div style="flex:${centerPct||0.1};background:#10b981;"></div>
                  <div style="flex:${rightPct||0.1};background:#3b82f6;"></div>
                </div>
              </div>
              <div>
                <div style="font-size:13px;font-weight:700;color:#6b7280;letter-spacing:0.05em;margin-bottom:8px;">打球型態</div>
                <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;margin-bottom:7px;">
                  <span style="color:#8b5cf6;">飛球 ${flyPct}%</span>
                  <span style="color:#f59e0b;">滾地 ${groundPct}%</span>
                </div>
                <div style="height:12px;border-radius:6px;overflow:hidden;display:flex;">
                  <div style="flex:${flyPct||0.1};background:#8b5cf6;"></div>
                  <div style="flex:${groundPct||0.1};background:#f59e0b;"></div>
                </div>
              </div>
              ${(leftAvg!==null||centerAvg!==null||rightAvg!==null) ? `<div>
                <div style="font-size:13px;font-weight:700;color:#6b7280;letter-spacing:0.05em;margin-bottom:4px;">各方向安打率</div>
                ${leftAvg  !==null?`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;"><span style="font-size:18px;color:#374151;">左</span><span style="font-size:30px;font-weight:900;font-family:'Oswald',sans-serif;color:${_aC(leftAvg)};">${fmtAvg(leftAvg)}</span></div>`:''}
                ${centerAvg!==null?`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;"><span style="font-size:18px;color:#374151;">中</span><span style="font-size:30px;font-weight:900;font-family:'Oswald',sans-serif;color:${_aC(centerAvg)};">${fmtAvg(centerAvg)}</span></div>`:''}
                ${rightAvg !==null?`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;"><span style="font-size:18px;color:#374151;">右</span><span style="font-size:30px;font-weight:900;font-family:'Oswald',sans-serif;color:${_aC(rightAvg)};">${fmtAvg(rightAvg)}</span></div>`:''}
              </div>` : ''}
              ${(flyAvg!==null||groundAvg!==null) ? `<div>
                <div style="font-size:13px;font-weight:700;color:#6b7280;letter-spacing:0.05em;margin-bottom:4px;">型態安打率</div>
                ${flyAvg   !==null?`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;"><span style="font-size:18px;color:#374151;">飛球</span><span style="font-size:30px;font-weight:900;font-family:'Oswald',sans-serif;color:${_aC(flyAvg)};">${fmtAvg(flyAvg)}</span></div>`:''}
                ${groundAvg!==null?`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;"><span style="font-size:18px;color:#374151;">滾地</span><span style="font-size:30px;font-weight:900;font-family:'Oswald',sans-serif;color:${_aC(groundAvg)};">${fmtAvg(groundAvg)}</span></div>`:''}
              </div>` : ''}
              ${_adv ? `<div style="background:#fffbeb;border-radius:8px;padding:10px 12px;font-size:14px;color:#92400e;border:1px solid #fde68a;line-height:1.6;">${_adv}</div>` : ''}
            </div>
          </div>`}
        </div>`;

        // ══════════════════════════════════════════════
        // 新版七大區塊
        // ══════════════════════════════════════════════

        // ── ① 對左右投差異 ──
        const _lrHits = arr => arr.filter(p=>(p.outcomes||[]).some(o=>HIT.includes(o))).length;
        const _lrK    = arr => arr.filter(p=>(p.outcomes||[]).some(o=>['三振','不死三振'].includes(o))).length;
        const _lrBB   = arr => arr.filter(p=>(p.outcomes||[]).some(o=>['保送','觸身球','故意四壞'].includes(o))).length;
        const vsR = paPitches.filter(p=>(p.pitcherHand||'右投')==='右投');
        const vsL = paPitches.filter(p=>p.pitcherHand==='左投');
        function _lrBox(arr, label) {
            if (arr.length===0) return `<div style="flex:1;text-align:center;padding:10px 8px;background:#f9fafb;border-radius:8px;"><div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:4px;">${label}</div><div style="font-size:14px;color:#9ca3af;">無資料</div></div>`;
            const avg=_lrHits(arr)/arr.length, kp=Math.round(_lrK(arr)/arr.length*100), bbp=Math.round(_lrBB(arr)/arr.length*100);
            const col=avg>=0.300?'#dc2626':avg>=0.200?'#374151':'#10b981';
            return `<div style="flex:1;text-align:center;padding:10px 8px;background:#f9fafb;border-radius:8px;">
                <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px;">${label}</div>
                <div style="font-size:32px;font-weight:900;font-family:'Oswald',sans-serif;color:${col};">${fmtAvg(avg)}</div>
                <div style="font-size:11px;color:#6b7280;margin-top:4px;">${arr.length} 打席</div>
                <div style="font-size:11px;margin-top:4px;"><span style="color:#dc2626;">K ${kp}%</span><span style="color:#10b981;margin-left:8px;">BB ${bbp}%</span></div>
            </div>`;
        }
        const _lrAdvice = (()=>{
            if (vsL.length<3||vsR.length<3) return '';
            const aL=_lrHits(vsL)/vsL.length, aR=_lrHits(vsR)/vsR.length, diff=Math.abs(aL-aR);
            if (diff<0.05) return '左右投差異不明顯，均衡型打者';
            return aL>aR ? `對左投較強（差距 +${(aL-aR).toFixed(3).slice(1)}），建議使用右投對陣` : `對右投較強（差距 +${(aR-aL).toFixed(3).slice(1)}），建議使用左投對陣`;
        })();
        const sec_lr = `<div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">⚔️ ① 對左右投差異</div>
            <div style="display:flex;gap:8px;margin-bottom:10px;">${_lrBox(vsR,'對右投')}${_lrBox(vsL,'對左投')}</div>
            ${_lrAdvice?`<div style="font-size:12px;background:#fffbeb;border-radius:6px;padding:7px 10px;color:#92400e;border:1px solid #fde68a;">💡 ${_lrAdvice}</div>`:''}
        </div>`;

        // ── ② 首球攻擊傾向 ──
        const firstPAs  = paPitches.filter(p=>(p.balls||0)===0&&(p.strikes||0)===0);
        const firstHits = firstPAs.filter(p=>(p.outcomes||[]).some(o=>HIT.includes(o))).length;
        const firstOuts = firstPAs.filter(p=>!(p.outcomes||[]).some(o=>[...HIT,'保送','觸身球','故意四壞','捕逸'].includes(o))).length;
        const firstPct  = paPitches.length>0?Math.round(firstPAs.length/paPitches.length*100):0;
        const firstCol  = firstPct>=40?'#dc2626':firstPct>=25?'#f59e0b':'#10b981';
        const firstLabel= firstPct>=40?'積極出手型':firstPct>=25?'中等積極':'耐心等球型';
        const sec_first = `<div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">⚡ ② 首球攻擊傾向</div>
            <div style="text-align:center;margin-bottom:12px;">
                <div style="font-size:48px;font-weight:900;font-family:'Oswald',sans-serif;color:${firstCol};">${firstPct}%</div>
                <div style="font-size:12px;color:#6b7280;">首球就結束的打席比例</div>
                <div style="display:inline-block;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:700;background:${firstCol}22;color:${firstCol};margin-top:4px;">${firstLabel}</div>
            </div>
            ${firstPAs.length>0?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;margin-bottom:10px;">
                <div style="text-align:center;padding:6px;background:#fef2f2;border-radius:6px;"><div style="font-weight:700;color:#dc2626;">安打 ${firstHits}次</div><div style="color:#6b7280;">安打率 ${firstPAs.length>0?fmtAvg(firstHits/firstPAs.length):'.000'}</div></div>
                <div style="text-align:center;padding:6px;background:#f9fafb;border-radius:6px;"><div style="font-weight:700;color:#374151;">出局 ${firstOuts}次</div><div style="color:#6b7280;">出局率 ${firstPAs.length>0?Math.round(firstOuts/firstPAs.length*100):0}%</div></div>
            </div>`:''}
            <div style="font-size:11px;color:#6b7280;text-align:center;">${firstPct>=40?'💡 首球配誘導球，不要輕易進好球帶':firstPct<25?'💡 首球可直接挑戰，他傾向等球':'💡 首球可測試，觀察其反應'}</div>
        </div>`;

        // ── ③ 選球傾向（打席深度） ──
        const totPA_n   = paPitches.length||1;
        const earlyN    = paPitches.filter(p=>(p.balls||0)+(p.strikes||0)<=1).length;
        const midN      = paPitches.filter(p=>{const t=(p.balls||0)+(p.strikes||0);return t===2||t===3;}).length;
        const deepN     = paPitches.filter(p=>(p.balls||0)+(p.strikes||0)>=4).length;
        const earlyPct  = Math.round(earlyN/totPA_n*100);
        const midPct_n  = Math.round(midN/totPA_n*100);
        const deepPct_n = 100-earlyPct-midPct_n;
        const bbCnt     = paPitches.filter(p=>(p.outcomes||[]).some(o=>['保送','觸身球','故意四壞'].includes(o))).length;
        const bbPctN    = Math.round(bbCnt/totPA_n*100);
        const patienceL = bbPctN>=15?'選球型':earlyPct>=40?'積極型':deepPct_n>=35?'耐心型':'均衡型';
        const patienceC = bbPctN>=15?'#10b981':earlyPct>=40?'#dc2626':deepPct_n>=35?'#3b82f6':'#374151';
        const sec_patience = `<div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">🎯 ③ 選球傾向</div>
            <div style="text-align:center;margin-bottom:12px;">
                <div style="font-size:28px;font-weight:900;color:${patienceC};">${patienceL}</div>
                <div style="font-size:12px;color:#6b7280;">保送率 ${bbPctN}%</div>
            </div>
            <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:8px;">打席球數深度分佈</div>
            <div style="display:flex;flex-direction:column;gap:7px;">
                ${[{l:'1-2球（首球）',p:earlyPct,c:'#f59e0b'},{l:'3-4球（中段）',p:midPct_n,c:'#6b7280'},{l:'5球＋（深球數）',p:deepPct_n,c:'#3b82f6'}].map(r=>`
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="width:80px;font-size:11px;color:#374151;flex-shrink:0;">${r.l}</span>
                    <div style="flex:1;height:10px;background:#f3f4f6;border-radius:5px;overflow:hidden;"><div style="width:${r.p}%;height:100%;background:${r.c};border-radius:5px;"></div></div>
                    <span style="font-size:12px;font-weight:700;color:${r.c};width:32px;text-align:right;">${r.p}%</span>
                </div>`).join('')}
            </div>
            <div style="font-size:11px;color:#6b7280;margin-top:10px;text-align:center;">${bbPctN>=15?'💡 選球好，必須投到好球帶':earlyPct>=40?'💡 容易早出手，可配誘導球':'💡 打席較長，需耐心佈局'}</div>
        </div>`;

        // ── ④ 兩好球應對 ──
        const tsPA   = paPitches.filter(p=>(p.strikes||0)>=2);
        const tsK    = tsPA.filter(p=>(p.outcomes||[]).some(o=>['三振','不死三振'].includes(o))).length;
        const tsH    = tsPA.filter(p=>(p.outcomes||[]).some(o=>HIT.includes(o))).length;
        const tsO    = Math.max(0,tsPA.length-tsK-tsH);
        const tsKp   = tsPA.length>0?Math.round(tsK/tsPA.length*100):0;
        const tsHp   = tsPA.length>0?Math.round(tsH/tsPA.length*100):0;
        const tsOp   = Math.max(0,100-tsKp-tsHp);
        const tsTypes={};
        tsPA.forEach(p=>{if(!p.type)return;if(!tsTypes[p.type])tsTypes[p.type]={n:0,k:0,h:0};tsTypes[p.type].n++;if((p.outcomes||[]).some(o=>['三振','不死三振'].includes(o)))tsTypes[p.type].k++;if((p.outcomes||[]).some(o=>HIT.includes(o)))tsTypes[p.type].h++;});
        const bestType2S=Object.entries(tsTypes).filter(([,v])=>v.n>=2).sort((a,b)=>b[1].k/b[1].n-a[1].k/a[1].n)[0];
        const sec_2strike = `<div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">🔴 ④ 兩好球應對</div>
            ${tsPA.length===0?`<div style="text-align:center;font-size:12px;color:#9ca3af;padding:10px;">資料不足</div>`:`
            <div style="text-align:center;margin-bottom:10px;">
                <div style="font-size:11px;color:#6b7280;margin-bottom:6px;">進入兩好球共 ${tsPA.length} 打席</div>
                <div style="display:flex;height:20px;border-radius:10px;overflow:hidden;gap:1px;margin-bottom:8px;">
                    <div style="flex:${tsKp||0.5};background:#10b981;"></div>
                    <div style="flex:${tsHp||0.5};background:#ef4444;"></div>
                    <div style="flex:${tsOp||0.5};background:#d1d5db;"></div>
                </div>
                <div style="display:flex;justify-content:center;gap:14px;font-size:13px;font-weight:800;">
                    <span style="color:#10b981;">三振 ${tsKp}%</span>
                    <span style="color:#ef4444;">安打 ${tsHp}%</span>
                    <span style="color:#9ca3af;">其他出局 ${tsOp}%</span>
                </div>
            </div>
            ${bestType2S?`<div style="background:#f0fdf4;border-radius:8px;padding:8px 12px;font-size:12px;color:#15803d;border:1px solid #bbf7d0;margin-bottom:8px;">💡 兩好球最有效：<strong>${bestType2S[0]}</strong>（K率 ${Math.round(bestType2S[1].k/bestType2S[1].n*100)}%）</div>`:''}
            <div style="font-size:11px;color:#6b7280;text-align:center;">${tsKp>=40?'三振率高，進兩好球積極配球':tsHp>=30?'⚠️ 兩好球仍具威脅，謹慎收尾':'保守出局居多，持續施壓'}</div>`}
        </div>`;

        // ── ⑤ 出局方式分佈 ──
        const OUT_LIST=['滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤','三振','不死三振'];
        const outsPA = paPitches.filter(p=>(p.outcomes||[]).some(o=>OUT_LIST.includes(o)));
        const kOuts  = outsPA.filter(p=>(p.outcomes||[]).some(o=>['三振','不死三振'].includes(o))).length;
        const gOuts  = outsPA.filter(p=>(p.outcomes||[]).some(o=>['滾地球出局','雙殺'].includes(o))).length;
        const fOuts  = outsPA.filter(p=>(p.outcomes||[]).some(o=>['飛球出局','平飛球出局','高飛犧牲打'].includes(o))).length;
        const oOuts  = Math.max(0,outsPA.length-kOuts-gOuts-fOuts);
        const totO   = outsPA.length||1;
        const defTip = fOuts>gOuts&&fOuts>kOuts?'飛球型，外野宜守深，防長打':gOuts>fOuts&&gOuts>kOuts?'滾地球型，內野前衝可守':kOuts>fOuts&&kOuts>gOuts?'三振型，積極配球效果佳':'均衡型，無特定守備建議';
        const sec_out = `<div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">📊 ⑤ 出局方式</div>
            ${outsPA.length===0?`<div style="text-align:center;font-size:12px;color:#9ca3af;padding:10px;">資料不足</div>`:`
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
                ${[{l:'三振',n:kOuts,c:'#8b5cf6'},{l:'飛球出局',n:fOuts,c:'#3b82f6'},{l:'滾地出局',n:gOuts,c:'#f59e0b'},{l:'其他',n:oOuts,c:'#9ca3af'}].map(r=>`
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="width:60px;font-size:12px;color:#374151;flex-shrink:0;">${r.l}</span>
                    <div style="flex:1;height:12px;background:#f3f4f6;border-radius:6px;overflow:hidden;"><div style="width:${Math.round(r.n/totO*100)}%;height:100%;background:${r.c};border-radius:6px;"></div></div>
                    <span style="font-size:12px;font-weight:700;color:${r.c};width:28px;text-align:right;">${r.n}</span>
                </div>`).join('')}
            </div>
            <div style="font-size:12px;background:#fffbeb;border-radius:6px;padding:7px 10px;color:#92400e;border:1px solid #fde68a;">🛡️ ${defTip}</div>`}
        </div>`;

        // ── ⑥ 弱點球種 × 落點熱區 ──
        const locs3 = paPitches.filter(p=>p.hitLocation);
        function _zStat(x0,x1,y0,y1){
            const z=locs3.filter(p=>p.hitLocation.x>=x0&&p.hitLocation.x<x1&&p.hitLocation.y>=y0&&p.hitLocation.y<y1);
            const h=z.filter(p=>(p.outcomes||[]).some(o=>HIT.includes(o))).length;
            return {n:z.length,h,avg:z.length>0?h/z.length:null};
        }
        const GRID=[
            [_zStat(0,0.43,0,0.45),_zStat(0.43,0.57,0,0.45),_zStat(0.57,1,0,0.45)],
            [_zStat(0,0.43,0.45,0.70),_zStat(0.43,0.57,0.45,0.70),_zStat(0.57,1,0.45,0.70)],
            [_zStat(0,0.43,0.70,1),_zStat(0.43,0.57,0.70,1),_zStat(0.57,1,0.70,1)],
        ];
        const ZLABELS=[['左深','中深','右深'],['左中','中間','右中'],['左淺','中淺','右淺']];
        function _zbg(a){return a===null?'#f9fafb':a>=0.400?'#fee2e2':a>=0.250?'#fef9c3':'#dcfce7';}
        function _zcol(a){return a===null?'#d1d5db':a>=0.400?'#dc2626':a>=0.250?'#92400e':'#15803d';}
        const sec_zone = `<div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:12px;">🗺️ ⑥ 弱點球種 × 落點熱區</div>
            ${ptchEntries.length>0?`
            <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px;">球種弱點</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;">
                <thead><tr style="background:#f9fafb;">
                    <th style="padding:5px 6px;text-align:left;color:#6b7280;font-size:11px;">球種</th>
                    <th style="padding:5px 4px;text-align:center;color:#6b7280;font-size:11px;">打席</th>
                    <th style="padding:5px 4px;text-align:center;color:#15803d;font-size:11px;">安打率</th>
                    <th style="padding:5px 4px;text-align:center;color:#dc2626;font-size:11px;">K率</th>
                </tr></thead><tbody>
                ${ptchEntries.map(([t,v])=>{const a2=v.pa>0?v.hits/v.pa:0,kp2=v.pa>0?Math.round(v.k/v.pa*100):0;return `<tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:6px;">${t}</td><td style="padding:6px;text-align:center;color:#374151;">${v.pa}</td><td style="padding:6px;text-align:center;font-weight:700;color:${a2>=0.300?'#dc2626':a2>=0.200?'#374151':'#10b981'};">${fmtAvg(a2)}</td><td style="padding:6px;text-align:center;font-weight:700;color:${kp2>=35?'#dc2626':'#374151'};">${kp2}%</td></tr>`;}).join('')}
                </tbody>
            </table>`:''}
            ${locs3.length>=3?`
            <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:6px;">落點安打率（紅＝危 綠＝安全）</div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
                ${GRID.flatMap((row,ri)=>row.map((z,ci)=>`<div style="background:${_zbg(z.avg)};border-radius:6px;padding:8px 4px;text-align:center;">
                    <div style="font-size:10px;color:#6b7280;">${ZLABELS[ri][ci]}</div>
                    <div style="font-size:18px;font-weight:900;font-family:'Oswald',sans-serif;color:${_zcol(z.avg)};">${z.avg!==null?fmtAvg(z.avg):'—'}</div>
                    <div style="font-size:10px;color:#9ca3af;">${z.n}筆</div>
                </div>`)).join('')}
            </div>
            <div style="font-size:10px;color:#9ca3af;margin-top:6px;">≥.400 危險 ≥.250 注意</div>`:`<div style="font-size:12px;color:#9ca3af;text-align:center;margin-top:4px;">需更多落點資料（至少3筆）</div>`}
        </div>`;

        // ── ⑦ 戰術時機點（全為 0 則不顯示）──
        const buntPA   = paPitches.filter(p=>(p.outcomes||[]).includes('犧牲觸擊'));
        const hitRunPA = paPitches.filter(p=>(p.outcomes||[]).includes('打帶跑'));
        const steals   = (allData.bm?.steals||[]).filter(s =>
            entry._bmNum && String(s.runnerNumber||'') === String(entry._bmNum)
        );
        function _topCount(arr) {
            const m={};
            arr.forEach(p=>{const k=`${p.balls||0}B ${p.strikes||0}S`;m[k]=(m[k]||0)+1;});
            const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
            return top?`${top[0]}（${top[1]}次）`:'無資料';
        }
        const sec5 = (buntPA.length+hitRunPA.length+steals.length===0) ? '' : `
        <div style="background:white;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
          <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:10px;">⚔️ 戰術時機點</div>
          ${buntPA.length>0?`<div style="margin-bottom:8px;padding:9px 10px;background:#fdf4ff;border-radius:8px;border-left:3px solid #ec4899;">
            <div style="font-size:12px;font-weight:800;color:#ec4899;">📦 犧牲觸擊 ${buntPA.length}次</div>
            <div style="font-size:12px;color:#374151;margin-top:3px;">最常球數：${_topCount(buntPA)}</div>
          </div>`:''}
          ${hitRunPA.length>0?`<div style="margin-bottom:8px;padding:9px 10px;background:#f5f3ff;border-radius:8px;border-left:3px solid #7c3aed;">
            <div style="font-size:12px;font-weight:800;color:#7c3aed;">🏃 打帶跑 ${hitRunPA.length}次</div>
            <div style="font-size:12px;color:#374151;margin-top:3px;">最常球數：${_topCount(hitRunPA)}</div>
          </div>`:''}
          ${steals.length>0?`<div style="padding:9px 10px;background:#f0fdf4;border-radius:8px;border-left:3px solid #10b981;">
            <div style="font-size:12px;font-weight:800;color:#10b981;">⚡ 盜壘 ${steals.length}次（成功 ${steals.filter(s=>s.success).length} 次）</div>
          </div>`:''}
        </div>`;

        // 從打線查找自訂備註（trait）
        const _bmNum = entry._bmNum ? String(entry._bmNum) : '';
        let _trait = '';
        if (_bmNum) {
            const _allLineup = [...(allData.bm?.lineupA || []), ...(allData.bm?.lineupB || [])];
            const _lineupEntry = _allLineup.find(b => String(b.number || '') === _bmNum);
            if (_lineupEntry) _trait = _lineupEntry.trait || '';
        }
        const _traitSafe = _trait.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const secNotes = `
        <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.08);margin-bottom:12px;">
            <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:14px;">📝 情蒐備註</div>
            <div style="background:#fffbeb;border-radius:10px;padding:16px 18px;border:1px solid #fde68a;min-height:120px;font-size:17px;font-weight:700;color:#374151;line-height:2;white-space:pre-wrap;">${_traitSafe || '<span style="font-size:13px;color:#9ca3af;font-weight:400;font-style:italic;">尚未填寫情蒐備註</span>'}</div>
        </div>`;

        container.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
            <div style="min-width:0;">
                ${sec0}${sec2}
                <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px;">
                    ${[sec_lr,sec_first,sec_patience,sec_2strike,sec_out,sec_zone,sec5].filter(Boolean).join('')}
                </div>
            </div>
            <div style="min-width:0;">${secNotes}</div>
        </div>`;
        container.scrollTop = 0;
    }

    function showBatterDetail(name, source, thirdArg) {
        // pitcher source: thirdArg = teamName (string)
        // standalone source: thirdArg = idx (number)
        const idxVal      = (source === 'standalone' && typeof thirdArg === 'number') ? thirdArg : null;
        const teamNameVal = (source === 'pitcher'    && typeof thirdArg === 'string') ? thirdArg : null;
        _currentBatterView = { name, source, idx: idxVal, teamName: teamNameVal };
        document.getElementById('batterListView').style.display = 'none';
        document.getElementById('batterDetailView').style.display = 'block';
        const displayName = name.startsWith('#') ? `背號 ${name.slice(1)}` : name;
        document.getElementById('batterDetailName').textContent =
            teamNameVal ? `${displayName}（${teamNameVal}）` : displayName;
        const atBatLogEl = document.getElementById('batterAtBatLogSection');
        if (atBatLogEl) atBatLogEl.style.display = source === 'standalone' ? 'block' : 'none';
        renderBatterDetail(name, source, thirdArg);
    }

    function closeBatterDetail() {
        _currentBatterView = null;
        document.getElementById('batterListView').style.display = 'block';
        document.getElementById('batterDetailView').style.display = 'none';
    }

    function renderBatterDetail(name, source, thirdArg) {
        let pitches = [];
        let atBats = [];
        let steals = [];
        if (source === 'pitcher') {
            // name 可能是姓名或 "#背號" key
            const isNumKey = name.startsWith('#');
            const numKey = isNumKey ? name.slice(1) : null;
            const teamFilter = (typeof thirdArg === 'string') ? thirdArg : null;
            allData.teams.forEach((team, ti) => {
                team.pitchers.forEach(p => {
                    p.pitches.forEach(pitch => {
                        let match = false;
                        if (isNumKey) {
                            match = String(pitch.batterNumber || '') === numKey && !(pitch.batterName || '').trim();
                        } else {
                            match = (pitch.batterName || '').trim() === name.trim();
                        }
                        // 若有隊伍篩選，進一步確認 pitch 的隊伍
                        if (match && teamFilter) {
                            const pitchTeam = pitch.batterTeam || _inferBatterTeam(pitch, team) || '未分類';
                            match = pitchTeam === teamFilter;
                        }
                        if (match) pitches.push({ ...pitch, _ti: ti });
                    });
                    (p.steals || []).forEach(s => {
                        if (!isNumKey && (s.name || '').trim() === name.trim()) steals.push(s);
                    });
                });
            });
        } else {
            const idx = (typeof thirdArg === 'number') ? thirdArg : null;
            const batter = idx !== null ? allData.batterData[idx] : null;
            if (batter) atBats = batter.atBats || [];
        }
        renderBatterStats(pitches, atBats, source);
        renderBatterHitMap(pitches, atBats, source);
        renderBatterAnalysis(pitches, atBats, source);
        _renderBatterSteals(steals);
        if (source === 'standalone') {
            const idx = (typeof thirdArg === 'number') ? thirdArg : null;
            renderAtBatLog(atBats, idx);
        }
    }

    function _renderBatterSteals(steals) {
        const el = document.getElementById('batterStealsSection');
        if (!el) return;
        if (steals.length === 0) { el.style.display = 'none'; return; }
        el.style.display = '';
        const total   = steals.length;
        const success = steals.filter(s => s.success).length;
        const rate    = Math.round(success / total * 100);
        const baseName = b => b === 'H' ? '本壘' : b + '壘';
        const rows = steals.map(s => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
                <span style="color:#6b7280;">${s.inning}局${s.half} ${s.outs}出局</span>
                <span>${baseName(s.fromBase)} → ${baseName(s.toBase)}</span>
                <span style="font-weight:800;color:${s.success ? '#16a34a' : '#dc2626'};">${s.success ? '✅ 成功' : '❌ 失敗'}</span>
            </div>`).join('');
        el.innerHTML = `
            <h2>🏃 盜壘記錄</h2>
            <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
                <div class="bsc"><div class="bsc-v">${total}</div><div class="bsc-l">總次數</div></div>
                <div class="bsc"><div class="bsc-v">${success}</div><div class="bsc-l">成功</div></div>
                <div class="bsc"><div class="bsc-v">${rate}%</div><div class="bsc-l">成功率</div></div>
            </div>
            <div>${rows}</div>`;
    }

    function renderBatterStats(pitches, atBats, source) {
        const el = document.getElementById('batterDetailStats');
        if (!el) return;
        const HIT_OUTCOMES = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];

        if (source === 'pitcher') {
            const pa = pitches.filter(p => p.outcomes && p.outcomes.some(o => PA_ENDING.includes(o))).length;
            const hits = pitches.filter(p => p.outcomes && p.outcomes.some(o => HIT_OUTCOMES.includes(o))).length;
            const k = pitches.filter(p => p.outcomes && (p.outcomes.includes('三振') || p.outcomes.includes('不死三振'))).length;
            const bb = pitches.filter(p => p.outcomes && p.outcomes.includes('保送')).length;
            const avg = pa > 0 ? (hits / pa).toFixed(3) : '.000';
            const totalP = pitches.length;
            const strikeP = pitches.filter(p => p.zone && /^[1-9]$/.test(p.zone)).length;
            const swingP = pitches.filter(p => p.swing || p.foul).length;
            el.innerHTML = `<div class="batter-stats-grid">
              <div class="bsc"><div class="bsc-v">${pa}</div><div class="bsc-l">打席</div></div>
              <div class="bsc"><div class="bsc-v">${hits}</div><div class="bsc-l">安打</div></div>
              <div class="bsc"><div class="bsc-v">${avg}</div><div class="bsc-l">打擊率</div></div>
              <div class="bsc"><div class="bsc-v">${k}</div><div class="bsc-l">三振</div></div>
              <div class="bsc"><div class="bsc-v">${bb}</div><div class="bsc-l">保送</div></div>
              <div class="bsc"><div class="bsc-v">${totalP}</div><div class="bsc-l">面對球數</div></div>
              <div class="bsc"><div class="bsc-v">${totalP > 0 ? Math.round(strikeP/totalP*100) : 0}%</div><div class="bsc-l">好球帶進球率</div></div>
              <div class="bsc"><div class="bsc-v">${totalP > 0 ? Math.round(swingP/totalP*100) : 0}%</div><div class="bsc-l">揮棒率</div></div>
            </div>`;
        } else {
            const pa = atBats.length;
            const hits = atBats.filter(ab => HIT_OUTCOMES.includes(ab.outcome)).length;
            const k = atBats.filter(ab => ab.outcome === '三振' || ab.outcome === '不死三振').length;
            const bb = atBats.filter(ab => ab.outcome === '保送').length;
            const bunts = atBats.filter(ab => ab.isBunt).length;
            const avg = pa > 0 ? (hits / pa).toFixed(3) : '.000';
            el.innerHTML = `<div class="batter-stats-grid">
              <div class="bsc"><div class="bsc-v">${pa}</div><div class="bsc-l">打席</div></div>
              <div class="bsc"><div class="bsc-v">${hits}</div><div class="bsc-l">安打</div></div>
              <div class="bsc"><div class="bsc-v">${avg}</div><div class="bsc-l">打擊率</div></div>
              <div class="bsc"><div class="bsc-v">${k}</div><div class="bsc-l">三振</div></div>
              <div class="bsc"><div class="bsc-v">${bb}</div><div class="bsc-l">保送</div></div>
              <div class="bsc"><div class="bsc-v">${bunts}</div><div class="bsc-l">短打次數</div></div>
            </div>`;
        }
    }

    function renderBatterHitMap(pitches, atBats, source) {
        const container = document.getElementById('batterHitMapContainer');
        if (!container) return;
        const HIT_OUTCOMES = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        let locs = [];

        if (source === 'pitcher') {
            locs = pitches.filter(p => p.hitLocation && p.outcomes && p.outcomes.some(o => BALL_IN_PLAY_OUTCOMES.includes(o)))
                .map(p => ({ x: p.hitLocation.x, y: p.hitLocation.y, zone: p.hitLocation.zone,
                    isHit: p.outcomes.some(o => HIT_OUTCOMES.includes(o)), outcome: (p.outcomes||[])[0] || '' }));
        } else {
            locs = atBats.filter(ab => ab.hitLocation)
                .map(ab => ({ x: ab.hitLocation.x, y: ab.hitLocation.y, zone: ab.hitLocation.zone,
                    isHit: HIT_OUTCOMES.includes(ab.outcome), outcome: ab.outcome || '' }));
        }

        const zoneCounts = {};
        locs.forEach(l => {
            if (!zoneCounts[l.zone]) zoneCounts[l.zone] = { total: 0, hits: 0 };
            zoneCounts[l.zone].total++;
            if (l.isHit) zoneCounts[l.zone].hits++;
        });

        // 線條：從本壘板 (150,272) 畫到落點，紅=安打，藍=非安打，重疊自然加深
        const dotsHTML = locs.map(l => {
            const sx = (l.x * 300).toFixed(1), sy = (l.y * 280).toFixed(1);
            const color = l.isHit ? '#ef4444' : '#3b82f6';
            return `<line x1="150" y1="272" x2="${sx}" y2="${sy}" stroke="${color}" stroke-width="2" opacity="0.7" stroke-linecap="round" style="pointer-events:none;"/>`;
        }).join('');

        const zoneRows = Object.entries(zoneCounts).sort((a,b) => b[1].total - a[1].total)
            .map(([zone, c]) => `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
                <span>${zone}</span><span><b>${c.total}</b>${c.hits > 0 ? ` (${c.hits} 安打)` : ''}</span>
            </div>`).join('');

        container.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;">
          <div style="flex:0 0 auto;">${buildFieldSVG(dotsHTML)}
            <div style="display:flex;gap:14px;margin-top:8px;justify-content:center;font-size:12px;">
              <span><svg width="20" height="12" style="vertical-align:middle;margin-right:3px;"><line x1="0" y1="6" x2="20" y2="6" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/></svg>安打</span>
              <span><svg width="20" height="12" style="vertical-align:middle;margin-right:3px;"><line x1="0" y1="6" x2="20" y2="6" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/></svg>非安打</span>
            </div>
          </div>
          ${locs.length === 0 ? `<div style="color:#9ca3af;font-size:13px;padding:16px 0;">
              尚無落點記錄<br><small>${source==='pitcher'?'記錄投球後選擇打擊落點':'新增打席時選擇落點'}</small></div>` :
            `<div style="flex:1;min-width:130px;">
               <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">落點分布</div>
               ${zoneRows}
             </div>`}
        </div>`;
    }

    function renderBatterAnalysis(pitches, atBats, source) {
        const el = document.getElementById('batterAnalysisCards');
        if (!el) return;
        const HIT_OUTCOMES = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const DIR_MAP = { 'LF':'左','LCF':'左中','CF':'中','RCF':'右中','RF':'右',
            '3B':'左','SS':'左中','2B':'右中','1B':'右','三短':'左','一短':'右','P':'中','本壘前':'中' };

        function pct(n, total) { return total > 0 ? Math.round(n / total * 100) : 0; }
        function avg(hits, pa) { return pa > 0 ? (hits / pa).toFixed(3) : '.000'; }

        if (source === 'pitcher') {
            if (pitches.length === 0) { el.innerHTML = ''; return; }

            // 打擊方向
            const dirC = { '左':0,'中':0,'右':0 };
            const dirTotal = pitches.filter(p => p.hitLocation).length;
            pitches.forEach(p => { if (p.hitLocation) { const d = DIR_MAP[p.hitLocation.zone]; if (d) dirC[d]++; } });

            // 打擊類型
            const typeC = { '安打':0,'飛球':0,'滾地':0,'平飛':0,'短打':0,'三振':0,'保送':0 };
            const paList = pitches.filter(p => p.outcomes && p.outcomes.some(o => PA_ENDING.includes(o)));
            paList.forEach(p => {
                if (p.outcomes.some(o => HIT_OUTCOMES.includes(o))) typeC['安打']++;
                else if (p.outcomes.some(o => ['飛球出局','高飛犧牲打'].includes(o))) typeC['飛球']++;
                else if (p.outcomes.includes('滾地球出局')) typeC['滾地']++;
                else if (p.outcomes.includes('平飛球出局')) typeC['平飛']++;
                else if (p.outcomes.includes('犧牲觸擊')) typeC['短打']++;
                else if (p.outcomes.includes('三振')) typeC['三振']++;
                else if (p.outcomes.includes('保送')) typeC['保送']++;
            });

            // 球種弱點
            const pitchR = {};
            paList.forEach(p => {
                if (!p.type) return;
                if (!pitchR[p.type]) pitchR[p.type] = { pa:0, k:0, hits:0 };
                pitchR[p.type].pa++;
                if (p.outcomes.includes('三振')) pitchR[p.type].k++;
                if (p.outcomes.some(o => HIT_OUTCOMES.includes(o))) pitchR[p.type].hits++;
            });

            // 球數傾向
            const countPA = {}, countHits = {};
            paList.forEach(p => {
                const key = `${p.balls||0}-${p.strikes||0}`;
                countPA[key] = (countPA[key]||0)+1;
                if (p.outcomes.some(o => HIT_OUTCOMES.includes(o))) countHits[key] = (countHits[key]||0)+1;
            });

            // 壘上應對
            const baseR = { '空壘':{pa:0,hits:0},'有人在壘':{pa:0,hits:0} };
            paList.forEach(p => {
                const k = p.runnersOn ? '有人在壘' : '空壘';
                baseR[k].pa++;
                if (p.outcomes.some(o => HIT_OUTCOMES.includes(o))) baseR[k].hits++;
            });

            el.innerHTML = `
              ${dirTotal > 0 ? `<div class="bac">
                <div class="bac-title">打擊方向傾向</div>
                <div class="bac-row">
                  ${['左','中','右'].map(d => `<div class="bac-stat"><div class="bac-v">${pct(dirC[d],dirTotal)}%</div><div class="bac-l">${d}（${dirC[d]}）</div></div>`).join('')}
                </div></div>` : ''}

              ${paList.length > 0 ? `<div class="bac">
                <div class="bac-title">打擊類型分布</div>
                <div class="bac-row" style="flex-wrap:wrap;">
                  ${Object.entries(typeC).filter(([,v])=>v>0).map(([t,n]) => `<div class="bac-stat"><div class="bac-v">${pct(n,paList.length)}%</div><div class="bac-l">${t}（${n}）</div></div>`).join('')}
                </div></div>` : ''}

              ${Object.keys(pitchR).length > 0 ? `<div class="bac">
                <div class="bac-title">球種弱點（各球種打席結果）</div>
                <table class="bac-table">
                  <tr><th>球種</th><th>打席</th><th>安打</th><th>打擊率</th><th>三振率</th></tr>
                  ${Object.entries(pitchR).sort((a,b)=>b[1].pa-a[1].pa).map(([t,r]) =>
                    `<tr><td>${t}</td><td>${r.pa}</td><td>${r.hits}</td><td>${avg(r.hits,r.pa)}</td><td>${pct(r.k,r.pa)}%</td></tr>`).join('')}
                </table></div>` : ''}

              ${Object.keys(countPA).length > 0 ? `<div class="bac">
                <div class="bac-title">球數傾向（打席結束時球數分布）</div>
                <table class="bac-table">
                  <tr><th>球數</th><th>打席次數</th><th>安打</th><th>打擊率</th></tr>
                  ${Object.entries(countPA).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([count,pa]) =>
                    `<tr><td>${count}</td><td>${pa}</td><td>${countHits[count]||0}</td><td>${avg(countHits[count]||0,pa)}</td></tr>`).join('')}
                </table></div>` : ''}

              <div class="bac">
                <div class="bac-title">壘上狀況應對</div>
                <div class="bac-row">
                  ${Object.entries(baseR).map(([s,r]) => `<div class="bac-stat"><div class="bac-v">${avg(r.hits,r.pa)}</div><div class="bac-l">${s}<br><small>${r.pa} 打席</small></div></div>`).join('')}
                </div></div>`;

        } else {
            // 獨立情蒐
            if (atBats.length === 0) { el.innerHTML = ''; return; }

            const dirTotal_s = atBats.filter(ab => ab.hitLocation).length;
            const dirC_s = { '左':0,'中':0,'右':0 };
            atBats.forEach(ab => { if (ab.hitLocation) { const d = DIR_MAP[ab.hitLocation.zone]; if (d) dirC_s[d]++; } });

            const typeC_s = { '安打':0,'飛球':0,'滾地':0,'平飛':0,'短打':0,'三振':0,'保送':0,'其他':0 };
            atBats.forEach(ab => {
                if (!ab.outcome) return;
                if (HIT_OUTCOMES.includes(ab.outcome)) typeC_s['安打']++;
                else if (['飛球出局','高飛犧牲打'].includes(ab.outcome)) typeC_s['飛球']++;
                else if (ab.outcome === '滾地球出局') typeC_s['滾地']++;
                else if (ab.outcome === '平飛球出局') typeC_s['平飛']++;
                else if (ab.outcome === '犧牲觸擊' || ab.isBunt) typeC_s['短打']++;
                else if (ab.outcome === '三振') typeC_s['三振']++;
                else if (ab.outcome === '保送') typeC_s['保送']++;
                else typeC_s['其他']++;
            });

            const baseR_s = { '空壘':{pa:0,hits:0},'有人在壘':{pa:0,hits:0} };
            atBats.forEach(ab => {
                const k = ab.runnersOn ? '有人在壘' : '空壘';
                baseR_s[k].pa++;
                if (HIT_OUTCOMES.includes(ab.outcome)) baseR_s[k].hits++;
            });

            const bunts = atBats.filter(ab => ab.isBunt).length;
            const runHit = atBats.filter(ab => ab.isRunAndHit).length;
            const pinch = atBats.filter(ab => ab.isPinch).length;

            el.innerHTML = `
              ${dirTotal_s > 0 ? `<div class="bac">
                <div class="bac-title">打擊方向傾向</div>
                <div class="bac-row">
                  ${['左','中','右'].map(d => `<div class="bac-stat"><div class="bac-v">${pct(dirC_s[d],dirTotal_s)}%</div><div class="bac-l">${d}（${dirC_s[d]}）</div></div>`).join('')}
                </div></div>` : ''}

              ${atBats.length > 0 ? `<div class="bac">
                <div class="bac-title">打擊類型分布</div>
                <div class="bac-row" style="flex-wrap:wrap;">
                  ${Object.entries(typeC_s).filter(([,v])=>v>0).map(([t,n]) => `<div class="bac-stat"><div class="bac-v">${pct(n,atBats.length)}%</div><div class="bac-l">${t}（${n}）</div></div>`).join('')}
                </div></div>` : ''}

              ${(bunts+runHit+pinch) > 0 ? `<div class="bac">
                <div class="bac-title">戰術時間點</div>
                <div class="bac-row">
                  <div class="bac-stat"><div class="bac-v">${bunts}</div><div class="bac-l">短打</div></div>
                  <div class="bac-stat"><div class="bac-v">${runHit}</div><div class="bac-l">跑打</div></div>
                  <div class="bac-stat"><div class="bac-v">${pinch}</div><div class="bac-l">代打</div></div>
                </div></div>` : ''}

              <div class="bac">
                <div class="bac-title">壘上狀況應對</div>
                <div class="bac-row">
                  ${Object.entries(baseR_s).map(([s,r]) => `<div class="bac-stat"><div class="bac-v">${avg(r.hits,r.pa)}</div><div class="bac-l">${s}<br><small>${r.pa} 打席</small></div></div>`).join('')}
                </div></div>`;
        }
    }

    function renderAtBatLog(atBats, batterIdx) {
        const el = document.getElementById('batterAtBatLogSection');
        if (!el) return;
        const HIT_OUTCOMES = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        el.innerHTML = `<div class="container">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h2 style="margin:0;border:none;padding:0;">📋 打席記錄</h2>
            <button class="btn btn-danger" onclick="openRecordAtBat(${batterIdx})">+ 新增打席</button>
          </div>
          ${atBats.length === 0 ? '<div style="text-align:center;padding:16px;color:#6b7280;">尚無打席記錄</div>' :
            atBats.map((ab, i) => {
              const isHit = HIT_OUTCOMES.includes(ab.outcome);
              const borderColor = isHit ? '#22c55e' : ab.outcome === '三振' ? '#ef4444' : '#94a3b8';
              return `<div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:8px;border-left:4px solid ${borderColor};">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                  <div style="font-weight:700;font-size:14px;">
                    ${ab.inning ? `第${ab.inning}局${ab.half||''}` : ''}
                    <span style="color:${isHit?'#16a34a':'#374151'};margin-left:6px;">${ab.outcome||''}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;">
                    ${ab.hitLocation ? `<span style="font-size:11px;background:#f3f4f6;padding:2px 6px;border-radius:4px;">${ab.hitLocation.zone}</span>` : ''}
                    <button onclick="deleteAtBat(${batterIdx},${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:2px 4px;" title="刪除">🗑</button>
                  </div>
                </div>
                <div style="font-size:12px;color:#6b7280;margin-top:3px;">
                  ${ab.runnersOn?'有人在壘':'空壘'}
                  ${ab.balls!==undefined?` · ${ab.balls}B ${ab.strikes}S`:''}
                  ${ab.isBunt?' · 短打':''}${ab.isRunAndHit?' · 跑打':''}${ab.isPinch?' · 代打':''}
                  ${ab.note?` · ${ab.note}`:''}
                </div>
              </div>`;
            }).join('')}
        </div>`;
    }

    // ── 新增打者 Modal ──

    function openAddBatterModal() {
        _newBatterHand = '右打';
        ['newBatterName','newBatterNumber','newBatterTeam','newBatterGame'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        const dateEl = document.getElementById('newBatterDate');
        if (dateEl) dateEl.value = new Date().toISOString().slice(0,10);
        document.querySelectorAll('.new-batter-hand-btn').forEach(b => b.classList.toggle('active', b.dataset.hand === '右打'));
        document.getElementById('addBatterModal').style.display = 'flex';
    }

    function closeAddBatterModal() {
        document.getElementById('addBatterModal').style.display = 'none';
    }

    function selectNewBatterHand(hand, btn) {
        _newBatterHand = hand;
        document.querySelectorAll('.new-batter-hand-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
    }

    function confirmAddBatter() {
        const name = (document.getElementById('newBatterName').value || '').trim();
        if (!name) { alert('請輸入打者姓名'); return; }
        initBatterData();
        allData.batterData.push({
            id: Date.now(), name,
            number: (document.getElementById('newBatterNumber').value||'').trim(),
            hand: _newBatterHand,
            team: (document.getElementById('newBatterTeam').value||'').trim(),
            gameName: (document.getElementById('newBatterGame').value||'').trim(),
            date: document.getElementById('newBatterDate').value || '',
            atBats: []
        });
        saveToLocalStorage();
        saveToFirebase();
        closeAddBatterModal();
        _batterSource = 'standalone';
        switchBatterSource('standalone');
        const idx = allData.batterData.length - 1;
        showBatterDetail(name, 'standalone', idx);
    }

    // ── 記錄打席 Modal ──

    function openRecordAtBat(batterIdx) {
        _editingAtBatBatterIdx = batterIdx;
        _atBatHitLocation = null;
        const fields = { atBatInning: gameState.inning||'1', atBatBalls:'0', atBatStrikes:'0' };
        Object.entries(fields).forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.value = v; });
        const halfEl = document.getElementById('atBatHalf');
        if (halfEl) halfEl.value = gameState.half || '上';
        ['atBatRunnersOn','atBatIsBunt','atBatIsRunAndHit','atBatIsPinch'].forEach(id => {
            const el = document.getElementById(id); if (el) el.checked = false;
        });
        const noteEl = document.getElementById('atBatNote'); if (noteEl) noteEl.value = '';
        const locLabel = document.getElementById('atBatHitLocLabel');
        if (locLabel) locLabel.textContent = '未選擇（點此選擇落點）';
        document.querySelectorAll('.atbat-outcome-btn').forEach(b => b.classList.remove('selected'));
        document.getElementById('atBatHitLocRow').style.display = 'none';
        document.getElementById('recordAtBatModal').style.display = 'flex';
    }

    function closeRecordAtBatModal() {
        document.getElementById('recordAtBatModal').style.display = 'none';
    }

    function selectAtBatOutcome(outcome, btn) {
        document.querySelectorAll('.atbat-outcome-btn').forEach(b => b.classList.remove('selected'));
        if (btn) btn.classList.add('selected');
        const ballInPlay = BALL_IN_PLAY_OUTCOMES.includes(outcome);
        document.getElementById('atBatHitLocRow').style.display = ballInPlay ? 'block' : 'none';
    }

    function openHitLocationForAtBat() {
        document.getElementById('recordAtBatModal').style.display = 'none';
        showHitLocationModal((loc) => {
            _atBatHitLocation = loc;
            const label = document.getElementById('atBatHitLocLabel');
            if (label) label.textContent = loc ? `落點：${loc.zone}` : '未選擇（點此選擇落點）';
            document.getElementById('recordAtBatModal').style.display = 'flex';
        });
    }

    function confirmRecordAtBat() {
        const outcomeEl = document.querySelectorAll('.atbat-outcome-btn.selected')[0];
        const outcome = outcomeEl ? outcomeEl.dataset.outcome : '';
        if (!outcome) { alert('請選擇打席結果'); return; }
        const atBat = {
            inning: parseInt(document.getElementById('atBatInning').value)||1,
            half: document.getElementById('atBatHalf').value,
            balls: parseInt(document.getElementById('atBatBalls').value)||0,
            strikes: parseInt(document.getElementById('atBatStrikes').value)||0,
            runnersOn: document.getElementById('atBatRunnersOn').checked,
            isBunt: document.getElementById('atBatIsBunt').checked,
            isRunAndHit: document.getElementById('atBatIsRunAndHit').checked,
            isPinch: document.getElementById('atBatIsPinch').checked,
            outcome, hitLocation: _atBatHitLocation,
            note: (document.getElementById('atBatNote').value||'').trim()||null,
            timestamp: new Date().toISOString()
        };
        allData.batterData[_editingAtBatBatterIdx].atBats.push(atBat);
        saveToLocalStorage();
        saveToFirebase();
        closeRecordAtBatModal();
        const batter = allData.batterData[_editingAtBatBatterIdx];
        renderBatterDetail(batter.name, 'standalone', _editingAtBatBatterIdx);
    }

    function deleteAtBat(batterIdx, atBatIdx) {
        if (!confirm('確定刪除此打席記錄？')) return;
        allData.batterData[batterIdx].atBats.splice(atBatIdx, 1);
        saveToLocalStorage();
        saveToFirebase();
        const batter = allData.batterData[batterIdx];
        renderBatterDetail(batter.name, 'standalone', batterIdx);
    }

    // ── 打者分析截圖 ──

    function screenshotBatterAnalysis() {
        const el = document.getElementById('batterDetailView');
        if (!el) { alert('截圖失敗：找不到分析頁面'); return; }
        html2canvas(el, { backgroundColor:'#f8f9fa', scale:2, useCORS:true, allowTaint:false })
            .then(canvas => {
                const link = document.createElement('a');
                const name = _currentBatterView ? _currentBatterView.name : '打者分析';
                link.download = `${name}_打者分析_${new Date().toISOString().slice(0,10)}.png`;
                link.href = canvas.toDataURL('image/png');
                link.click();
            }).catch(() => alert('截圖失敗，請稍後再試'));
    }

    // 保留舊名供相容性
    function showLegacyLogin() { showAdminLogin(); }

    // ── 打者情蒐模式進入/切換 ──

    let _bmAnalysisTeamFilter   = null; // null = 全部；string = 隊伍名
    let _bmAnalysisBatterFilter = null; // null = 整隊；string = 打者 key
    let _bmSortKey = 'threat'; // default sort: threat index
    let _bmSortDir = 'desc';   // 'asc' | 'desc'

    let _bmState = {
        recMode: 'linked',     // 'linked'|'standalone'
        currentOrder: 0,       // 0-based index (0=打序1)
        selectedOutcome: null,
        tactics: [],           // 多選戰術標籤：['打帶跑','戰術失敗']
        hitLoc: null,          // 聯動模式落點（內嵌球場圖選取）
        pitcherHand: '右投',
        half: '上',
        outs: 0,
        bases: [false,false,false],
        // standalone
        spHand: '右打',
        spPh: '右投',
        spType: null,
        spZone: null,
        spReact: null,
        spBalls: 0,
        spStrikes: 0,
        spPitches: [],
        spSelectedOutcome: null,  // 獨立模式打席結果
        spHitLoc: null,           // 獨立模式落點
        // 獨立模式比賽狀態
        spInning: 1,
        spHalf: '上',
        spOuts: 0,
        spBases: [false,false,false]
    };

    // ── 一鍵切換模式（情蒐員快速切換投手／打者）──
    function switchToMode(mode) {
        if (mode === userMode) return; // 已在此模式，不重複執行
        if (mode === 'batter') {
            userMode = 'batter';
            _showBatterModeUI();
            _initBmData();
            _renderBmLineup();
            _populateBmGameSelect();
            _renderBmSessionList();
            switchBatterTab(null, 'record');
        } else {
            userMode = 'pitcher';
            _hideBatterModeUI();
        }
        _updateModeToggleBtn();
    }

    function enterBatterMode() {
        userMode = 'batter';
        controlUserRolePermissions(userRole);
        const legacyRole = (userRole === 'viewer') ? 'view' : 'scout';
        enterSystem(legacyRole);
        setTimeout(() => {
            _showBatterModeUI();
            _initBmData();
            _renderBmLineup();
            _populateBmGameSelect();
            _renderBmSessionList();
            switchBatterTab(null, 'record');
            _updateModeToggleBtn();
        }, 300);
    }

    function enterPitcherMode() {
        userMode = 'pitcher';
        controlUserRolePermissions(userRole);
        const legacyRole = (userRole === 'viewer') ? 'view' : 'scout';
        enterSystem(legacyRole);
        setTimeout(() => { _hideBatterModeUI(); _updateModeToggleBtn(); }, 100);
    }

    // ── 更新側欄模式切換 pill 的視覺狀態 ──
    function _updateModeToggleBtn() {
        const pb = document.getElementById('modeTogglePitcher');
        const bb = document.getElementById('modeToggleBatter');
        if (!pb || !bb) return;
        const isBatter = (userMode === 'batter');
        // 活躍：金黃底深藍字；非活躍：半透明白
        pb.style.background = isBatter ? 'rgba(255,255,255,0.1)' : 'rgba(255,215,0,0.9)';
        pb.style.color      = isBatter ? 'rgba(255,255,255,0.6)' : '#003d79';
        bb.style.background = isBatter ? 'rgba(255,215,0,0.9)' : 'rgba(255,255,255,0.1)';
        bb.style.color      = isBatter ? '#003d79' : 'rgba(255,255,255,0.6)';
    }

    function _showBatterModeUI() {
        // 隱藏投手主內容專用元素
        ['dualPitcherSection','pitcherTabBar',
         'recordTab','statsTab','analysisTab','compareTab','pitcherDataMgmt']
            .forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
        // 隱藏投手側欄專用區塊（adminPanel, teamList, team-management）
        ['adminPanel','teamList']
            .forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
        const tmEl = document.querySelector('.team-management');
        if (tmEl) tmEl.style.display = 'none';
        // 顯示打者側欄
        const bmSide = document.getElementById('bmSidebarContent');
        if (bmSide) bmSide.style.display = 'flex';
        // 側欄 header 切換
        const hp = document.getElementById('sidebarHeaderPitcher');
        const hb = document.getElementById('sidebarHeaderBatter');
        if (hp) hp.style.display = 'none';
        if (hb) hb.style.display = '';
        // 顯示打者主內容（現在同在 mainContent 內）
        const bw = document.getElementById('batterModeWrapper');
        if (bw) bw.style.display = '';
        // 標題副標題
        const sub = document.getElementById('headerTeamSub');
        if (sub) {
            const vSpan = sub.querySelector('#appVersionMain');
            sub.innerHTML = '打者情蒐系統 · BATTER SCOUTING ';
            if (vSpan) sub.appendChild(vSpan);
        }
    }

    function _hideBatterModeUI() {
        // 恢復投手主內容元素
        ['dualPitcherSection','pitcherTabBar',
         'recordTab','statsTab','analysisTab','compareTab','pitcherDataMgmt']
            .forEach(id => { const el=document.getElementById(id); if(el) el.style.display=''; });
        // 隱藏打者側欄 / 主內容
        const bmSide = document.getElementById('bmSidebarContent');
        if (bmSide) bmSide.style.display = 'none';
        const bw = document.getElementById('batterModeWrapper');
        if (bw) bw.style.display = 'none';
        // 恢復 header
        const hp = document.getElementById('sidebarHeaderPitcher');
        const hb = document.getElementById('sidebarHeaderBatter');
        if (hp) hp.style.display = '';
        if (hb) hb.style.display = 'none';
        // 恢復標題
        const sub = document.getElementById('headerTeamSub');
        if (sub) {
            const vSpan = sub.querySelector('#appVersionMain');
            sub.innerHTML = '投手情蒐系統 · PITCHER SCOUTING ';
            if (vSpan) sub.appendChild(vSpan);
        }
        // ★ 重新強制執行帳號安全 UI（防止打者模式返回時洩漏受限功能）
        _reEnforceUIPermissions();
        switchTab(null, 'record');
    }

    // ★ 統一安全 UI 強制執行：任何模式切換、登入後都呼叫此函式確保正確權限
    function _reEnforceUIPermissions() {
        const isAdmin  = (typeof currentTeamCode !== 'undefined' && currentTeamCode === 'ADMIN');
        const isViewer = (userRole === 'view' || userRole === 'viewer');
        const isBatter = (userMode === 'batter');

        // 管理員專用元素：嚴格只對 ADMIN 顯示（打者模式下也隱藏，避免干擾側欄）
        ['adminPanel','createTeamBtn','adminInjectWrap'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = (isAdmin && !isBatter) ? 'block' : 'none';
        });

        // teamList、team-management：投手模式才顯示（打者模式用 bmSidebarContent）
        const teamListEl = document.getElementById('teamList');
        if (teamListEl) teamListEl.style.display = (!isBatter && !isViewer) ? '' : 'none';
        const tmEl = document.querySelector('.team-management');
        if (tmEl) tmEl.style.display = (!isBatter && !isViewer) ? '' : 'none';

        // 底部工具列：scout vs viewer（兩種模式共用）
        const sb = document.getElementById('scoutBottomBar');
        const vb = document.getElementById('viewerBottomBar');
        if (isViewer) {
            if (sb) sb.style.display = 'none';
            if (vb) vb.style.display = 'block';
        } else {
            if (sb) sb.style.display = '';
            if (vb) vb.style.display = 'none';
        }

        // 更新模式切換 pill 視覺
        _updateModeToggleBtn();

        // 觀看者：重新套用所有唯讀限制
        if (isViewer) {
            setTimeout(() => { if (typeof applyViewOnlyMode === 'function') applyViewOnlyMode(); }, 80);
        }
    }

    // ── 打者模式 Tab 切換 ──
    function switchBatterTab(e, tab) {
        ['bmRecordTab','bmStatsTab','bmBatterDataTab']
            .forEach(id => { const el=document.getElementById(id); if(el) { el.style.display='none'; el.classList.remove('active'); } });
        document.querySelectorAll('.bm-tab').forEach(b => b.classList.remove('bm-tab-active'));
        const tabMap = { record:'bmRecordTab', stats:'bmStatsTab', batterdata:'bmBatterDataTab' };
        const target = document.getElementById(tabMap[tab]);
        if (target) { target.style.display=''; target.classList.add('active'); }
        if (e && e.target) e.target.classList.add('bm-tab-active');
        else {
            document.querySelectorAll('.bm-tab').forEach(b => {
                if ((b.getAttribute('onclick')||'').includes(`'${tab}'`)) b.classList.add('bm-tab-active');
            });
        }
        _bmState.tab = tab;
        if (tab==='stats')      _renderBmStats();
        if (tab==='record') {
            _renderBmOutcomeButtons();
            _renderBmBatterDisplay();
            if (_bmState.recMode === 'standalone') _renderSpOutcomeButtons();
        }
        if (tab==='batterdata') { refreshBatterList(); }
    }

    // ── 從投手記錄推導打者打席（連動模式統計用）──
    function _deriveBmAtBatsFromPitches(teamIdx) {
        const team = allData.teams[teamIdx];
        if (!team) return [];
        const PA_ENDING = [
            '三振','不死三振','滾地球出局','飛球出局','平飛球出局',
            '內野安打','一壘安打','二壘安打','三壘安打','全壘打',
            '保送','觸身球','故意四壞','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤','捕逸'
        ];
        // 上半局打者 = team.name（先攻），下半局打者 = team.opponent（後攻）
        // 若 pitch 沒有 half，嘗試透過打線資料推斷
        const lineupA = team.lineups?.teamA || [];
        const lineupB = team.lineups?.teamB || [];
        const inLineup = (arr, num) => {
            const n = String(num || '');
            return n && (Array.isArray(arr) ? arr : Object.values(arr)).some(p => String(p?.number || '') === n);
        };
        const atBats = [];
        team.pitchers.forEach(pitcher => {
            (pitcher.pitches || []).forEach(pitch => {
                const paOutcome = (pitch.outcomes || []).find(o => PA_ENDING.includes(o));
                if (!paOutcome) return;
                // 判斷打者所屬球隊
                let teamName = '';
                if (pitch.half === '上') {
                    teamName = team.name || '先攻';
                } else if (pitch.half === '下') {
                    teamName = team.opponent || '後攻';
                } else {
                    // 舊資料無 half：透過打線推斷
                    const num = String(pitch.batterNumber || '');
                    if (inLineup(lineupA, num)) teamName = team.name || '先攻';
                    else if (inLineup(lineupB, num)) teamName = team.opponent || '後攻';
                }
                atBats.push({
                    number:      pitch.batterNumber || '',
                    name:        pitch.batterName   || '',
                    hand:        pitch.batterHand   || '右打',
                    outcome:     paOutcome,
                    pitcherHand: pitcher.hand       || '右投',
                    hitLocation: pitch.hitLocation  || null,
                    teamName,
                    // 從投手記錄抽取戰術標籤（打帶跑、戰術失敗等）
                    tactics: (pitch.outcomes || []).filter(o =>
                        ['打帶跑','戰術失敗','首球','跑打','偷點'].includes(o)),
                    balls:   pitch.balls   || 0,
                    strikes: pitch.strikes || 0,
                    inning:  pitch.inning  || null,
                    half:    pitch.half    || null,
                    basesSnapshot: pitch.basesSnapshot || [false,false,false]
                });
            });
        });
        return atBats;
    }

    // ── 初始化 bm 資料 ──
    function _initBmData() {
        if (!allData.bm) allData.bm = {};
        // 舊版 lineup 遷移到 lineupA（向下相容）
        if (allData.bm.lineup && !allData.bm.lineupA) {
            allData.bm.lineupA = allData.bm.lineup.map(b => ({...b, trait: b.trait||''}));
            delete allData.bm.lineup;
        }
        if (!allData.bm.lineupA) allData.bm.lineupA = Array.from({length:9}, () => ({number:'',name:'',hand:'右打',trait:''}));
        if (!allData.bm.lineupB) allData.bm.lineupB = Array.from({length:9}, () => ({number:'',name:'',hand:'右打',trait:''}));
        // 補 trait 欄位（舊資料相容）
        allData.bm.lineupA.forEach(b => { if (!('trait' in b)) b.trait = ''; });
        allData.bm.lineupB.forEach(b => { if (!('trait' in b)) b.trait = ''; });
        if (!allData.bm.atBats) allData.bm.atBats = [];
        if (!allData.bm.steals) allData.bm.steals = []; // 獨立盜壘記錄（不依附投手記錄）
        if (!('gameIdx' in allData.bm)) allData.bm.gameIdx = -1;
        if (!allData.bm.attackingTeam) allData.bm.attackingTeam = 'B';
        // 獨立模式賽事資訊欄位
        if (!('spGameName' in allData.bm)) allData.bm.spGameName = '';
        if (!('spTeamName' in allData.bm)) allData.bm.spTeamName = '';
        if (!('spOpponent'  in allData.bm)) allData.bm.spOpponent  = '';
        if (!('spDate'      in allData.bm)) allData.bm.spDate      = '';
        if (!allData.bm.vsPhA) allData.bm.vsPhA = { name:'', number:'', hand:'右投' };
        if (!allData.bm.vsPhB) allData.bm.vsPhB = { name:'', number:'', hand:'右投' };
    }

    // ── 打線管理 ──
    function _getLineup(team) {
        return team === 'A' ? allData.bm.lineupA : allData.bm.lineupB;
    }

    function _renderBmLineup() {
        _initBmData();
        _renderBmLineupTeam('A');
        _renderBmLineupTeam('B');
        _updateBmLineupTitles();
    }

    function _renderBmLineupTeam(team) {
        _initBmData();
        const container = document.getElementById('bmLineupRows' + team);
        if (!container) return;
        const lineup = _getLineup(team);
        container.innerHTML = lineup.map((b,i) => `
            <div class="bm-lineup-row">
                <span class="bm-lineup-order">${i+1}</span>
                <input type="text" inputmode="numeric" class="bm-lineup-num" placeholder="#"
                    value="${b.number||''}"
                    onblur="saveBmLineupCell('${team}',${i},'number',this.value)"
                    onkeydown="if(event.key==='Enter')this.blur()">
                <button class="bm-lineup-hand${b.hand==='右打'?' bm-on':''}" onclick="toggleBmLineupHand('${team}',${i},this)">
                    ${b.hand==='右打'?'右打':'左打'}
                </button>
                <input type="text" class="bm-lineup-name" placeholder="姓名（選填）"
                    value="${b.name||''}" autocomplete="off"
                    onblur="saveBmLineupCell('${team}',${i},'name',this.value)"
                    onkeydown="if(event.key==='Enter')this.blur()">
            </div>`).join('');
    }

    function _updateBmLineupTitles() {
        const { nameA, nameB } = _getBmTeamNames();
        const ta = document.getElementById('bmLineupTitleA');
        const tb = document.getElementById('bmLineupTitleB');
        if (ta) ta.textContent = (nameA || 'A隊') + ' 打線';
        if (tb) tb.textContent = (nameB || 'B隊') + ' 打線';
    }

    function toggleBmLineupPanel(team) {
        const body = document.getElementById('bmLineupBody' + team);
        const arrow = document.getElementById('bmLineupCollapse' + team);
        if (!body) return;
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : '';
        if (arrow) arrow.textContent = isOpen ? '▼' : '▲';
        if (!isOpen) _renderBmLineupTeam(team); // render on open
    }

    // ★ 將 bm 打線同步儲存到對應賽事資料中
    // 對應關係：teamA = team.name（先攻）、teamB = team.opponent（後攻）
    //           打者模式 lineupA 標示為 team.name → 存入 lineups.teamA
    //           打者模式 lineupB 標示為 team.opponent → 存入 lineups.teamB
    function _saveBmLineupToGame() {
        const gi = allData.bm.gameIdx;
        if (gi < 0 || !allData.teams[gi]) return;
        if (!allData.teams[gi].lineups) allData.teams[gi].lineups = {};
        allData.teams[gi].lineups.teamA = allData.bm.lineupA.map(p => ({...p})); // team.name 先攻
        allData.teams[gi].lineups.teamB = allData.bm.lineupB.map(p => ({...p})); // team.opponent 後攻
        saveToFirebase(gi);
    }

    // ★ 切換賽事時從賽事資料還原打線
    function _loadBmLineupFromGame(gi) {
        const saved = allData.teams[gi]?.lineups;
        if (!saved) return;
        const _restore = (key) => {
            const arr = saved[key];
            if (!arr) return;
            const list = Array.isArray(arr) ? arr : Object.values(arr);
            return list.map(p => ({number: p?.number||'', name: p?.name||'', hand: p?.hand||'右打', trait: p?.trait||''}));
        };
        const lA = _restore('teamA'); if (lA) allData.bm.lineupA = lA; // teamA = team.name → lineupA
        const lB = _restore('teamB'); if (lB) allData.bm.lineupB = lB; // teamB = team.opponent → lineupB
        _renderBmLineup();
    }

    function saveBmLineupManual(team, btn) {
        _initBmData();
        _saveBmLineupToGame();
        saveToLocalStorage();
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = orig; }, 800);
        }
    }

    function saveBmLineupCell(team, idx, field, val) {
        _initBmData();
        _getLineup(team)[idx][field] = val;
        _saveBmLineupToGame();
        saveToLocalStorage();
        if (_bmState.recMode === 'linked') _syncBmLineupToGameState();
    }

    function toggleBmLineupHand(team, idx, btn) {
        _initBmData();
        const lineup = _getLineup(team);
        const current = lineup[idx].hand;
        const next = current === '右打' ? '左打' : '右打';
        lineup[idx].hand = next;
        btn.textContent = next;
        btn.classList.toggle('bm-on', next === '右打');
        _saveBmLineupToGame();
        saveToLocalStorage();
        if (_bmState.recMode === 'linked') _syncBmLineupToGameState();
    }

    // ★ 聯動打線同步：打線模組 → gameState（雙隊）
    function _syncBmLineupToGameState() {
        _initBmData();
        ['A','B'].forEach(team => {
            const gsKey = team === 'B' ? 'teamB' : 'teamA';
            _getLineup(team).forEach((p, i) => {
                if (!gameState.lineups[gsKey][i + 1]) gameState.lineups[gsKey][i + 1] = {};
                gameState.lineups[gsKey][i + 1].number = p.number || '';
                gameState.lineups[gsKey][i + 1].name   = p.name   || '';
                gameState.lineups[gsKey][i + 1].hand   = p.hand   || '右打';
            });
        });
    }

    // ★ 聯動打線同步：gameState → 打線模組（有資料才蓋入）
    function _syncGameStateToBmLineup(attackingTeam) {
        _initBmData();
        let synced = false;
        ['A','B'].forEach(team => {
            const gsKey = team === 'B' ? 'teamB' : 'teamA';
            const gsLineup = gameState.lineups[gsKey];
            let hasData = false;
            for (let i = 1; i <= 9; i++) {
                if (gsLineup[i] && gsLineup[i].number) { hasData = true; break; }
            }
            if (!hasData) return;
            for (let i = 1; i <= 9; i++) {
                const p = gsLineup[i] || {};
                _getLineup(team)[i - 1] = {
                    number: p.number || '',
                    name:   p.name   || '',
                    hand:   p.hand   || '右打',
                    trait:  _getLineup(team)[i-1]?.trait || ''
                };
            }
            synced = true;
        });
        if (synced) { _renderBmLineup(); saveToLocalStorage(); }
        return synced;
    }

    // ── 跨模式狀態同步（投手模式 ↔ 打者連動模式） ──
    let _crossModeSyncing = false;

    // 投手模式 → 打者連動模式（出局、局半、局數、壘上、當前打者棒次）
    function _syncPitcherToBmLinked() {
        if (_crossModeSyncing || _bmState.recMode !== 'linked') return;
        _crossModeSyncing = true;
        try {
            setBmOuts(gameState.outs);
            _bmState.half = gameState.half;
            const topBtn = document.getElementById('bmHalfTopBtn');
            const botBtn = document.getElementById('bmHalfBotBtn');
            if (topBtn) topBtn.classList.toggle('bm-on', gameState.half === '上');
            if (botBtn) botBtn.classList.toggle('bm-on', gameState.half === '下');
            const inningEl = document.getElementById('bmInning');
            if (inningEl && gameState.inning) inningEl.value = gameState.inning;
            _bmState.bases = [...gameState.bases];
            const baseLabels = ['一壘','二壘','三壘'];
            ['bmBase1','bmBase2','bmBase3'].forEach((id, i) => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.classList.toggle('bm-on', _bmState.bases[i]);
                    btn.textContent = (_bmState.bases[i] ? '●' : '') + baseLabels[i];
                }
            });
            // 上半局 B 隊攻、下半局 A 隊攻
            const newAttacker = gameState.half === '上' ? 'B' : 'A';
            if (allData.bm && allData.bm.attackingTeam !== newAttacker) {
                allData.bm.attackingTeam = newAttacker;
                const ta = document.getElementById('bmTeamABtn');
                const tb = document.getElementById('bmTeamBBtn');
                if (ta) ta.classList.toggle('bm-on', newAttacker === 'A');
                if (tb) tb.classList.toggle('bm-on', newAttacker === 'B');
            }
            const battingTeam = gameState.half === '上' ? 'teamA' : 'teamB';
            const newOrder = gameState.currentBatterIndex[battingTeam];
            if (_bmState.currentOrder !== newOrder) {
                _bmState.currentOrder = newOrder;
                _renderBmBatterDisplay();
            }
        } finally {
            _crossModeSyncing = false;
        }
    }

    // 打者連動模式 → 投手模式（出局、局半、局數、壘上、當前打者棒次）
    function _syncBmLinkedToPitcher() {
        if (_crossModeSyncing || _bmState.recMode !== 'linked') return;
        _crossModeSyncing = true;
        try {
            gameState.outs = _bmState.outs;
            gameState.half = _bmState.half;
            gameState.bases = [..._bmState.bases];
            const inningEl = document.getElementById('bmInning');
            if (inningEl) {
                const bmInning = parseInt(inningEl.value) || 1;
                gameState.inning = bmInning;
                if (currentTeam !== null) {
                    const score = getTeamScore();
                    score.half = _bmState.half;
                    score.inning = bmInning;
                }
            }
            renderCountLights();
            renderBases();
            if (currentTeam !== null) updateScoreboard();
            const bmAttackingTeam = (allData.bm && allData.bm.attackingTeam) || 'B';
            const gsKey = bmAttackingTeam === 'A' ? 'teamA' : 'teamB';
            gameState.currentBatterIndex[gsKey] = _bmState.currentOrder;
            const orderEl = document.getElementById('batterOrder');
            if (orderEl) orderEl.value = _bmState.currentOrder + 1;
            autoFillBatterFromOrder(_bmState.currentOrder + 1);
        } finally {
            _crossModeSyncing = false;
        }
    }

    function copyBmLineup(team) {
        _initBmData();
        const ab = (allData.bm && allData.bm.atBats) ? [...allData.bm.atBats] : [];
        // 過濾該隊打席（有 team 欄位用 team，無則用 attackingTeam 預設）
        const teamAbs = ab.filter(a => (a.team || allData.bm.attackingTeam) === team);
        if (teamAbs.length === 0) { alert('該隊尚無打席記錄可複製'); return; }
        const lineupMap = {};
        teamAbs.forEach(a => { if (a.order && !lineupMap[a.order]) lineupMap[a.order] = a; });
        for (let i=1;i<=9;i++) {
            if (lineupMap[i]) {
                _getLineup(team)[i-1] = { number: String(lineupMap[i].number||''), name: lineupMap[i].name||'', hand: lineupMap[i].hand||'右打', trait: lineupMap[i].trait||'' };
            }
        }
        _renderBmLineupTeam(team);
        saveToLocalStorage();
    }

    function clearBmLineup(team) {
        if (!confirm(`確定清空${team}隊打線？`)) return;
        _initBmData();
        if (team === 'A') allData.bm.lineupA = Array.from({length:9}, () => ({number:'',name:'',hand:'右打',trait:''}));
        else              allData.bm.lineupB = Array.from({length:9}, () => ({number:'',name:'',hand:'右打',trait:''}));
        _renderBmLineupTeam(team);
        saveToLocalStorage();
        saveToFirebase();
    }

    // 全清打者資料（打線 + 所有打席記錄）
    function resetAllBmData() {
        if (!confirm('確定清除全部打者資料？（打線 + 所有打席記錄 + 分析數據）\n此操作無法還原！')) return;
        allData.bm = {
            lineupA: Array.from({length:9}, () => ({number:'',name:'',hand:'右打',trait:''})),
            lineupB: Array.from({length:9}, () => ({number:'',name:'',hand:'右打',trait:''})),
            gameIdx: -1,
            attackingTeam: 'B',
            atBats: [],
            spGameName: '', spTeamName: '', spOpponent: '', spDate: ''
        };
        _renderBmLineup();
        _renderBmSpInfo();
        saveToLocalStorage();
        saveToFirebase();
        alert('✅ 打者資料已全部清除');
    }

    // 清除全部投手賽事（含投球記錄與打者名稱），管理員用
    function resetAllTeamsData() {
        if (!confirm('確定清除全部投手賽事資料？\n所有球隊、投球記錄、打者名稱都將永久刪除！\n此操作無法還原！')) return;
        allData.teams = [];
        allData.pitcherDB = {};
        allData.bm = {
            lineup: Array.from({length:9}, () => ({number:'',name:'',hand:'右打'})),
            gameIdx: -1,
            attackingTeam: 'B',
            atBats: [],
            spGameName: '', spTeamName: '', spOpponent: '', spDate: ''
        };
        updateTeamList();
        updateSlotDisplay();
        _renderBmLineup();
        _populateBmGameSelect();
        saveToLocalStorage();
        saveToFirebase();
        alert('✅ 全部資料已清除，系統已重置');
    }

    // ── 比賽連動選擇 ──
    function _populateBmGameSelect() {
        const sel = document.getElementById('bmGameSelect');
        if (!sel) return;
        sel.innerHTML = '<option value="-1" style="background:#003d79;color:white;">— 不連動，純獨立記錄 —</option>';
        (allData.teams||[]).forEach((t,i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.style.background = '#003d79';
            opt.style.color = 'white';
            opt.textContent = `${t.gameName||''}  ${t.name||''}  vs  ${t.opponent||''}  ${t.date||''}`;
            sel.appendChild(opt);
        });
        _initBmData();
        sel.value = allData.bm.gameIdx;
        const ta = document.getElementById('bmTeamABtn');
        const tb = document.getElementById('bmTeamBBtn');
        if (ta && tb) {
            ta.classList.toggle('bm-on', allData.bm.attackingTeam === 'A');
            tb.classList.toggle('bm-on', allData.bm.attackingTeam === 'B');
        }
        _updateBmTeamBtns(); // 進入打者模式時帶入球隊名稱
    }

    // ── 場次管理側欄：渲染場次列表 ──
    function _renderBmSessionList() {
        const container = document.getElementById('bmSessionList');
        if (!container) return;
        _initBmData();
        const teams = allData.teams || [];
        if (teams.length === 0) {
            container.innerHTML = '<p style="color:rgba(255,255,255,0.7);text-align:center;padding:16px;font-size:13px;">尚無場次資料<br><span style="font-size:11px;opacity:0.6;">請至投手模式新增</span></p>';
            return;
        }

        // 以 gameName 分組（首次自動展開所有群組）
        const groups = {};
        teams.forEach((t, i) => {
            const key = t.gameName || '未分類';
            if (!groups[key]) groups[key] = [];
            groups[key].push({team:t, idx:i});
            if (!bmExpandedGames.has('__init_done__')) bmExpandedGames.add(key);
        });
        bmExpandedGames.add('__init_done__');

        container.innerHTML = '';
        const curIdx = allData.bm.gameIdx;

        Object.entries(groups).forEach(([gameName, items]) => {
            const isExpanded = bmExpandedGames.has(gameName);
            const hasActive  = items.some(({idx}) => idx === curIdx);

            const groupDiv = document.createElement('div');
            groupDiv.style.marginBottom = '6px';

            // ── 賽事標題列（可點擊收合）──
            const gameHeader = document.createElement('div');
            gameHeader.style.cssText = `
                display:flex;align-items:center;gap:6px;cursor:pointer;
                padding:7px 8px;border-radius:6px;
                background:${isExpanded ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.08)'};
                border:1px solid ${isExpanded ? 'rgba(255,215,0,0.5)' : 'rgba(255,255,255,0.1)'};
                -webkit-user-select:none;user-select:none;
            `;
            gameHeader.innerHTML = `
                <span style="font-size:11px;color:var(--ct-gold);transition:transform 0.2s;display:inline-block;transform:${isExpanded?'rotate(90deg)':'rotate(0)'}">▶</span>
                ${hasActive ? '<span class="live-badge">LIVE</span>' : ''}
                <span style="font-size:13px;font-weight:700;color:white;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🏟️ ${gameName}</span>
                <span style="font-size:10px;color:rgba(255,255,255,0.5);">${items.length}場</span>
            `;
            gameHeader.onclick = () => {
                if (bmExpandedGames.has(gameName)) bmExpandedGames.delete(gameName);
                else bmExpandedGames.add(gameName);
                _renderBmSessionList();
            };
            groupDiv.appendChild(gameHeader);

            // ── 展開時顯示場次列表 ──
            if (isExpanded) {
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'margin-left:8px;margin-top:4px;';

                items.forEach(({team:t, idx:i}) => {
                    const isActive = i === curIdx;

                    const itemDiv = document.createElement('div');
                    itemDiv.style.cssText = `
                        display:flex;align-items:center;gap:6px;
                        padding:7px 10px;margin-bottom:3px;border-radius:6px;cursor:pointer;
                        background:${isActive ? 'rgba(255,215,0,0.12)' : 'rgba(255,255,255,0.05)'};
                        border:1px solid ${isActive ? 'rgba(255,215,0,0.45)' : 'rgba(255,255,255,0.08)'};
                        touch-action:manipulation;
                    `;

                    const arrow = document.createElement('span');
                    arrow.style.cssText = `font-size:10px;color:${isActive?'var(--ct-gold)':'rgba(255,255,255,0.4)'};flex-shrink:0;transition:color 0.2s;`;
                    arrow.textContent = isActive ? '✓' : '▶';

                    const info = document.createElement('div');
                    info.style.cssText = 'flex:1;min-width:0;';
                    info.innerHTML = `
                        <div style="font-size:12px;font-weight:700;color:${isActive?'#ffd700':'white'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${t.name||'?'} vs ${t.opponent||'?'}
                        </div>
                        <div style="font-size:10px;color:rgba(255,255,255,0.45);margin-top:1px;">${t.date||'--'}</div>
                    `;

                    itemDiv.appendChild(arrow);
                    itemDiv.appendChild(info);
                    itemDiv.onclick = () => {
                        _initBmData();
                        allData.bm.gameIdx = i;
                        saveToLocalStorage();
                        const sel = document.getElementById('bmGameSelect');
                        if (sel) sel.value = i;
                        switchBmRecordMode('linked');
                        // 優先從賽事資料還原打線，沒有再從 gameState 同步
                        _loadBmLineupFromGame(i);
                        _syncGameStateToBmLineup(allData.bm.attackingTeam || 'B');
                        _updateBmTeamBtns();
                        _renderBmSessionList();
                        _renderBmLineup();
                        _renderBmBatterDisplay();
                    };
                    wrapper.appendChild(itemDiv);
                });

                groupDiv.appendChild(wrapper);
            }
            container.appendChild(groupDiv);
        });

        // ── 取消連動按鈕 ──
        const unlinkBtn = document.createElement('button');
        unlinkBtn.style.cssText = `width:100%;padding:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);font-size:11px;cursor:pointer;font-family:inherit;touch-action:manipulation;margin-top:6px;`;
        unlinkBtn.textContent = '— 切換至獨立模式 —';
        unlinkBtn.onclick = () => {
            _initBmData(); allData.bm.gameIdx = -1; saveToLocalStorage();
            const sel = document.getElementById('bmGameSelect'); if (sel) sel.value = -1;
            switchBmRecordMode('standalone');
            _renderBmSessionList();
        };
        container.appendChild(unlinkBtn);
    }

    function onBmGameChange() {
        const sel = document.getElementById('bmGameSelect');
        _initBmData();
        const idx = parseInt(sel.value);
        allData.bm.gameIdx = isNaN(idx) ? -1 : idx;
        saveToLocalStorage();
        // ★ 自動連動：選了賽事→聯動模式；選不連動→獨立模式
        switchBmRecordMode(allData.bm.gameIdx >= 0 ? 'linked' : 'standalone');
        // ★ 聯動模式：自動帶入對應隊的打線（優先從 gameState 帶入）
        if (allData.bm.gameIdx >= 0) {
            _syncGameStateToBmLineup(allData.bm.attackingTeam || 'B');
        }
        _updateBmTeamBtns();
    }

    function selectBmTeam(t) {
        _initBmData();
        allData.bm.attackingTeam = t;
        const ta = document.getElementById('bmTeamABtn');
        const tb = document.getElementById('bmTeamBBtn');
        if (ta) ta.classList.toggle('bm-on', t==='A');
        if (tb) tb.classList.toggle('bm-on', t==='B');
        saveToLocalStorage();
        // ★ 聯動模式：切換進攻隊時自動帶入對應打線，打者從第一棒開始
        if (_bmState.recMode === 'linked') {
            _syncGameStateToBmLineup(t);
            _bmState.currentOrder = 0;
        }
        _renderBmBatterDisplay();
        resetBmLinkedForm();
    }

    // ── 記錄模式切換 ──
    function switchBmRecordMode(mode) {
        _bmState.recMode = mode;
        const lb = document.getElementById('bmModeLinkedBtn');
        const sb = document.getElementById('bmModeStandaloneBtn');
        if (lb) {
            lb.classList.toggle('bm-on', mode==='linked');
            lb.style.background  = mode==='linked' ? '#0051a5' : 'white';
            lb.style.color       = mode==='linked' ? 'white'   : '#9ca3af';
            lb.style.borderColor = mode==='linked' ? '#0051a5' : '#d1d5db';
        }
        if (sb) {
            sb.classList.toggle('bm-on', mode==='standalone');
            sb.style.background  = mode==='standalone' ? '#0051a5' : 'white';
            sb.style.color       = mode==='standalone' ? 'white'   : '#9ca3af';
            sb.style.borderColor = mode==='standalone' ? '#0051a5' : '#d1d5db';
        }
        const lr = document.getElementById('bmLinkedRecord');
        const sr = document.getElementById('bmStandaloneRecord');
        if (lr) lr.style.display = mode==='linked' ? '' : 'none';
        if (sr) sr.style.display = mode==='standalone' ? '' : 'none';
        // 雙槽位卡（聯動）vs 單槽位（獨立）
        const cs   = document.getElementById('bmCurrentSection');
        const spcs = document.getElementById('bmSpCurrentSection');
        if (cs)   cs.style.display   = mode==='linked'     ? '' : 'none';
        if (spcs) spcs.style.display = mode==='standalone' ? '' : 'none';
        // 獨立模式初始化結果按鈕與球場圖
        if (mode==='standalone') { _renderSpOutcomeButtons(); }

        // ★ 側欄：聯動顯示比賽下拉，獨立顯示賽事資訊表單
        const linkedSec = document.getElementById('bmLinkedGameSection');
        const standalSec = document.getElementById('bmStandaloneGameSection');
        if (linkedSec)  linkedSec.style.display  = mode === 'linked'     ? '' : 'none';
        if (standalSec) standalSec.style.display  = mode === 'standalone' ? '' : 'none';
        // 獨立模式：還原已儲存的賽事資訊
        if (mode === 'standalone') _renderBmSpInfo();
        _updateBmTeamBtns();

        // ★ 反向連動：切換模式按鈕時同步更新側欄下拉選單
        const sel = document.getElementById('bmGameSelect');
        if (sel) {
            if (mode === 'standalone') {
                sel.value = '-1';
                _initBmData();
                allData.bm.gameIdx = -1;
                saveToLocalStorage();
            } else if (mode === 'linked') {
                // 切聯動→若側欄還在「不連動」且有可選賽事，自動選第一場
                if (parseInt(sel.value) < 0 && sel.options.length > 1) {
                    sel.selectedIndex = 1;
                    _initBmData();
                    allData.bm.gameIdx = parseInt(sel.options[1].value);
                    saveToLocalStorage();
                }
            }
        }
    }

    // ★ 更新 A隊/B隊進攻 按鈕顯示實際球隊名稱
    function _updateBmTeamBtns() {
        const ta = document.getElementById('bmTeamABtn');
        const tb = document.getElementById('bmTeamBBtn');
        if (!ta || !tb) return;

        let nameA = 'A隊'; // 後攻
        let nameB = 'B隊'; // 先攻

        if (_bmState.recMode === 'linked') {
            _initBmData();
            const gi = allData.bm.gameIdx;
            if (gi >= 0 && allData.teams && allData.teams[gi]) {
                const t = allData.teams[gi];
                nameB = t.name     || 'B隊';  // name = 先攻
                nameA = t.opponent || 'A隊';  // opponent = 後攻
            }
        } else {
            // 獨立模式：用賽事資訊欄位
            _initBmData();
            if (allData.bm.spTeamName) nameB = allData.bm.spTeamName;
            if (allData.bm.spOpponent)  nameA = allData.bm.spOpponent;
        }

        ta.textContent = nameA + ' 進攻';
        tb.textContent = nameB + ' 進攻';
    }

    // ── 獨立模式賽事資訊 ──
    function saveBmSpInfo() {
        _initBmData();
        allData.bm.spGameName = (document.getElementById('bmSpGameName')?.value || '').trim();
        allData.bm.spTeamName = (document.getElementById('bmSpTeamName')?.value || '').trim();
        allData.bm.spOpponent = (document.getElementById('bmSpOpponent')?.value || '').trim();
        allData.bm.spDate     = (document.getElementById('bmSpDate')?.value     || '').trim();
        saveToLocalStorage();
        saveToFirebase();
        _updateBmTeamBtns(); // 即時更新進攻按鈕顯示
    }

    function _renderBmSpInfo() {
        _initBmData();
        const gn = document.getElementById('bmSpGameName');
        const tn = document.getElementById('bmSpTeamName');
        const op = document.getElementById('bmSpOpponent');
        const dt = document.getElementById('bmSpDate');
        if (gn) gn.value = allData.bm.spGameName || '';
        if (tn) tn.value = allData.bm.spTeamName || '';
        if (op) op.value = allData.bm.spOpponent  || '';
        if (dt) dt.value = allData.bm.spDate       || '';
    }

    // ── 聯動模式：打席記錄 ──
    const BM_OUTCOMES = [
        { label:'三振',    cls:'bm-out' },
        { label:'不死三振', cls:'bm-out' },
        { label:'保送',    cls:'bm-bb' },
        { label:'觸身球',  cls:'bm-bb' },
        { label:'故意四壞', cls:'bm-bb' },
        { label:'內野安打', cls:'bm-hit' },
        { label:'一壘安打', cls:'bm-hit' },
        { label:'二壘安打', cls:'bm-hit' },
        { label:'三壘安打', cls:'bm-hit' },
        { label:'全壘打',  cls:'bm-hit' },
        { label:'滾地球出局', cls:'bm-out' },
        { label:'飛球出局',   cls:'bm-out' },
        { label:'平飛球出局', cls:'bm-out' },
        { label:'犧牲觸擊',  cls:'bm-out' },
        { label:'高飛犧牲打', cls:'bm-out' },
        { label:'雙殺',   cls:'bm-out' },
        { label:'野選',   cls:'' },
        { label:'失誤',   cls:'' },
    ];
    const BM_BALL_IN_PLAY = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打','滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤'];

    const BM_OUTCOME_GROUPS = [
        { label:'出局', color:'#dc0000', outcomes: ['三振','不死三振','滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺'] },
        { label:'安打', color:'#16a34a', outcomes: ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'] },
        { label:'上壘', color:'#0051a5', outcomes: ['保送','觸身球','故意四壞'] },
        { label:'其他', color:'#6b7280', outcomes: ['野選','失誤'] },
        { label:'戰術標籤', color:'#7c3aed', outcomes: ['打帶跑','戰術失敗'], type:'modifier' },
    ];
    // 各 outcome 對應的 cls（供 grouped 渲染使用）
    const BM_OUTCOME_CLS = {};
    BM_OUTCOMES.forEach(o => { BM_OUTCOME_CLS[o.label] = o.cls; });

    // ── 共用：渲染分組打席結果按鈕 ──
    function _renderGroupedOutcomes(containerId, selectedOutcome, clickFn) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.style.flexDirection = 'column';
        container.innerHTML = BM_OUTCOME_GROUPS.map(g => {
            const isModifier = g.type === 'modifier';
            const btns = g.outcomes.map(label => {
                let cls, active, fn;
                if (isModifier) {
                    cls    = 'bm-modifier';
                    active = _bmState.tactics.includes(label) ? ' bm-on' : '';
                    fn     = 'toggleBmTactic';
                } else {
                    cls    = BM_OUTCOME_CLS[label] || '';
                    active = selectedOutcome === label ? ' bm-on' : '';
                    fn     = clickFn;
                }
                return `<button class="bm-outcome-btn ${cls}${active}"
                    onclick="${fn}('${label}',this)"
                    ontouchend="event.preventDefault();${fn}('${label}',this)">${label}</button>`;
            }).join('');
            return `<div class="bm-outcome-group">
                <span class="bm-outcome-group-label" style="color:${g.color};font-size:11px;font-weight:800;display:block;margin-bottom:4px;">${g.label}</span>
                <div style="display:flex;flex-wrap:wrap;gap:5px;">${btns}</div>
            </div>`;
        }).join('');
    }

    // ── 多選戰術標籤 ──
    function toggleBmTactic(tag, btn) {
        const idx = _bmState.tactics.indexOf(tag);
        if (idx >= 0) {
            _bmState.tactics.splice(idx, 1);
            if (btn) btn.classList.remove('bm-on');
        } else {
            _bmState.tactics.push(tag);
            if (btn) btn.classList.add('bm-on');
        }
    }

    function _renderBmOutcomeButtons() {
        _renderGroupedOutcomes('bmOutcomeBtns', _bmState.selectedOutcome, 'selectBmOutcome');
        // 同步渲染內嵌球場圖（只在第一次，避免重複建立）
        const wrap = document.getElementById('bmHitMapWrap');
        if (wrap && !wrap.querySelector('svg')) {
            wrap.innerHTML = buildFieldSVG('', 'bm');
        }
    }

    function _renderSpOutcomeButtons() {
        _renderGroupedOutcomes('spOutcomeBtns', _bmState.spSelectedOutcome, 'selectSpOutcomeInline');
        // 渲染獨立模式球場圖
        const wrap = document.getElementById('spHitMapWrap');
        if (wrap && !wrap.querySelector('svg')) {
            wrap.innerHTML = buildFieldSVG('', 'sp');
        }
    }

    function selectBmOutcome(outcome, btn) {
        _bmState.selectedOutcome = outcome;
        document.querySelectorAll('.bm-outcome-btn').forEach(b => b.classList.remove('bm-on'));
        if (btn) btn.classList.add('bm-on');
        const confirmBtn = document.getElementById('bmConfirmBtn');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.style.opacity = '1'; }
    }

    // ── 取得聯動模式的球隊名稱 ──
    function _getBmTeamNames() {
        _initBmData();
        let nameA = 'A隊（後攻）', nameB = 'B隊（先攻）';
        const gi = allData.bm.gameIdx;
        if (gi >= 0 && allData.teams && allData.teams[gi]) {
            const t = allData.teams[gi];
            if (t.name)     nameA = t.name;
            if (t.opponent) nameB = t.opponent;
        }
        return { nameA, nameB };
    }

    function _renderBmBatterDisplay() {
        _initBmData();
        const order = _bmState.currentOrder;
        const attackingTeam = allData.bm.attackingTeam || 'B';
        const activeLineup = _getLineup(attackingTeam);
        const batter = activeLineup[order] || {number:'',name:'',hand:'右打',trait:''};
        const orderTxt = `第 ${order + 1} 棒`;
        const numTxt   = batter.number ? `#${batter.number}` : '#--';
        const nameTxt  = batter.name  || '（未填姓名）';
        const handTxt  = batter.hand  || '---';

        // ── 緊湊記錄卡（攻守顯示） ──
        const orderEl = document.getElementById('bmCurOrder');
        const numEl   = document.getElementById('bmCurBatterNum');
        const nameEl  = document.getElementById('bmCurBatterName');
        const handEl  = document.getElementById('bmCurHand');
        if (orderEl) orderEl.textContent = orderTxt;
        if (numEl)   numEl.textContent   = numTxt;
        if (nameEl)  nameEl.textContent  = nameTxt;
        if (handEl)  handEl.textContent  = handTxt;

        // ── 雙槽位卡（聯動模式）──
        const isA = attackingTeam === 'A';
        const { nameA, nameB } = _getBmTeamNames();

        // 更新隊名標籤
        const ta = document.getElementById('bmSlotTeamA');
        const tb = document.getElementById('bmSlotTeamB');
        if (ta) ta.textContent = nameA;
        if (tb) tb.textContent = nameB;

        // 進攻槽位：顯示當前打者
        const actNum   = document.getElementById(isA ? 'bmSlotNumA'   : 'bmSlotNumB');
        const actName  = document.getElementById(isA ? 'bmSlotNameA'  : 'bmSlotNameB');
        const actOrder = document.getElementById(isA ? 'bmSlotOrderA' : 'bmSlotOrderB');
        const actHand  = document.getElementById(isA ? 'bmSlotHandA'  : 'bmSlotHandB');
        if (actNum)   actNum.textContent   = numTxt;
        if (actName)  actName.textContent  = nameTxt;
        if (actOrder) actOrder.textContent = orderTxt;
        if (actHand)  actHand.textContent  = handTxt;

        // 守備槽位：顯示等待
        const inactNum   = document.getElementById(isA ? 'bmSlotNumB'   : 'bmSlotNumA');
        const inactName  = document.getElementById(isA ? 'bmSlotNameB'  : 'bmSlotNameA');
        const inactOrder = document.getElementById(isA ? 'bmSlotOrderB' : 'bmSlotOrderA');
        const inactHand  = document.getElementById(isA ? 'bmSlotHandB'  : 'bmSlotHandA');
        if (inactNum)   inactNum.textContent   = '⚾';
        if (inactName)  inactName.textContent  = '守備中';
        if (inactOrder) inactOrder.textContent = '---';
        if (inactHand)  inactHand.textContent  = '';

        // active-slot 樣式（卡片本身）
        const slotA = document.getElementById('bmSlotCardA');
        const slotB = document.getElementById('bmSlotCardB');
        if (slotA) slotA.classList.toggle('active-slot', isA);
        if (slotB) slotB.classList.toggle('active-slot', !isA);
        // 整欄外框高亮（讓情蒐員一眼看出進攻側）
        const colA = document.getElementById('bmMatchColA');
        const colB = document.getElementById('bmMatchColB');
        if (colA) colA.classList.toggle('bm-col-active', isA);
        if (colB) colB.classList.toggle('bm-col-active', !isA);

        // active-indicator
        const indA = document.getElementById('bmActiveIndA');
        const indB = document.getElementById('bmActiveIndB');
        if (indA) indA.style.display = isA ? '' : 'none';
        if (indB) indB.style.display = isA ? 'none' : '';

        // ── 特性補填 ──
        const traitEl = document.getElementById('bmTraitPatch');
        if (traitEl) traitEl.value = batter.trait || '';
        // ── 同步 pitcherHand 從進攻側對戰投手，並更新雙側顯示 ──
        const vsAtk = isA ? allData.bm.vsPhA : allData.bm.vsPhB;
        if (vsAtk?.hand) _bmState.pitcherHand = vsAtk.hand;
        _updateBmVsPitcherDisplay('A');
        _updateBmVsPitcherDisplay('B');

        // ── 更新打線模組標題 ──
        _updateBmLineupTitles();
    }

    function prevBmBatter() {
        _bmState.currentOrder = (_bmState.currentOrder + 8) % 9;
        _renderBmBatterDisplay();
        resetBmLinkedForm();
    }
    function nextBmBatter() {
        _bmState.currentOrder = (_bmState.currentOrder + 1) % 9;
        _renderBmBatterDisplay();
        resetBmLinkedForm();
    }

    function resetBmLinkedForm() {
        _bmState.selectedOutcome = null;
        _bmState.hitLoc = null;
        _bmState.tactics = [];
        const confirmBtn = document.getElementById('bmConfirmBtn');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.style.opacity = '0.4'; }
        document.querySelectorAll('.bm-outcome-btn').forEach(b => b.classList.remove('bm-on'));
        // 清除球場圖高亮
        const svg = document.getElementById('fieldSVG_bm');
        if (svg) _zoneHighlight(null, svg);
        const lbl = document.getElementById('bmHitZoneLabel');
        if (lbl) lbl.textContent = '';
    }

    function patchBmBatterName() {
        _initBmData();
        const side = allData.bm.attackingTeam || 'B';
        const el = document.getElementById('bmNamePatch' + side);
        if (!el) return;
        const val = el.value.trim();
        const lineup = _getLineup(side);
        lineup[_bmState.currentOrder].name = val;
        const nameEl = document.getElementById('bmCurBatterName');
        if (nameEl) nameEl.textContent = val || '（未填姓名）';
        saveToLocalStorage();
    }

    function patchBmBatterTrait() {
        _initBmData();
        const el = document.getElementById('bmTraitPatch');
        if (!el) return;
        const lineup = _getLineup(allData.bm.attackingTeam || 'B');
        lineup[_bmState.currentOrder].trait = el.value.trim();
        saveToLocalStorage();
    }

    // ── 獨立模式：比賽狀態控制 ──
    function selectSpHalf(half) {
        _bmState.spHalf = half;
        const t = document.getElementById('spHalfTopBtn');
        const b = document.getElementById('spHalfBotBtn');
        if (t) t.classList.toggle('bm-on', half==='上');
        if (b) b.classList.toggle('bm-on', half==='下');
    }

    function toggleSpBase(idx) {
        _bmState.spBases[idx] = !_bmState.spBases[idx];
        const ids = ['spBase1','spBase2','spBase3'];
        const labels = ['一壘','二壘','三壘'];
        const btn = document.getElementById(ids[idx]);
        if (btn) {
            btn.classList.toggle('bm-on', _bmState.spBases[idx]);
            btn.textContent = (_bmState.spBases[idx] ? '●' : '') + labels[idx];
        }
    }

    function setSpOuts(n) {
        _bmState.spOuts = n + 1 > _bmState.spOuts ? n + 1 : n;
        const max = 3;
        ['spOD0','spOD1','spOD2'].forEach((id, i) => {
            const dot = document.getElementById(id);
            if (dot) {
                const lit = i < _bmState.spOuts;
                dot.classList.toggle('bm-on', lit);
                dot.textContent = lit ? '●' : '○';
            }
        });
    }

    // ── 獨立模式：打席結果選擇（內嵌式，非彈窗） ──
    function selectSpOutcomeInline(outcome, btn) {
        _bmState.spSelectedOutcome = outcome;
        _bmState.spHitLoc = null;
        document.querySelectorAll('#spOutcomeBtns .bm-outcome-btn').forEach(b => b.classList.remove('bm-on'));
        if (btn) btn.classList.add('bm-on');
        // 清除落點高亮
        const svg = document.getElementById('fieldSVG_sp');
        if (svg) _zoneHighlight(null, svg);
        const lbl = document.getElementById('spHitZoneLabel');
        if (lbl) lbl.textContent = '';
        const confirmBtn = document.getElementById('spConfirmBtn');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.style.opacity = '1'; }
    }

    // ── 獨立模式：確認打席（內嵌式） ──
    function confirmSpAtBatInline() {
        const outcome = _bmState.spSelectedOutcome;
        if (!outcome) return;
        const number = (document.getElementById('spBatterNum')?.value  || '').trim();
        const name   = (document.getElementById('spBatterName')?.value || '').trim();
        const inning = parseInt(document.getElementById('spInning')?.value) || 1;
        const rec = {
            number, name, order: 0,
            hand: _bmState.spHand,
            inning, half: _bmState.spHalf,
            outs: _bmState.spOuts,
            bases: [..._bmState.spBases],
            pitcherHand: _bmState.spPh,
            outcome,
            tactics: [..._bmState.tactics],   // 戰術標籤（多選）
            hitLocation: _bmState.spHitLoc || null,
            mode: 'standalone',
            pitches: [],
            gameIdx: -1,
            ts: Date.now()
        };
        _initBmData();
        allData.bm.atBats.push(rec);
        saveToLocalStorage();
        saveBmToFirebase();
        // Reset form
        _bmState.spSelectedOutcome = null;
        _bmState.spHitLoc = null;
        _bmState.tactics = [];
        document.querySelectorAll('#spOutcomeBtns .bm-outcome-btn').forEach(b => b.classList.remove('bm-on'));
        const svg = document.getElementById('fieldSVG_sp');
        if (svg) _zoneHighlight(null, svg);
        const lbl = document.getElementById('spHitZoneLabel');
        if (lbl) lbl.textContent = '';
        const confirmBtn = document.getElementById('spConfirmBtn');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.style.opacity = '0.4'; }
        _renderSpRecentLog();
    }

    function selectBmHalf(half) {
        _bmState.half = half;
        const topBtn = document.getElementById('bmHalfTopBtn');
        const botBtn = document.getElementById('bmHalfBotBtn');
        if (topBtn) topBtn.classList.toggle('bm-on', half==='上');
        if (botBtn) botBtn.classList.toggle('bm-on', half==='下');
    }

    function setBmOuts(n) {
        _bmState.outs = n;
        for (let i=0;i<3;i++) {
            const btn = document.getElementById(`bmOD${i}`);
            if (!btn) continue;
            btn.classList.toggle('bm-on', i < n);
            btn.textContent = i < n ? '●' : '○';
        }
    }

    function toggleBmBase(idx) {
        _bmState.bases[idx] = !_bmState.bases[idx];
        const ids = ['bmBase1','bmBase2','bmBase3'];
        const labels = ['一壘','二壘','三壘'];
        const btn = document.getElementById(ids[idx]);
        if (btn) {
            btn.classList.toggle('bm-on', _bmState.bases[idx]);
            btn.textContent = (_bmState.bases[idx] ? '●' : '') + labels[idx];
        }
    }

    function selectBmPh(hand, side) {
        _initBmData();
        const vs = side === 'A' ? allData.bm.vsPhA : allData.bm.vsPhB;
        vs.hand = hand;
        if ((allData.bm.attackingTeam || 'B') === side) _bmState.pitcherHand = hand;
        _updateBmVsPitcherDisplay(side);
        saveToLocalStorage();
    }

    function _updateBmVsPitcherDisplay(side) {
        _initBmData();
        const vs = side === 'A' ? allData.bm.vsPhA : allData.bm.vsPhB;
        const numEl  = document.getElementById('bmVsNum'  + side);
        const nameEl = document.getElementById('bmVsName' + side);
        const lBtn   = document.getElementById('bmPhLBtn' + side);
        const rBtn   = document.getElementById('bmPhRBtn' + side);
        if (numEl)  numEl.textContent  = vs.number ? '#' + vs.number : '#--';
        if (nameEl) nameEl.textContent = vs.name   || '---';
        if (lBtn) lBtn.classList.toggle('bm-on', vs.hand === '左投');
        if (rBtn) rBtn.classList.toggle('bm-on', vs.hand !== '左投');
    }

    function _autoLinkBmPitcher(side) {
        _initBmData();
        // side='A'：A在打擊，面對B隊的投手 → 從 slotB 取資料
        // side='B'：B在打擊，面對A隊的投手 → 從 slotA 取資料
        const oppSlot = side === 'A' ? slotB : slotA;
        let pitcher = null;
        if (oppSlot && oppSlot.team !== null && oppSlot.pitcher !== null) {
            pitcher = allData.teams[oppSlot.team]?.pitchers[oppSlot.pitcher] || null;
        }
        if (!pitcher) {
            const gi = allData.bm?.linkedGameIndex ?? allData.bm?.gameIdx ?? -1;
            if (gi >= 0 && allData.teams[gi]?.pitchers?.length) {
                pitcher = allData.teams[gi].pitchers[0];
            }
        }
        if (!pitcher) { alert('找不到可連動的投手資料\n請先在投手模式選擇投手'); return; }
        const vs = side === 'A' ? allData.bm.vsPhA : allData.bm.vsPhB;
        vs.name   = pitcher.name   || '';
        vs.number = pitcher.number || '';
        vs.hand   = pitcher.hand   || '右投';
        if ((allData.bm.attackingTeam || 'B') === side) _bmState.pitcherHand = vs.hand;
        _updateBmVsPitcherDisplay(side);
        saveToLocalStorage();
    }

    function confirmBmLinkedAtBat() {
        if (!_bmState.selectedOutcome) return;
        _initBmData();
        const order = _bmState.currentOrder;
        const currentTeam = allData.bm.attackingTeam || 'B';
        const batter = _getLineup(currentTeam)[order] || {number:'',name:'',hand:'右打',trait:''};
        const inningEl = document.getElementById('bmInning');
        const inning = parseInt((inningEl && inningEl.value) || '1') || 1;

        // 讀取打者特性輸入框（可能有即時修改）
        const traitEl = document.getElementById('bmTraitPatch');
        if (traitEl && traitEl.value.trim()) {
            _getLineup(currentTeam)[order].trait = traitEl.value.trim();
        }
        const rec = {
            number: batter.number || '',
            name:   batter.name   || '',
            trait:  _getLineup(currentTeam)[order].trait || '',
            team:   currentTeam,
            order:  order + 1,
            hand:   batter.hand   || '右打',
            inning,
            half:   _bmState.half,
            outs:   _bmState.outs,
            bases:  [..._bmState.bases],
            pitcherHand: _bmState.pitcherHand,
            outcome: _bmState.selectedOutcome,
            tactics: [..._bmState.tactics],   // 戰術標籤（多選）
            hitLocation: null,
            mode: 'linked',
            pitches: [],
            gameIdx: allData.bm.gameIdx,
            ts: Date.now()
        };

        const outLabels = ['三振','不死三振','滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺'];
        // 直接使用內嵌球場圖選取的落點（不再跳 modal）
        if (_bmState.hitLoc) rec.hitLocation = _bmState.hitLoc;
        allData.bm.atBats.push(rec);
        saveToLocalStorage();
        saveBmToFirebase();
        _bmState.currentOrder = (_bmState.currentOrder + 1) % 9;
        resetBmLinkedForm();
        _renderBmBatterDisplay();
        _renderBmRecentLog();

        // 出局數計算（雙殺 +2）+ 三出局換局邏輯
        const outsAdded = rec.outcome === '雙殺' ? 2 : outLabels.includes(rec.outcome) ? 1 : 0;
        const totalOuts = _bmState.outs + outsAdded;
        if (totalOuts >= 3) {
            const inningEl = document.getElementById('bmInning');
            let inning = parseInt((inningEl && inningEl.value) || '1') || 1;
            const newHalf = _bmState.half === '上' ? '下' : '上';
            if (newHalf === '上') inning = Math.min(20, inning + 1);
            _bmState.half = newHalf;
            if (inningEl) inningEl.value = inning;
            const topBtn = document.getElementById('bmHalfTopBtn');
            const botBtn = document.getElementById('bmHalfBotBtn');
            if (topBtn) topBtn.classList.toggle('bm-on', newHalf === '上');
            if (botBtn) botBtn.classList.toggle('bm-on', newHalf === '下');
            _bmState.bases = [false, false, false];
            ['bmBase1','bmBase2','bmBase3'].forEach((id, i) => {
                const btn = document.getElementById(id);
                if (btn) { btn.classList.remove('bm-on'); btn.textContent = ['一壘','二壘','三壘'][i]; }
            });
            setBmOuts(0);
        } else {
            setBmOuts(totalOuts);
        }
        _syncBmLinkedToPitcher();
    }

    function _renderBmRecentLog() {
        const container = document.getElementById('bmRecentLog');
        if (!container || !allData.bm) return;
        const recent = [...(allData.bm.atBats||[])].slice(-5).reverse();
        const HIT = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const BB  = ['保送','觸身球','故意四壞','捕逸'];
        container.innerHTML = recent.length === 0 ? '<div style="color:#9ca3af;font-size:12px;">尚無記錄</div>' :
            recent.map(r => {
                const cls = HIT.includes(r.outcome) ? 'bm-log-hit' : BB.includes(r.outcome) ? 'bm-log-bb' : 'bm-log-out';
                const zone = r.hitLocation ? ` → ${r.hitLocation.zone}` : '';
                return `<div class="bm-log-row">
                    <span>#${r.number||'?'} ${r.name||''} <span style="font-size:11px;color:#9ca3af;">${r.inning}局${r.half}</span></span>
                    <span class="bm-log-outcome ${cls}">${r.outcome}${zone}</span>
                </div>`;
            }).join('');
    }

    // ── 獨立模式：逐球記錄 ──

    function _renderBmSpZoneGrid() {
        const container = document.getElementById('spZoneGrid');
        if (!container) return;
        const cells = [
            ['B1','B2','B3','B4','B5'],
            ['B6','1','2','3','B7'],
            ['B8','4','5','6','B9'],
            ['B10','7','8','9','B11'],
            ['B12','B13','B14','B15','B16']
        ];
        container.innerHTML = `<div class="sp-zone-grid">` +
            cells.flat().map(key => {
                const isStrike = /^[1-9]$/.test(key);
                const selected = _bmState.spZone === key;
                return `<div class="sp-zone-cell${isStrike?' sp-strike':''}${selected?' sp-on':''}"
                    onclick="selectSpZone('${key}',this)" ontouchend="event.preventDefault();selectSpZone('${key}',this)">
                    ${isStrike ? key : ''}
                </div>`;
            }).join('') + '</div>';
    }

    function selectSpType(type, btn) {
        _bmState.spType = type;
        document.querySelectorAll('.sp-type-btn').forEach(b => b.classList.remove('sp-on'));
        if (btn) btn.classList.add('sp-on');
        _checkSpRecordReady();
    }

    function selectSpZone(zone, cell) {
        _bmState.spZone = zone;
        document.querySelectorAll('.sp-zone-cell').forEach(c => c.classList.remove('sp-on'));
        if (cell) cell.classList.add('sp-on');
        const lbl = document.getElementById('spZoneLabel');
        if (lbl) lbl.textContent = /^[1-9]$/.test(zone) ? `好球帶 ${zone}` : `壞球 ${zone}`;
        _checkSpRecordReady();
    }

    function selectSpHand(hand) {
        _bmState.spHand = hand;
        const lBtn = document.getElementById('spHandLBtn');
        const rBtn = document.getElementById('spHandRBtn');
        if (lBtn) lBtn.classList.toggle('bm-on', hand==='左打');
        if (rBtn) rBtn.classList.toggle('bm-on', hand==='右打');
    }

    function selectSpPh(ph) {
        _bmState.spPh = ph;
        const lBtn = document.getElementById('spPhLBtn');
        const rBtn = document.getElementById('spPhRBtn');
        if (lBtn) lBtn.classList.toggle('bm-on', ph==='左投');
        if (rBtn) rBtn.classList.toggle('bm-on', ph==='右投');
    }

    function selectSpReact(react, btn) {
        _bmState.spReact = react;
        document.querySelectorAll('.sp-react-btn').forEach(b => b.classList.remove('sp-on'));
        if (btn) btn.classList.add('sp-on');
        _checkSpRecordReady();
    }

    function _checkSpRecordReady() {
        const ready = !!(_bmState.spType && _bmState.spZone && _bmState.spReact);
        const btn = document.getElementById('spRecordBtn');
        if (btn) { btn.disabled = !ready; btn.style.opacity = ready ? '1' : '0.4'; }
    }

    function recordSpPitch() {
        if (!_bmState.spType || !_bmState.spZone || !_bmState.spReact) return;
        const isStrikeZone = /^[1-9]$/.test(_bmState.spZone);
        const react = _bmState.spReact;
        let isStrike = false;
        if (react === '揮棒落空') isStrike = true;
        else if (react === '擦棒/界外') {
            isStrike = _bmState.spStrikes < 2;
        } else if (react === '看球') isStrike = isStrikeZone;
        else if (react === '打進場內') isStrike = true;

        const pitch = {
            type:    _bmState.spType,
            zone:    _bmState.spZone,
            reaction: react,
            isStrike
        };
        _bmState.spPitches.push(pitch);

        if (isStrike && !(_bmState.spStrikes === 2 && react === '擦棒/界外')) {
            _bmState.spStrikes = Math.min(_bmState.spStrikes + 1, 2);
        } else if (!isStrike) {
            _bmState.spBalls = Math.min(_bmState.spBalls + 1, 3);
        }

        const countEl = document.getElementById('spCountDisplay');
        if (countEl) countEl.textContent = `${_bmState.spBalls}B ${_bmState.spStrikes}S`;
        const pcEl = document.getElementById('spPitchCount');
        if (pcEl) pcEl.textContent = _bmState.spPitches.length;
        const logEl = document.getElementById('spPitchLog');
        if (logEl) {
            logEl.textContent = _bmState.spPitches.map((p,i) =>
                `${i+1}. ${p.type} [${p.zone}] ${p.reaction}`
            ).join('　');
        }

        _bmState.spType = null; _bmState.spZone = null; _bmState.spReact = null;
        document.querySelectorAll('.sp-type-btn').forEach(b => b.classList.remove('sp-on'));
        document.querySelectorAll('.sp-react-btn').forEach(b => b.classList.remove('sp-on'));
        _renderBmSpZoneGrid();
        const lbl = document.getElementById('spZoneLabel');
        if (lbl) lbl.textContent = '';
        _checkSpRecordReady();
    }

    function endSpAtBat() {
        _bmState.spSelectedOutcome = null;
        _bmState.spHitLoc = null;
        const outcomeDiv = document.createElement('div');
        outcomeDiv.id = 'spOutcomeOverlay';
        outcomeDiv.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;overflow-y:auto;';
        outcomeDiv.innerHTML = `
            <div style="background:white;border-radius:16px;padding:20px;width:100%;max-width:460px;margin:auto;">
                <h3 style="margin:0 0 12px;font-size:16px;font-family:'Oswald','Noto Sans TC',sans-serif;">打席結果</h3>
                <!-- 打席結果按鈕 -->
                <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;" id="spOutcomePicker">
                    ${BM_OUTCOMES.map(o=>`<button class="bm-outcome-btn ${o.cls}"
                        onclick="selectSpAtBatOutcome('${o.label}',this)"
                        ontouchend="event.preventDefault();selectSpAtBatOutcome('${o.label}',this)"
                        style="font-size:13px;">${o.label}</button>`).join('')}
                </div>
                <!-- 球場落點圖（進場球才顯示） -->
                <div id="spHitMapSection" style="display:none;margin-bottom:12px;">
                    <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">
                        🗺️ 打擊落點（可選）<span id="spHitZoneLabel" style="color:#003d79;font-weight:900;margin-left:4px;"></span>
                    </div>
                    <div id="spHitMapWrap" style="max-width:280px;margin:0 auto;"></div>
                </div>
                <!-- 確認 / 取消 -->
                <div style="display:flex;gap:8px;margin-top:4px;">
                    <button onclick="document.getElementById('spOutcomeOverlay').remove()"
                        style="flex:1;padding:10px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit;">取消</button>
                    <button id="spConfirmAtBatBtn" onclick="confirmSpAtBat()" disabled
                        style="flex:2;padding:10px;background:#003d79;color:white;border:none;border-radius:8px;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;opacity:0.4;touch-action:manipulation;">
                        ✅ 確認打席</button>
                </div>
            </div>`;
        document.body.appendChild(outcomeDiv);
    }

    function selectSpAtBatOutcome(outcome, btn) {
        _bmState.spSelectedOutcome = outcome;
        _bmState.spHitLoc = null;
        document.querySelectorAll('#spOutcomePicker .bm-outcome-btn').forEach(b => b.classList.remove('bm-on'));
        if (btn) btn.classList.add('bm-on');
        const isBip = BM_BALL_IN_PLAY.includes(outcome);
        const section = document.getElementById('spHitMapSection');
        if (section) {
            section.style.display = isBip ? 'block' : 'none';
            if (isBip) {
                const wrap = document.getElementById('spHitMapWrap');
                if (wrap && !wrap.querySelector('svg')) wrap.innerHTML = buildFieldSVG('', 'sp');
            }
        }
        const lbl = document.getElementById('spHitZoneLabel');
        if (lbl) lbl.textContent = '';
        const confirmBtn = document.getElementById('spConfirmAtBatBtn');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.style.opacity = '1'; }
    }

    function confirmSpAtBat() {
        const outcome = _bmState.spSelectedOutcome;
        if (!outcome) return;
        const overlay = document.getElementById('spOutcomeOverlay');
        if (overlay) overlay.remove();

        const numEl  = document.getElementById('spBatterNum');
        const nameEl = document.getElementById('spBatterName');
        const number = numEl ? numEl.value.trim() : '';
        const name   = nameEl ? nameEl.value.trim() : '';

        const rec = {
            number, name,
            order: 0,
            hand:  _bmState.spHand,
            inning: 1,
            half: '上',
            outs: 0,
            bases: [false,false,false],
            pitcherHand: _bmState.spPh,
            outcome,
            hitLocation: _bmState.spHitLoc || null,
            mode: 'standalone',
            pitches: [..._bmState.spPitches],
            gameIdx: -1,
            ts: Date.now()
        };

        _initBmData();
        allData.bm.atBats.push(rec);
        saveToLocalStorage();
        saveBmToFirebase();
        _bmState.spPitches = []; _bmState.spBalls = 0; _bmState.spStrikes = 0;
        _bmState.spType = null; _bmState.spZone = null; _bmState.spReact = null;
        _bmState.spSelectedOutcome = null; _bmState.spHitLoc = null;
        const countEl = document.getElementById('spCountDisplay');
        if (countEl) countEl.textContent = '0B 0S';
        const pcEl = document.getElementById('spPitchCount');
        if (pcEl) pcEl.textContent = '0';
        const logEl = document.getElementById('spPitchLog');
        if (logEl) logEl.textContent = '';
        document.querySelectorAll('.sp-type-btn,.sp-react-btn').forEach(b => b.classList.remove('sp-on'));
        _renderBmSpZoneGrid();
        _checkSpRecordReady();
        _renderSpRecentLog();
    }

    function _renderSpRecentLog() {
        const container = document.getElementById('spRecentLog');
        if (!container || !allData.bm) return;
        const standaloneABs = [...(allData.bm.atBats||[])].filter(a=>a.mode==='standalone').slice(-5).reverse();
        const HIT = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const BB  = ['保送','觸身球','故意四壞','捕逸'];
        container.innerHTML = standaloneABs.length === 0 ? '<div style="color:#9ca3af;font-size:12px;">尚無記錄</div>' :
            standaloneABs.map(r => {
                const cls = HIT.includes(r.outcome) ? 'bm-log-hit' : BB.includes(r.outcome) ? 'bm-log-bb' : 'bm-log-out';
                const zone = r.hitLocation ? ` → ${r.hitLocation.zone}` : '';
                return `<div class="bm-log-row">
                    <span>#${r.number||'?'} ${r.name||''} <span style="font-size:11px;color:#9ca3af;">${r.pitches.length}球</span></span>
                    <span class="bm-log-outcome ${cls}">${r.outcome}${zone}</span>
                </div>`;
            }).join('');
    }

    // ── 統計 Tab ──
    function _renderBmStats() {
        const container = document.getElementById('bmStatsContent');
        if (!container) return;
        _initBmData();
        // 連動模式且已選賽事：從投手記錄推導打席；否則用獨立打席資料
        const atBats = (currentTeam !== null)
            ? _deriveBmAtBatsFromPitches(currentTeam)
            : allData.bm.atBats || [];
        if (atBats.length === 0) {
            container.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:14px;">尚無打席記錄<br><span style="font-size:12px;">請先在側欄選取一場賽事</span></div>';
            return;
        }
        const HIT = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const BB  = ['保送','觸身球','故意四壞','捕逸'];
        const PA_END = [...HIT,...BB,'三振','不死三振','滾地球出局','飛球出局','平飛球出局','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤'];

        // 依球隊分組聚合
        const teamGroupMap = {}; // teamName → { number → batter }
        atBats.forEach(ab => {
            const tname = ab.teamName || '未標記球隊';
            if (!teamGroupMap[tname]) teamGroupMap[tname] = {};
            const key = String(ab.number || '?');
            if (!teamGroupMap[tname][key]) teamGroupMap[tname][key] = { number:ab.number, name:ab.name, hand:ab.hand, abs:[] };
            else if (ab.name && !teamGroupMap[tname][key].name) teamGroupMap[tname][key].name = ab.name;
            teamGroupMap[tname][key].abs.push(ab);
        });

        // 計算每位打者統計 + OPS + 威脅指數
        const buildRows = (map) => Object.values(map).map(b => {
            const abs    = b.abs;
            const pa     = abs.filter(a => PA_END.includes(a.outcome)).length;
            const hits   = abs.filter(a => HIT.includes(a.outcome)).length;
            const k      = abs.filter(a => a.outcome==='三振'||a.outcome==='不死三振').length;
            const bb     = abs.filter(a => BB.includes(a.outcome)).length;
            const hbp    = abs.filter(a => a.outcome==='觸身球').length;
            const sf     = abs.filter(a => a.outcome==='高飛犧牲打').length;
            const sh     = abs.filter(a => a.outcome==='犧牲觸擊').length;
            const singles= abs.filter(a => a.outcome==='一壘安打'||a.outcome==='內野安打').length;
            const doubles= abs.filter(a => a.outcome==='二壘安打').length;
            const triples= abs.filter(a => a.outcome==='三壘安打').length;
            const hrs    = abs.filter(a => a.outcome==='全壘打').length;
            const ab_n   = Math.max(0, pa - bb - hbp - sf - sh);
            const tb     = singles + doubles*2 + triples*3 + hrs*4;
            const obp_n  = (pa - sh) > 0 ? (hits + bb + hbp) / (pa - sh) : 0;
            const slg_n  = ab_n > 0 ? tb / ab_n : 0;
            const ops_n  = obp_n + slg_n;
            const avgNum = pa > 0 ? hits / pa : 0;
            const kRate  = pa > 0 ? k / pa : 0;
            const ops    = pa >= 3 ? ops_n : null;  // null = 樣本不足
            // 威脅分：打率高→危險(綠)；三振率高→我方有利(紅)
            const threatScore = avgNum * 100 - kRate * 25;
            const threatLevel = threatScore >= 22 ? 'high' : threatScore >= 11 ? 'mid' : 'low';
            return { ...b, pa, hits, k, bb, avgNum, kRate, ops, ops_n, threatScore, threatLevel };
        });

        // 排序輔助
        function _bmSortRows(rows) {
            return [...rows].sort((a, b) => {
                let va, vb;
                switch (_bmSortKey) {
                    case 'number': va = String(a.number||''); vb = String(b.number||''); break;
                    case 'pa':     va = a.pa;    vb = b.pa;    break;
                    case 'hits':   va = a.hits;  vb = b.hits;  break;
                    case 'avg':    va = a.avgNum; vb = b.avgNum; break;
                    case 'ops':    va = a.ops_n;  vb = b.ops_n; break;
                    case 'k':      va = a.k;     vb = b.k;     break;
                    case 'bb':     va = a.bb;    vb = b.bb;    break;
                    default:       va = a.threatScore; vb = b.threatScore;
                }
                if (typeof va === 'string') return _bmSortDir === 'asc' ? va.localeCompare(vb,'zh-TW') : vb.localeCompare(va,'zh-TW');
                return _bmSortDir === 'asc' ? va - vb : vb - va;
            });
        }

        // 排序箭頭
        function _bmArrow(key) {
            if (_bmSortKey !== key) return '<span style="color:rgba(255,255,255,0.35);font-size:10px;"> ↕</span>';
            return `<span style="color:#ffd700;font-size:10px;"> ${_bmSortDir === 'desc' ? '↓' : '↑'}</span>`;
        }

        // 打擊率 inline bar
        function _bmAvgBar(avgNum) {
            const pct = Math.min(avgNum / 0.400, 1);
            const w   = Math.round(pct * 44);
            const col = avgNum >= 0.300 ? '#10b981' : avgNum >= 0.200 ? '#9ca3af' : '#ef4444';
            const fmt = avgNum > 0 ? '.' + String(Math.round(avgNum * 1000)).padStart(3,'0') : '.000';
            return `<span style="font-weight:900;color:${col};">${fmt}</span>` +
                   `<span style="display:inline-block;width:${w}px;height:6px;background:${col};border-radius:3px;margin-left:4px;vertical-align:middle;opacity:0.7;"></span>`;
        }

        // 威脅 badge
        function _bmThreatBadge(level) {
            const cfg = {
                high: { bg:'#dcfce7', color:'#15803d', border:'#16a34a', label:'高威脅' },
                mid:  { bg:'#f3f4f6', color:'#6b7280', border:'#9ca3af', label:'中威脅' },
                low:  { bg:'#fee2e2', color:'#b91c1c', border:'#ef4444', label:'低威脅' },
            };
            const c = cfg[level];
            return `<span style="display:inline-block;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:800;background:${c.bg};color:${c.color};border:1.5px solid ${c.border};white-space:nowrap;">${c.label}</span>`;
        }

        // 三振顏色
        function _bmKStyle(k, pa) {
            return (pa > 0 && k / pa >= 0.35) ? 'color:#dc2626;font-weight:900;' : '';
        }

        // 表格（含球隊摘要 + 可排序欄位）
        const tableHTML = (rows, tname) => {
            const sorted = _bmSortRows(rows);
            const totalPA   = rows.reduce((s, r) => s + r.pa, 0);
            const totalHits = rows.reduce((s, r) => s + r.hits, 0);
            const totalK    = rows.reduce((s, r) => s + r.k, 0);
            const teamAvg   = totalPA > 0 ? totalHits / totalPA : 0;
            const teamKRate = totalPA > 0 ? totalK / totalPA * 100 : 0;
            const topThreat = rows.length > 0
                ? rows.reduce((best, r) => r.threatScore > best.threatScore ? r : best)
                : null;
            const teamAvgFmt = totalPA > 0
                ? '.' + String(Math.round(teamAvg * 1000)).padStart(3,'0') : '---';
            const teamKFmt  = totalPA > 0 ? teamKRate.toFixed(1) + '%' : '---';
            const topName   = topThreat ? `#${topThreat.number}${topThreat.name ? ' ' + topThreat.name : ''}` : '---';
            const avgFill   = teamAvg >= 0.300 ? '#4ade80' : teamAvg >= 0.200 ? '#fbbf24' : '#f87171';
            const kFill     = parseFloat(teamKFmt) >= 30 ? '#4ade80' : '#fbbf24';
            const thS = 'padding:8px 5px;text-align:center;font-size:12px;font-weight:700;color:white;background:#003d79;cursor:pointer;user-select:none;white-space:nowrap;border-bottom:2px solid #0051a5;';
            const thLS = 'padding:8px 8px;text-align:left;font-size:12px;font-weight:700;color:white;background:#003d79;cursor:pointer;user-select:none;white-space:nowrap;border-bottom:2px solid #0051a5;';

            return `
              <!-- 球隊摘要 -->
              <div style="background:linear-gradient(135deg,#003d79,#0051a5);border-radius:10px;padding:12px 14px;margin-bottom:10px;color:white;">
                <div style="font-size:11px;font-weight:700;opacity:0.7;margin-bottom:9px;letter-spacing:0.05em;">⚡ ${tname} · 整體分析</div>
                <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;">
                  <div style="text-align:center;">
                    <div style="font-size:26px;font-weight:900;font-family:'Oswald',sans-serif;color:${avgFill};">${teamAvgFmt}</div>
                    <div style="font-size:11px;opacity:0.7;">整體打擊率</div>
                  </div>
                  <div style="text-align:center;">
                    <div style="font-size:26px;font-weight:900;font-family:'Oswald',sans-serif;color:${kFill};">${teamKFmt}</div>
                    <div style="font-size:11px;opacity:0.7;">整體三振率</div>
                  </div>
                  <div style="text-align:center;flex:1;min-width:80px;">
                    <div style="font-size:15px;font-weight:900;">${topName}</div>
                    <div style="font-size:11px;opacity:0.7;">最高威脅打者</div>
                  </div>
                  <div style="text-align:center;">
                    <div style="font-size:22px;font-weight:900;">${rows.length}</div>
                    <div style="font-size:11px;opacity:0.7;">登錄打者</div>
                  </div>
                </div>
              </div>
              <!-- 可排序表格 -->
              <div style="overflow-x:auto;margin-bottom:6px;">
              <table class="bm-stats-table">
                <thead><tr>
                  <th style="${thLS}" onclick="setBmSort('number')">打者${_bmArrow('number')}</th>
                  <th style="${thS}" onclick="setBmSort('pa')">打席${_bmArrow('pa')}</th>
                  <th style="${thS}" onclick="setBmSort('hits')">安打${_bmArrow('hits')}</th>
                  <th style="${thS}min-width:110px;" onclick="setBmSort('avg')">打率${_bmArrow('avg')}</th>
                  <th style="${thS}min-width:90px;" onclick="setBmSort('ops')">OPS${_bmArrow('ops')}</th>
                  <th style="${thS}" onclick="setBmSort('k')">三振${_bmArrow('k')}</th>
                  <th style="${thS}" onclick="setBmSort('bb')">保送${_bmArrow('bb')}</th>
                </tr></thead>
                <tbody>
                ${sorted.map(r => {
                    const opsFmt = r.ops !== null
                        ? (() => {
                            const v = r.ops_n;
                            const col = v >= 0.800 ? '#15803d' : v >= 0.600 ? '#374151' : '#b91c1c';
                            return `<span style="font-weight:800;color:${col};">${v.toFixed(3)}</span>`;
                          })()
                        : `<span style="color:#d1d5db;font-size:11px;">樣本不足</span>`;
                    return `<tr onclick="showBmBatterDetail('${r.number}')" style="cursor:pointer;font-size:13px;">
                      <td style="padding:8px 8px;white-space:nowrap;"><span style="font-weight:900;font-size:14px;">#${r.number} ${r.name||''}</span><br><span style="font-size:11px;color:#6b7280;">${r.hand}</span></td>
                      <td style="padding:8px 5px;text-align:center;font-weight:700;">${r.pa}</td>
                      <td style="padding:8px 5px;text-align:center;font-weight:700;">${r.hits}</td>
                      <td style="padding:8px 6px;white-space:nowrap;">${_bmAvgBar(r.avgNum)}</td>
                      <td style="padding:8px 5px;text-align:center;">${opsFmt}</td>
                      <td style="padding:8px 5px;text-align:center;${_bmKStyle(r.k,r.pa)}">${r.k}</td>
                      <td style="padding:8px 5px;text-align:center;">${r.bb}</td>
                    </tr>`;
                }).join('')}
                </tbody>
              </table></div>
              <div style="font-size:11px;color:#9ca3af;text-align:right;margin-bottom:4px;">點擊欄位標題排序 · 點擊列查看詳情</div>`;
        };

        const groupsHTML = Object.entries(teamGroupMap).map(([tname, map]) => {
            const rows = buildRows(map);
            return `<div style="min-width:0;">
                <div style="font-size:13px;font-weight:900;color:#003d79;padding:6px 0 4px;border-bottom:2px solid #003d79;margin-bottom:8px;">${tname}</div>
                ${tableHTML(rows, tname)}
            </div>`;
        }).join('');

        container.innerHTML = `
            <h2>📊 打者成績一覽</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;align-items:start;margin-bottom:16px;">
              ${groupsHTML}
            </div>
            <div id="bmBatterDetailSection"></div>`;
    }

    function showBmBatterDetail(number) {
        _initBmData();
        const atBats = (allData.bm.atBats||[]).filter(a => String(a.number) === String(number));
        if (atBats.length === 0) return;
        const b = { number, name: atBats.find(a=>a.name)?.name||'', hand: atBats[0].hand||'右打' };
        const HIT = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const BB  = ['保送','觸身球','故意四壞','捕逸'];

        const locs = atBats.filter(a=>a.hitLocation);
        // 線條：從本壘板 (150,272) 畫到落點，紅=安打，藍=非安打
        const dotsHTML = locs.map(a => {
            const sx = (a.hitLocation.x * 300).toFixed(1), sy = (a.hitLocation.y * 280).toFixed(1);
            const isHit = HIT.includes(a.outcome);
            const color = isHit ? '#ef4444' : '#3b82f6';
            return `<line x1="150" y1="272" x2="${sx}" y2="${sy}" stroke="${color}" stroke-width="2" opacity="0.7" stroke-linecap="round" style="pointer-events:none;"/>`;
        }).join('');

        const standalonePitches = atBats.filter(a=>a.mode==='standalone').flatMap(a=>a.pitches||[]);
        let pitchBreakdown = '';
        if (standalonePitches.length > 0) {
            const typeMap = {};
            standalonePitches.forEach(p => {
                if (!typeMap[p.type]) typeMap[p.type] = { total:0, swing:0, contact:0 };
                typeMap[p.type].total++;
                if (p.reaction !== '看球') typeMap[p.type].swing++;
                if (p.reaction === '打進場內') typeMap[p.type].contact++;
            });
            pitchBreakdown = `<h3 style="margin-top:16px;">⚾ 球種面對紀錄（獨立模式）</h3><div style="overflow-x:auto;"><table class="bm-stats-table"><thead><tr><th>球種</th><th>球數</th><th>揮棒</th><th>揮棒率</th><th>接觸</th></tr></thead><tbody>`+
                Object.entries(typeMap).sort((a,b)=>b[1].total-a[1].total).map(([t,c])=>
                    `<tr><td>${t}</td><td>${c.total}</td><td>${c.swing}</td><td>${c.total>0?Math.round(c.swing/c.total*100):0}%</td><td>${c.contact}</td></tr>`
                ).join('') + '</tbody></table></div>';
        }

        const detailEl = document.getElementById('bmBatterDetailSection');
        if (!detailEl) return;
        detailEl.innerHTML = `
            <hr style="margin:20px 0;">
            <h2>#${b.number} ${b.name||'（未填姓名）'} · ${b.hand}</h2>
            <h3>🗺️ 打擊落點圖</h3>
            <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;">
                <div>${buildFieldSVG(dotsHTML)}</div>
                <div style="flex:1;min-width:120px;font-size:12px;">
                    <div style="display:flex;flex-direction:column;gap:6px;">
                      <span><svg width="20" height="12" style="vertical-align:middle;margin-right:4px;"><line x1="0" y1="6" x2="20" y2="6" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/></svg>安打</span>
                      <span><svg width="20" height="12" style="vertical-align:middle;margin-right:4px;"><line x1="0" y1="6" x2="20" y2="6" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/></svg>非安打</span>
                    </div>
                    <div style="margin-top:8px;color:#6b7280;">共 ${locs.length} 筆落點記錄</div>
                </div>
            </div>
            ${pitchBreakdown}
            <h3 style="margin-top:16px;">📋 打席記錄</h3>
            <div>${atBats.map((a,i)=>{
                const cls = HIT.includes(a.outcome)?'bm-log-hit':BB.includes(a.outcome)?'bm-log-bb':'bm-log-out';
                const zone = a.hitLocation ? ` → ${a.hitLocation.zone}` : '';
                return `<div class="bm-log-row"><span style="color:#6b7280;">${i+1}. ${a.mode==='linked'?'🔗':'📝'} ${a.pitcherHand||''}</span>
                    <span class="bm-log-outcome ${cls}">${a.outcome}${zone}</span></div>`;
            }).join('')}</div>`;
        detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function setBmSort(key) {
        if (_bmSortKey === key) {
            _bmSortDir = _bmSortDir === 'desc' ? 'asc' : 'desc';
        } else {
            _bmSortKey = key;
            _bmSortDir = key === 'name' || key === 'number' ? 'asc' : 'desc';
        }
        _renderBmStats();
    }

    function selectBmAnalysisTeam(teamName) {
        _bmAnalysisTeamFilter   = teamName || null;
        _bmAnalysisBatterFilter = null; // 換隊伍時重置個人篩選
        _renderBmAnalysis();
    }

    function selectBmAnalysisBatter(key) {
        _bmAnalysisBatterFilter = key || null;
        _renderBmAnalysis();
    }

    // ── 分析 Tab ──
    function _renderBmAnalysis() {
        const container = document.getElementById('bmAnalysisContent');
        if (!container) return;
        _initBmData();

        // ── 收集全部投球（投手記錄優先；無賽事時改用 bm.atBats 轉換） ──
        const allPitches = [];
        let _analysisTeamNames = [];

        if (currentTeam !== null) {
            const team = allData.teams[currentTeam];
            if (!team) return;
            _analysisTeamNames = [team.name || '先攻', team.opponent || '後攻'];
            (team.pitchers || []).forEach(pitcher => {
                (pitcher.pitches || []).forEach(p => {
                    allPitches.push({ ...p, _pitcherHand: pitcher.hand || '右投' });
                });
            });
        } else {
            // 從 bm.atBats 建立虛擬投球記錄（讓分析函式統一讀 allPitches）
            (allData.bm.atBats || []).forEach(ab => {
                if (!ab.outcome) return;
                allPitches.push({
                    outcomes:      [ab.outcome, ...(ab.tactics || [])],
                    basesSnapshot: ab.bases || [false, false, false],
                    hitLocation:   ab.hitLocation || null,
                    type:          null,
                    balls:         ab.balls   || 0,
                    strikes:       ab.strikes || 0,
                    inning:        ab.inning  || null,
                    half:          ab.half    || null,
                    _pitcherHand:  ab.pitcherHand || '右投',
                    batterHand:    ab.hand    || '右打',
                    batterTeam:    ab.teamName || '未知隊伍',
                    batterName:    ab.name    || '',
                    batterNumber:  ab.number  || '',
                    pinchHit:      false,
                });
            });
            _analysisTeamNames = [...new Set(
                (allData.bm.atBats || []).map(a => a.teamName).filter(Boolean)
            )];
        }

        if (allPitches.length === 0) {
            container.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:14px;">尚無投球或打席記錄<br><small>請先選取賽事，或在打者記錄頁新增打席</small></div>';
            return;
        }

        // ── 打者選擇器（兩層：隊伍 → 個人） ──
        const selectorEl = document.getElementById('bmAnalysisBatterSelector');
        if (selectorEl) {
            const teamNameA = _analysisTeamNames[0] || '先攻';
            const teamNameB = _analysisTeamNames[1] || '後攻';

            function _pill(label, onclick, active) {
                return `<button onclick="${onclick}"
                    style="padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;
                           border:2px solid ${active ? '#003d79' : '#d1d5db'};
                           background:${active ? '#003d79' : 'white'};
                           color:${active ? 'white' : '#374151'};
                           cursor:pointer;font-family:inherit;touch-action:manipulation;white-space:nowrap;">${label}</button>`;
            }

            // 第一層：隊伍按鈕
            const teamRow = `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:10px 0 6px;">
                ${_pill('全部',   "selectBmAnalysisTeam(null)",           !_bmAnalysisTeamFilter)}
                ${_pill(teamNameA, `selectBmAnalysisTeam('${teamNameA.replace(/'/g,"\\'")}')`, _bmAnalysisTeamFilter === teamNameA)}
                ${_pill(teamNameB, `selectBmAnalysisTeam('${teamNameB.replace(/'/g,"\\'")}')`, _bmAnalysisTeamFilter === teamNameB)}
            </div>`;

            // 第二層：選了隊伍才展開個人 pills
            let batterRow = '';
            if (_bmAnalysisTeamFilter) {
                const teamBatterMap = new Map();
                allPitches.forEach(p => {
                    const pitchTeam = p.batterTeam || (currentTeam !== null ? _inferBatterTeam(p, allData.teams[currentTeam]) : '') || '';
                    if (pitchTeam !== _bmAnalysisTeamFilter) return;
                    const name = (p.batterName || '').trim();
                    const num  = String(p.batterNumber || '').trim();
                    const key  = name || (num ? `#${num}` : '');
                    if (!key || teamBatterMap.has(key)) return;
                    teamBatterMap.set(key, name || `背號 ${num}`);
                });
                if (teamBatterMap.size > 0) {
                    const pills = [
                        _pill('整隊', "selectBmAnalysisBatter(null)", !_bmAnalysisBatterFilter),
                        ...[...teamBatterMap.entries()].map(([k, lbl]) =>
                            _pill(lbl, `selectBmAnalysisBatter('${k.replace(/'/g,"\\'")}')`, k === _bmAnalysisBatterFilter)
                        )
                    ].join('');
                    batterRow = `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px;border-top:1px solid #f0f0f0;padding-top:8px;">${pills}</div>`;
                }
            }

            selectorEl.innerHTML = batterRow ? teamRow + batterRow : teamRow;
        }

        // ── 依選定隊伍 + 打者篩選 ──
        let filteredPitches = allPitches;
        if (_bmAnalysisTeamFilter) {
            filteredPitches = filteredPitches.filter(p => {
                const pitchTeam = p.batterTeam || _inferBatterTeam(p, team) || '';
                return pitchTeam === _bmAnalysisTeamFilter;
            });
        }
        if (_bmAnalysisBatterFilter) {
            const isNumKey = _bmAnalysisBatterFilter.startsWith('#');
            const numKey   = isNumKey ? _bmAnalysisBatterFilter.slice(1) : null;
            filteredPitches = filteredPitches.filter(p => isNumKey
                ? String(p.batterNumber || '') === numKey && !(p.batterName || '').trim()
                : (p.batterName || '').trim() === _bmAnalysisBatterFilter
            );
        }

        const PA_ENDING = ['三振','不死三振','滾地球出局','飛球出局','平飛球出局',
            '內野安打','一壘安打','二壘安打','三壘安打','全壘打',
            '保送','觸身球','故意四壞','犧牲觸擊','高飛犧牲打','雙殺','野選','失誤','捕逸'];
        const HIT = ['內野安打','一壘安打','二壘安打','三壘安打','全壘打'];
        const paPitches = filteredPitches.filter(p => (p.outcomes || []).some(o => PA_ENDING.includes(o)));

        if (paPitches.length < 3) {
            container.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:14px;">記錄至少 3 個打席後顯示分析</div>';
            return;
        }

        function pct(n, t) { return t > 0 ? Math.round(n / t * 100) : 0; }

        // ── SVG 甜甜圈 ──
        function donut(segs, total, centerTxt) {
            if (!total) return '<svg width="90" height="90"><circle cx="45" cy="45" r="35" fill="none" stroke="#e5e7eb" stroke-width="15"/><text x="45" y="49" text-anchor="middle" font-size="10" fill="#9ca3af">無資料</text></svg>';
            const cx = 45, cy = 45, r = 35, ir = 20;
            let angle = -Math.PI / 2, paths = '';
            segs.forEach(s => {
                if (!s.v) return;
                const a = (s.v / total) * 2 * Math.PI;
                const ea = angle + a, lg = a > Math.PI ? 1 : 0;
                const [x1,y1] = [cx+r*Math.cos(angle), cy+r*Math.sin(angle)];
                const [x2,y2] = [cx+r*Math.cos(ea),    cy+r*Math.sin(ea)];
                const [xi1,yi1] = [cx+ir*Math.cos(angle), cy+ir*Math.sin(angle)];
                const [xi2,yi2] = [cx+ir*Math.cos(ea),    cy+ir*Math.sin(ea)];
                paths += `<path d="M${xi1},${yi1}L${x1},${y1}A${r},${r},0,${lg},1,${x2},${y2}L${xi2},${yi2}A${ir},${ir},0,${lg},0,${xi1},${yi1}Z" fill="${s.c}"/>`;
                angle = ea;
            });
            return `<svg width="90" height="90" viewBox="0 0 90 90">${paths}
                <text x="45" y="48" text-anchor="middle" font-size="9" font-weight="bold" fill="#374151">${centerTxt||''}</text></svg>`;
        }

        function dotLegend(segs, total) {
            return segs.filter(s => s.v > 0).map(s =>
                `<div style="display:flex;align-items:center;gap:5px;font-size:12px;margin-bottom:4px;">
                    <div style="width:9px;height:9px;border-radius:50%;background:${s.c};flex-shrink:0;"></div>
                    <span style="font-weight:700;">${s.lbl}</span>
                    <span style="color:#6b7280;">${pct(s.v,total)}%（${s.v}）</span>
                </div>`).join('');
        }

        function card(title, svgHtml, legendHtml, noteHtml) {
            return `<div style="background:white;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
                <div style="font-size:14px;font-weight:900;color:#003d79;margin-bottom:10px;">${title}</div>
                <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
                    <div style="flex-shrink:0;">${svgHtml}</div>
                    <div style="flex:1;min-width:130px;">${legendHtml}</div>
                </div>
                ${noteHtml ? `<div style="margin-top:8px;font-size:11px;color:#6b7280;">${noteHtml}</div>` : ''}
            </div>`;
        }

        const DIR_MAP = { 'LF':'左','LCF':'左','CF':'中','RCF':'右','RF':'右',
            '3B':'左','SS':'左','2B':'右','1B':'右','三短':'左','一短':'右','P':'中','本壘前':'中' };

        // ── 1. 打擊方向傾向 ──
        const dirC = {左:0, 中:0, 右:0};
        paPitches.forEach(p => {
            if (p.hitLocation) {
                const d = DIR_MAP[p.hitLocation.zone];
                if (d in dirC) dirC[d]++;
            }
        });
        const dirTotal = dirC.左 + dirC.中 + dirC.右;
        const dirSegs = [
            {lbl:'拉打（左）', v:dirC.左, c:'#dc0000'},
            {lbl:'中間',       v:dirC.中, c:'#0051a5'},
            {lbl:'推打（右）', v:dirC.右, c:'#10b981'},
        ];
        const sec1 = card('📍 1. 打擊方向傾向',
            donut(dirSegs, dirTotal, `${dirTotal}筆`),
            dirTotal > 0 ? dotLegend(dirSegs, dirTotal) : '<span style="color:#9ca3af;font-size:12px;">尚無落點記錄</span>',
            dirTotal === 0 ? '紀錄投球時若有選擇落點，此處將自動顯示' : null
        );

        // ── 2. 打擊類型 ──
        const typeC = {安打:0, 飛球:0, 滾地:0, 平飛:0, 短打:0, 三振:0, 保送:0};
        paPitches.forEach(p => {
            const o = p.outcomes || [];
            if (o.some(x => HIT.includes(x)))                            typeC.安打++;
            else if (o.some(x => ['飛球出局','高飛犧牲打'].includes(x))) typeC.飛球++;
            else if (o.includes('滾地球出局'))                            typeC.滾地++;
            else if (o.includes('平飛球出局'))                            typeC.平飛++;
            else if (o.includes('犧牲觸擊'))                              typeC.短打++;
            else if (o.some(x => ['三振','不死三振'].includes(x)))        typeC.三振++;
            else if (o.some(x => ['保送','觸身球','故意四壞'].includes(x))) typeC.保送++;
        });
        const typeSegs = [
            {lbl:'安打',     v:typeC.安打, c:'#10b981'},
            {lbl:'飛球出局', v:typeC.飛球, c:'#f59e0b'},
            {lbl:'滾地出局', v:typeC.滾地, c:'#8b5cf6'},
            {lbl:'平飛出局', v:typeC.平飛, c:'#06b6d4'},
            {lbl:'短打',     v:typeC.短打, c:'#ec4899'},
            {lbl:'三振',     v:typeC.三振, c:'#dc0000'},
            {lbl:'保送/觸身',v:typeC.保送, c:'#6b7280'},
        ];
        const sec2 = card('⚡ 2. 打擊類型',
            donut(typeSegs, paPitches.length, `${paPitches.length}打席`),
            dotLegend(typeSegs, paPitches.length)
        );

        // ── 3. 球種弱點 ──
        const pitchW = {};
        paPitches.forEach(p => {
            if (!p.type) return;
            if (!pitchW[p.type]) pitchW[p.type] = {pa:0, k:0, hits:0};
            const o = p.outcomes || [];
            pitchW[p.type].pa++;
            if (o.some(x => ['三振','不死三振'].includes(x))) pitchW[p.type].k++;
            if (o.some(x => HIT.includes(x))) pitchW[p.type].hits++;
        });
        const ptchEntries = Object.entries(pitchW).sort((a,b) => b[1].pa - a[1].pa);
        const ptchColors = ['#003d79','#0051a5','#dc0000','#ffd700','#10b981','#9333ea','#f59e0b'];
        const ptchSegs = ptchEntries.map(([t,r], i) => ({lbl:t, v:r.pa, c:ptchColors[i % ptchColors.length]}));
        const ptchTotal = ptchEntries.reduce((s,[,r]) => s + r.pa, 0);
        const ptchLegend = ptchEntries.length === 0
            ? '<span style="color:#9ca3af;font-size:12px;">無球種記錄</span>'
            : ptchEntries.map(([t,r], i) =>
                `<div style="display:flex;align-items:center;gap:5px;font-size:12px;margin-bottom:4px;">
                    <div style="width:9px;height:9px;border-radius:50%;background:${ptchColors[i%ptchColors.length]};flex-shrink:0;"></div>
                    <span style="font-weight:700;">${t}</span>
                    <span style="color:#10b981;">安打${pct(r.hits,r.pa)}%</span>
                    <span style="color:#dc0000;">K${pct(r.k,r.pa)}%</span>
                    <span style="color:#9ca3af;">(${r.pa})</span>
                </div>`).join('');
        const sec3 = card('🎯 3. 球種弱點',
            donut(ptchSegs, ptchTotal, `${ptchEntries.length}球種`),
            ptchLegend
        );

        // ── 4. 球數傾向 ──
        const countMap = {};
        paPitches.forEach(p => {
            const key = `${p.balls||0}-${p.strikes||0}`;
            if (!countMap[key]) countMap[key] = {pa:0, hits:0};
            countMap[key].pa++;
            if ((p.outcomes||[]).some(o => HIT.includes(o))) countMap[key].hits++;
        });
        const cntEntries = Object.entries(countMap).sort((a,b) => b[1].pa - a[1].pa).slice(0, 6);
        const cntTotal   = Object.values(countMap).reduce((s,v) => s + v.pa, 0);
        const cntColors  = ['#dc0000','#0051a5','#10b981','#f59e0b','#9333ea','#6b7280'];
        const cntSegs    = cntEntries.map(([k,v], i) => ({lbl:k, v:v.pa, c:cntColors[i]}));
        const cntLegend  = cntEntries.map(([key,v], i) => {
            const [b,s] = key.split('-');
            return `<div style="display:flex;align-items:center;gap:5px;font-size:12px;margin-bottom:4px;">
                <div style="width:9px;height:9px;border-radius:50%;background:${cntColors[i]};flex-shrink:0;"></div>
                <span style="font-weight:700;">${b}B ${s}S</span>
                <span style="color:#6b7280;">${pct(v.pa,cntTotal)}%（${v.pa}次）</span>
                <span style="color:#10b981;font-size:11px;">打率${v.pa>0?(v.hits/v.pa).toFixed(3):'---'}</span>
            </div>`;
        }).join('');
        const sec4 = card('🔢 4. 球數傾向',
            donut(cntSegs, cntTotal, ''),
            cntLegend,
            '顯示前 6 個最常見的打席終止球數'
        );

        // ── 5. 戰術常用時機點 ──
        // 收集盜壘資料（依 currentTeam 決定來源）
        const allSteals = currentTeam !== null
            ? (allData.teams[currentTeam]?.pitchers || []).flatMap(p => p.steals || [])
            : (allData.bm?.steals || []);
        // 篩選盜壘：依選定打者隊伍
        const filteredSteals = _bmAnalysisTeamFilter
            ? allSteals  // 球隊盜壘（無法精確分隊，顯示全部）
            : allSteals;

        function _countMap(arr, keyFn) {
            const m = {};
            arr.forEach(x => { const k = keyFn(x); if(k) m[k] = (m[k]||0) + 1; });
            return Object.entries(m).sort((a,b) => b[1]-a[1]);
        }
        function _miniTable(title, entries, color) {
            if (!entries.length) return `<div style="font-size:12px;color:#9ca3af;">無記錄</div>`;
            return `<div style="font-size:12px;font-weight:800;color:${color};margin:6px 0 4px;">${title}</div>` +
                entries.slice(0,5).map(([k,v]) =>
                    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;border-bottom:1px solid #f3f4f6;">
                        <span>${k}</span><span style="font-weight:700;">${v}次</span></div>`
                ).join('');
        }

        // 犧牲觸擊分析
        const buntPA = paPitches.filter(p => (p.outcomes||[]).includes('犧牲觸擊'));
        const buntCountDist = _countMap(buntPA, p => `${p.balls||0}B ${p.strikes||0}S`);
        const buntBaseDist  = _countMap(buntPA, p => {
            const bs = p.basesSnapshot||[false,false,false];
            if (bs[0]&&bs[1]) return '一二壘';
            if (bs[1]&&bs[2]) return '二三壘';
            if (bs[0]&&bs[2]) return '一三壘';
            if (bs[2]) return '三壘有人';
            if (bs[1]) return '二壘有人';
            if (bs[0]) return '一壘有人';
            return '空壘';
        });
        const buntInnDist = _countMap(buntPA, p => p.inning ? `${p.inning}局` : null);

        // 強迫取分（Squeeze）：三壘有人 + 犧牲觸擊
        const squeezePA = buntPA.filter(p => {
            const bs = p.basesSnapshot||[false,false,false];
            return bs[2]; // 三壘有人
        });
        const squeezeCountDist = _countMap(squeezePA, p => `${p.balls||0}B ${p.strikes||0}S`);
        const squeezeInnDist   = _countMap(squeezePA, p => p.inning ? `${p.inning}局` : null);

        // 打帶跑（從 pitch.outcomes 標籤）
        const hitRunPA      = paPitches.filter(p => (p.outcomes||[]).includes('打帶跑'));
        const hitRunFail    = hitRunPA.filter(p => (p.outcomes||[]).includes('戰術失敗')).length;
        const hitRunSuccess = hitRunPA.length - hitRunFail;
        const hitRunCountDist = _countMap(hitRunPA, p => `${p.balls||0}B ${p.strikes||0}S`);

        // 盜壘
        const stealTotal   = filteredSteals.length;
        const stealSuccess = filteredSteals.filter(s => s.success).length;
        const stealCountDist = _countMap(filteredSteals.filter(s => s.balls != null),
            s => `${s.balls}B ${s.strikes}S`);
        const stealInnDist   = _countMap(filteredSteals, s => s.inning ? `${s.inning}局` : null);

        function _tactSection(icon, title, count, color, contentHTML) {
            return `<div style="background:white;border-radius:10px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,0.08);border-left:4px solid ${color};">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                    <span style="font-size:18px;">${icon}</span>
                    <span style="font-size:13px;font-weight:900;color:#003d79;">${title}</span>
                    <span style="margin-left:auto;font-size:20px;font-weight:900;font-family:'Oswald',sans-serif;color:${color};">${count}</span>
                </div>
                ${contentHTML}
            </div>`;
        }

        const buntContent = buntPA.length === 0
            ? '<div style="font-size:12px;color:#9ca3af;">尚無犧牲觸擊記錄</div>'
            : `<div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div style="flex:1;min-width:100px;">${_miniTable('球數', buntCountDist, '#ec4899')}</div>
                <div style="flex:1;min-width:100px;">${_miniTable('壘上狀況', buntBaseDist, '#f59e0b')}</div>
                <div style="flex:1;min-width:80px;">${_miniTable('局數', buntInnDist, '#0051a5')}</div>
               </div>`;

        const squeezeContent = squeezePA.length === 0
            ? '<div style="font-size:12px;color:#9ca3af;">尚無三壘有人觸擊記錄</div>'
            : `<div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div style="flex:1;min-width:100px;">${_miniTable('球數', squeezeCountDist, '#dc0000')}</div>
                <div style="flex:1;min-width:80px;">${_miniTable('局數', squeezeInnDist, '#0051a5')}</div>
               </div>`;

        const hitRunContent = hitRunPA.length === 0
            ? '<div style="font-size:12px;color:#9ca3af;">尚無打帶跑標籤記錄</div>'
            : `<div style="font-size:12px;margin-bottom:6px;">
                成功 <b style="color:#16a34a;">${hitRunSuccess}</b> 次
                失敗 <b style="color:#dc2626;">${hitRunFail}</b> 次
                成功率 <b>${hitRunPA.length>0?Math.round(hitRunSuccess/hitRunPA.length*100):0}%</b>
               </div>
               ${_miniTable('常用球數', hitRunCountDist, '#7c3aed')}`;

        const stealContent = stealTotal === 0
            ? '<div style="font-size:12px;color:#9ca3af;">尚無盜壘記錄</div>'
            : `<div style="font-size:12px;margin-bottom:6px;">
                成功 <b style="color:#16a34a;">${stealSuccess}</b>
                失敗 <b style="color:#dc2626;">${stealTotal-stealSuccess}</b>
                成功率 <b>${Math.round(stealSuccess/stealTotal*100)}%</b>
               </div>
               <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div style="flex:1;min-width:100px;">${_miniTable('盜壘當下球數', stealCountDist, '#10b981')}</div>
                <div style="flex:1;min-width:80px;">${_miniTable('局數', stealInnDist, '#0051a5')}</div>
               </div>`;

        const sec5 = `<div style="font-size:15px;font-weight:900;color:#003d79;margin:16px 0 10px;">⚔️ 5. 戰術常用時機點</div>
            ${_tactSection('📦','犧牲觸擊', `${buntPA.length}次`, '#ec4899', buntContent)}
            ${_tactSection('💥','強迫取分（Squeeze）', `${squeezePA.length}次`, '#dc0000', squeezeContent)}
            ${_tactSection('🏃','打帶跑', `${hitRunPA.length}次`, '#7c3aed', hitRunContent)}
            ${_tactSection('⚡','盜壘', `${stealTotal}次`, '#10b981', stealContent)}`;

        // ── 6. 壘上狀況應對 ──
        const baseS = {'空壘':{pa:0,hits:0,k:0},'一壘':{pa:0,hits:0,k:0},'得點圈':{pa:0,hits:0,k:0},'滿壘':{pa:0,hits:0,k:0}};
        paPitches.forEach(p => {
            const bs = p.basesSnapshot || [false,false,false];
            const key = (bs[0]&&bs[1]&&bs[2]) ? '滿壘' : (bs[1]||bs[2]) ? '得點圈' : bs[0] ? '一壘' : '空壘';
            const o = p.outcomes || [];
            baseS[key].pa++;
            if (o.some(x => HIT.includes(x)))                           baseS[key].hits++;
            if (o.some(x => ['三振','不死三振'].includes(x)))            baseS[key].k++;
        });
        const baseColors = {'空壘':'#6b7280','一壘':'#0051a5','得點圈':'#f59e0b','滿壘':'#dc0000'};
        const baseSegs   = Object.entries(baseS).map(([k,v]) => ({lbl:k, v:v.pa, c:baseColors[k]}));
        const baseTotal  = baseSegs.reduce((s,x) => s + x.v, 0);
        const baseLegend = Object.entries(baseS).filter(([,v]) => v.pa > 0).map(([k,v]) =>
            `<div style="display:flex;align-items:center;gap:5px;font-size:12px;margin-bottom:4px;">
                <div style="width:9px;height:9px;border-radius:50%;background:${baseColors[k]};flex-shrink:0;"></div>
                <span style="font-weight:700;">${k}</span>
                <span style="color:#6b7280;">${v.pa}打席</span>
                <span style="color:#10b981;">打率${v.pa>0?(v.hits/v.pa).toFixed(3):'---'}</span>
                <span style="color:#dc0000;font-size:11px;">K${pct(v.k,v.pa)}%</span>
            </div>`).join('');
        const sec6 = card('🏃 6. 壘上狀況應對',
            donut(baseSegs, baseTotal, `${baseTotal}打席`),
            baseLegend
        );

        const _teamLabel   = _bmAnalysisTeamFilter ? `${_bmAnalysisTeamFilter}・` : '';
        const _batterLabel = _bmAnalysisBatterFilter
            ? ((_bmAnalysisBatterFilter.startsWith('#') ? `背號 ${_bmAnalysisBatterFilter.slice(1)}` : _bmAnalysisBatterFilter) + '・')
            : '';
        container.innerHTML = `<h2 style="margin-bottom:12px;">🔍 ${_teamLabel}${_batterLabel}打者傾向分析（${paPitches.length} 打席）</h2>${sec1}${sec2}${sec3}${sec4}${sec5}${sec6}`;
    }

    // ── Firebase 打者模式同步 ──
    function saveBmToFirebase() {
        if (!allData.bm) return;
        if (typeof USER_TEAM_REF !== 'undefined' && USER_TEAM_REF) {
            try {
                USER_TEAM_REF.child('bm').set(JSON.parse(JSON.stringify(allData.bm)))
                    .catch(e => console.warn('[Firebase] bm 寫入失敗:', e));
            } catch(e) {}
        } else if (typeof db !== 'undefined' && db) {
            try {
                db.ref('pitcherScoutData/bm').set(JSON.parse(JSON.stringify(allData.bm)))
                    .catch(e => console.warn('[Firebase] admin bm 寫入失敗:', e));
            } catch(e) {}
        }
    }

    function syncBmData(btn) {
        if (btn) btn.textContent = '⏳ 同步中...';
        saveBmToFirebase();
        setTimeout(() => { if (btn) btn.textContent = '☁️ 同步'; }, 1500);
    }

    // 頁面初始化（不依賴 Auth，僅載入本機資料與 UI）
    init();
