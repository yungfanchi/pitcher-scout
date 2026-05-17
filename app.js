    // ====== PITCH COLOR PALETTE ======
    const PITCH_ORDER = ['快速球','上飄球','下墜球','變速球','二速球','內曲','外曲'];
    const PITCH_COLORS = {
        '快速球': '#FF2A2A',   // 正烈火紅
        '上飄球': '#2979FF',   // 皇家極致藍
        '下墜球': '#8B4513',   // 剛鐵深棕
        '變速球': '#FFD700',   // 閃電亮黃
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
    let expandedGames = new Set(); // track which game groups are expanded

    // ====== MULTI-TENANT AUTH ======
    let userSession = null;      // Firebase Auth user object
    let USER_TEAM_REF = null;    // db.ref('teams/{teamCode}') — locked after auth

    // Game state
    let gameState = {
        strikes: 0, balls: 0, outs: 0,
        bases: [false, false, false], // 1B, 2B, 3B
        half: '上', inning: 1
    };

    function getDefaultScore() {
        return { home: 0, away: 0, inning: 1, half: '上' };
    }

    // ====== PITCHER DB HELPERS ======
    function getPitcherKey(name, number) {
        return `${name}#${number || ''}`;
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
        outcomes: [], wild: false, foul: false, swing: false, pinchHit: false
    };

    // ====== INIT ======
    // ====== 密碼設定（可自行修改）======
    const ADMIN_CODE = 'CT55'; // 管理員代碼（你專用）
    let ADMIN_PW_HASH = null;
    _sha256('ct55').then(h => { ADMIN_PW_HASH = h; });
    let userRole = null; // 'scout' | 'view' | 'admin'
    let currentTeamCode = null; // 當前球隊代碼
    let selectedLoginRole = 'scout';

    function selectRole(role) {
        selectedLoginRole = role;
        document.getElementById('roleScout').classList.toggle('selected', role === 'scout');
        document.getElementById('roleView').classList.toggle('selected', role === 'view');
        const pwLabel = document.getElementById('pwLabel');
        if (pwLabel) pwLabel.textContent = role === 'scout' ? '情蒐員密碼' : '觀看密碼';
        document.getElementById('pwGroup').style.display = 'block'; // 兩種角色都需要密碼
        document.getElementById('loginError').textContent = '';
    }

    async function doLogin() {
        try { document.activeElement && document.activeElement.blur(); } catch(e) {}
        const teamCodeEl = document.getElementById('loginTeamCode');
        const teamCode = teamCodeEl ? teamCodeEl.value.trim().toUpperCase() : '';
        const pw = document.getElementById('loginPw').value.trim();

        if (!teamCode) { document.getElementById('loginError').textContent = '❌ 請輸入球隊代碼'; return; }
        if (!pw) { document.getElementById('loginError').textContent = '❌ 請輸入密碼'; return; }

        // 管理員登入（本地驗證，不需網路）
        if (teamCode === ADMIN_CODE) {
            const inputHash = await _sha256(pw);
            if (inputHash === ADMIN_PW_HASH) {
                currentTeamCode = 'ADMIN';
                await _cacheCredential(teamCode, 'scout', pw);
                enterSystem('scout');
                return;
            }
        }

        // 先嘗試本地快取驗證（離線可用）
        if (await _checkCachedCredential(teamCode, selectedLoginRole, pw)) {
            currentTeamCode = teamCode;
            try { localStorage.setItem('lastTeamCode', teamCode); } catch(e) {}
            enterSystem(selectedLoginRole);
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
                    enterSystem(selectedLoginRole);
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
                    enterSystem(selectedLoginRole);
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
        const [scoutHash, viewHash] = await Promise.all([_sha256(scoutPw), _sha256(viewPw)]);
        db.ref(`teams/${teamCode}/config`).set({ scoutPw: scoutHash, viewPw: viewHash, createdAt: Date.now() })
            .then(() => alert(`✅ 球隊 ${teamCode} 建立成功！\n情蒐員密碼：${scoutPw}\n觀看密碼：${viewPw}`))
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

        const showModal = () => {
            const m = document.getElementById('updateModal');
            if (m && m.style.display !== 'flex') m.style.display = 'flex';
        };

        const setup = (reg) => {
            if (!reg) return;

            // 新 SW 接管後重新整理（iOS/Android 相容，不用 reload(true)）
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload();
            });

            // App 重開時若已有等待的新版本，直接顯示
            if (reg.waiting) { showModal(); return; }

            // 新 SW 安裝完成 → 顯示更新提示
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                if (!nw) return;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                        showModal();
                    }
                });
            });

            const poll = () => reg.update().catch(() => {});

            // 立即檢查
            poll();
            // 每 5 分鐘定期檢查（電腦長時間開著也能收到更新）
            setInterval(poll, 5 * 60 * 1000);
            // 手機/平板從背景切回前景時立即檢查（解決 PWA 不更新的主因）
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') poll();
            });
        };

        if (regParam) { setup(regParam); }
        else { navigator.serviceWorker.getRegistration().then(setup); }
    }

    function doForceUpdate() {
        document.getElementById('updateModal').style.display = 'none';
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration().then(reg => {
                if (reg && reg.waiting) {
                    // SKIP_WAITING → controllerchange → window.location.reload()
                    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                } else {
                    window.location.reload();
                }
            }).catch(() => window.location.reload());
        } else {
            window.location.reload();
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

        // 重置 UI 狀態
        document.getElementById('pdfScopeSection').style.display = 'none';
        document.getElementById('pdfGameSelectWrap').style.display = 'none';
        document.getElementById('pdfGenerateBtn').style.display = 'none';
        const allRadio = document.querySelector('input[name="pdfScope"][value="all"]');
        if (allRadio) allRadio.checked = true;

        document.getElementById('pdfFilterModal').style.display = 'flex';
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

    // 點擊「產生 PDF」按鈕
    function generatePDF() {
        const pitcherName = document.getElementById('pdfPitcherSelect').value;
        const scopeEl = document.querySelector('input[name="pdfScope"]:checked');
        const scope = scopeEl ? scopeEl.value : 'all';
        const gameIndex = scope === 'single' ? document.getElementById('pdfGameSelect').value : 'all';

        if (!pitcherName) { alert('請選擇投手'); return; }
        if (scope === 'single' && !gameIndex) { alert('請選擇場次'); return; }

        exportToPDF(pitcherName, gameIndex);
    }

    // ===== 核心過濾函式（PDF 實體導出預留殼） =====
    // pitcherName: 投手姓名字串
    // gameId: 'all' | teamIndex 字串（對應 allData.teams 索引）
    function exportToPDF(pitcherName, gameId) {
        const sections = [];

        allData.teams.forEach((team, ti) => {
            if (gameId !== 'all' && String(ti) !== String(gameId)) return;
            (team.pitchers || []).forEach(pitcher => {
                if (pitcher.name !== pitcherName) return;
                const pitches = pitcher.pitches || [];
                if (!pitches.length) return;

                // 計算摘要統計
                const total = pitches.length;
                const strikes = pitches.filter(p => p.result === '好球').length;
                const speeds = pitches.filter(p => p.speed).map(p => p.speed);
                const avgSpd = speeds.length ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : '--';
                const maxSpd = speeds.length ? Math.max(...speeds) : '--';
                const ks = pitches.filter(p => (p.outcomes || []).some(o => o === '三振' || o === '不死三振')).length;
                const walks = pitches.filter(p => (p.outcomes || []).some(o => o === '保送' || o === '觸身球')).length;
                const typeMap = {};
                pitches.forEach(p => { if (p.type) typeMap[p.type] = (typeMap[p.type] || 0) + 1; });
                const topTypes = Object.entries(typeMap).sort((a, b) => b[1] - a[1]);

                sections.push({ team, pitcher, pitches, total, strikes, avgSpd, maxSpd, ks, walks, topTypes });
            });
        });

        // 預留殼：console 呈現過濾結果，PDF 實體導出待接套件
        console.log(`[exportToPDF] 投手: ${pitcherName} | 場次: ${gameId === 'all' ? '全部場次' : '第 ' + gameId + ' 場'}`);
        console.log('[exportToPDF] 過濾結果 sections:', sections);

        if (!sections.length) { alert('所選條件無投球數據'); return; }

        closePDFFilter();
        _buildAndOpenReport(sections, pitcherName, gameId);
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
    function _buildAndOpenReport(sections, pitcherName, gameId) {
        const isAll = gameId === 'all';
        const pitcher = sections[0].pitcher;
        const allPitches = sections.flatMap(s => s.pitches);
        const st = _calcPitcherStats(allPitches);
        if (!st) { alert('無投球數據'); return; }

        const scopeLabel = isAll
            ? `生涯累計（共 ${sections.length} 場）`
            : [sections[0].team.date, sections[0].team.gameName, sections[0].team.opponent ? 'vs '+sections[0].team.opponent : ''].filter(Boolean).join(' ');

        const css = `
            *{box-sizing:border-box;margin:0;padding:0;}
            body{font-family:'Noto Sans TC',Arial,sans-serif;padding:24px;color:#1e3a5f;max-width:960px;margin:0 auto;font-size:13px;}
            h1{font-size:22px;font-weight:900;color:#003d79;border-bottom:4px solid #d4af37;padding-bottom:8px;margin-bottom:12px;}
            .section-title{font-size:14px;font-weight:900;color:#003d79;border-left:4px solid #d4af37;padding:5px 10px;background:#f0f4ff;border-radius:0 6px 6px 0;margin:20px 0 10px;}
            .pitcher-header{background:linear-gradient(135deg,#003d79,#0051a5);color:white;border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;}
            .ph-name{font-size:26px;font-weight:900;letter-spacing:2px;}
            .ph-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}
            .ph-badge{background:rgba(255,255,255,0.18);padding:3px 10px;border-radius:20px;font-size:12px;}
            .ph-badge-gold{background:rgba(255,215,0,0.25);color:#fde68a;}
            .scope-chip{background:rgba(255,255,255,0.15);font-size:12px;padding:4px 12px;border-radius:20px;border:1px solid rgba(255,255,255,0.3);white-space:nowrap;}
            .stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px;}
            .stat-box{background:#f0f4ff;border:1px solid #c7d7f0;border-radius:8px;padding:10px;text-align:center;}
            .stat-val{font-size:20px;font-weight:900;color:#003d79;line-height:1.1;}
            .stat-lbl{font-size:10px;color:#6b7280;margin-top:3px;}
            table{width:100%;border-collapse:collapse;margin:6px 0;}
            th{background:#003d79;color:white;padding:7px 10px;text-align:center;font-size:12px;font-weight:700;}
            td{padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center;font-size:12px;}
            td.left{text-align:left;}
            tr:nth-child(even) td{background:#f9fafb;}
            .bar-wrap{background:#e5e7eb;border-radius:4px;height:8px;margin-top:3px;}
            .bar-fill{height:100%;border-radius:4px;background:#003d79;}
            .count-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;}
            .count-box{border:2px solid;border-radius:8px;padding:10px;text-align:center;}
            .count-ahead{border-color:#16a34a;background:#f0fdf4;}
            .count-even{border-color:#d4af37;background:#fffbeb;}
            .count-behind{border-color:#dc2626;background:#fef2f2;}
            .game-row{display:grid;grid-template-columns:1fr auto auto auto auto;gap:8px;align-items:center;padding:8px 10px;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:6px;}
            .pitch-log-table th{font-size:11px;padding:5px 6px;}
            .pitch-log-table td{font-size:11px;padding:4px 6px;}
            .sep{border:none;border-top:2px dashed #d4af37;margin:22px 0;}
            .footer{margin-top:20px;font-size:10px;color:#9ca3af;text-align:right;border-top:1px solid #e5e7eb;padding-top:8px;}
            @media print{body{padding:12px;}.section-title{break-inside:avoid;}}`;

        // 球種分析 table
        const typeTable = st.typeSorted.length ? `
            <table><tr><th>球種</th><th>球數</th><th>佔比</th><th>好球率</th><th>均速</th><th>最高球速</th></tr>
            ${st.typeSorted.map(([t,v])=>{
                const pct=((v.n/st.total)*100).toFixed(1);
                const sr=v.n?((v.k/v.n)*100).toFixed(1):'0';
                const avg=v.spd.length?(v.spd.reduce((a,b)=>a+b,0)/v.spd.length).toFixed(1):'--';
                const mx=v.spd.length?Math.max(...v.spd):'--';
                return `<tr><td class="left" style="font-weight:700;">${t}</td><td>${v.n}</td><td>${pct}%</td><td>${sr}%</td><td>${avg}</td><td>${mx}</td></tr>`;
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

        // 打擊結果統計
        const outcomeRows = [
            ['三振','K',st.ks],['保送/觸身','BB+HBP',st.walks],
            ['被安打','H',st.hits],['全壘打','HR',st.hrs],
        ].map(([l,code,n])=>`<tr><td class="left">${l}</td><td style="color:#003d79;font-weight:900;">${n}</td><td>${st.total?((n/st.total)*100).toFixed(1)+'%':'--'}</td></tr>`).join('');

        // 各場次摘要（生涯模式才顯示）
        let gamesBlock = '';
        if (isAll && sections.length > 1) {
            gamesBlock = `<div class="section-title">📅 各場次摘要</div>
            <table><tr><th>日期</th><th>賽事</th><th>對手</th><th>球數</th><th>好球率</th><th>均速</th><th>三振</th></tr>
            ${sections.map(s=>{
                const ps=s.pitches, t=ps.length;
                if(!t) return '';
                const sp=ps.filter(p=>p.result==='好球').length;
                const spd=ps.filter(p=>p.speed).map(p=>p.speed);
                const av=spd.length?(spd.reduce((a,b)=>a+b,0)/spd.length).toFixed(1):'--';
                const k=ps.filter(p=>(p.outcomes||[]).some(o=>o==='三振'||o==='不死三振')).length;
                return `<tr><td>${s.team.date||'--'}</td><td class="left">${s.team.gameName||''}</td><td>${s.team.opponent||''}</td><td>${t}</td><td>${t?((sp/t)*100).toFixed(1)+'%':'--'}</td><td>${av}</td><td>${k}</td></tr>`;
            }).join('')}</table>`;
        }

        // 逐球明細
        const pitchLog = `<table class="pitch-log-table">
            <tr><th>#</th><th>局</th><th>打序</th><th>球種</th><th>球速</th><th>位置</th><th>結果</th><th>揮/暴/界</th><th>打擊結果</th><th>備註</th></tr>
            ${allPitches.map((p,i)=>`<tr>
                <td>${i+1}</td>
                <td>${p.inning?p.inning+(p.half==='下'?'↓':'↑'):''}</td>
                <td>${p.batterOrder||'--'}</td>
                <td style="font-weight:700;">${p.type||'--'}</td>
                <td>${p.speed||'--'}</td>
                <td>${p.zone||'--'}</td>
                <td style="color:${p.result==='好球'?'#d97706':'#16a34a'};font-weight:700;">${p.result||'--'}</td>
                <td>${[p.swing?'揮':'',p.wild?'暴':'',p.foul?'界':''].filter(Boolean).join('/')}</td>
                <td>${(p.outcomes||[]).join('/')}</td>
                <td>${p.note||''}</td>
            </tr>`).join('')}
            </table>`;

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
                    </div>
                </div>
                <div class="scope-chip">📊 ${scopeLabel}</div>
            </div>

            <div class="section-title">📊 核心統計</div>
            <div class="stats-row">
                <div class="stat-box"><div class="stat-val">${st.total}</div><div class="stat-lbl">總球數</div></div>
                <div class="stat-box"><div class="stat-val">${st.total?((st.strikes/st.total)*100).toFixed(1):'0'}%</div><div class="stat-lbl">好球率</div></div>
                <div class="stat-box"><div class="stat-val">${st.avgSpd}</div><div class="stat-lbl">平均球速 km/h</div></div>
                <div class="stat-box"><div class="stat-val">${st.maxSpd}</div><div class="stat-lbl">最高球速</div></div>
            </div>
            <div class="stats-row">
                <div class="stat-box"><div class="stat-val">${st.ks}</div><div class="stat-lbl">三振</div></div>
                <div class="stat-box"><div class="stat-val">${st.walks}</div><div class="stat-lbl">保送/觸身</div></div>
                <div class="stat-box"><div class="stat-val">${st.hits}</div><div class="stat-lbl">被安打</div></div>
                <div class="stat-box"><div class="stat-val">${st.swings}</div><div class="stat-lbl">揮棒</div></div>
            </div>

            <div class="section-title">⚾ 球種分析</div>
            ${typeTable}

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:0;">
                <div>
                    <div class="section-title">🎯 好球帶熱區</div>
                    ${_zoneHtml(st.zoneMap, st.zoneMax)}
                </div>
                <div>
                    <div class="section-title">📐 打擊結果統計</div>
                    <table><tr><th>結果</th><th>次數</th><th>佔比</th></tr>${outcomeRows}</table>
                </div>
            </div>

            <div class="section-title">👥 左右打者分析</div>
            ${splitTable}

            <div class="section-title">📈 球數傾向分析</div>
            ${countHtml}

            ${gamesBlock}

            <hr class="sep">
            <div class="section-title">📋 逐球明細（共 ${allPitches.length} 球）</div>
            ${pitchLog}

            <div class="footer">產生時間：${new Date().toLocaleString('zh-TW')} ｜ 中華台北投手情蒐系統</div>
            </body></html>`;

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (w) { setTimeout(() => { w.print(); URL.revokeObjectURL(url); }, 900); }
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
        // 管理員顯示建立球隊按鈕
        const createBtn = document.getElementById('createTeamBtn');
        if (createBtn && currentTeamCode === 'ADMIN') createBtn.style.display = 'block';
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
        // If legacy admin was logged in (no Firebase Auth session), show authOverlay directly
        const ao = document.getElementById('authOverlay');
        if (ao) ao.style.display = 'flex';
        const msp = document.getElementById('modeSelectionPage');
        if (msp) msp.style.display = 'none';
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
                    try { localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData)); } catch(e) {}
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
        loadFromLocalStorage();
        updateTeamList();
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('newTeamDate').value = today;
        updateScoreboard();
        renderCountLights();
        renderBases();
        setupTeamListDelegation();
        // checkForUpdate 已在 SW 註冊時直接呼叫，此處不重複觸發
    }

    // injectDemoData 已移除，上線版禁止自動覆蓋真實資料
    function injectDemoData() {
        console.warn('[injectDemoData] 已停用。如需測試資料請手動於 Firebase Console 新增。');
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
        try { localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData)); } catch(e) {}
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

        const pitcherA = { name: nameA, number: numberA, hand: handA, role: roleA, style: styleA, pitches: [], score: getDefaultScore() };
        allData.teams[teamIndex].pitchers.push(pitcherA);

        if (nameB) {
            const pitcherB = { name: nameB, number: numberB, hand: handB, role: roleB, style: styleB, pitches: [], score: getDefaultScore() };
            allData.teams[teamIndex].pitchers.push(pitcherB);
        }

        expandedTeams.add(teamIndex);
        // 同時展開該球隊所屬的賽事群組
        const gameName = allData.teams[teamIndex].gameName || '未分類';
        expandedGames.add(gameName);
        updateTeamList();
        saveToLocalStorage();
        saveToFirebase();
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
        saveToFirebase();
        closeSinglePitcherModal();
        // 清空欄位
        document.getElementById('singlePitcherName').value = '';
        document.getElementById('singlePitcherNumber').value = '';
        document.getElementById('singlePitchHand').value = '';
        alert(`✅ 投手「${name}」已新增！`);
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
        expandedTeams.add(teamIndex);

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

        updateSlotDisplay();
        updatePitchLog();
        updateStats();
        updateScoreboard();
        saveToLocalStorage();

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
        ['A','B'].forEach(slot => {
            const s = slot === 'A' ? slotA : slotB;
            const contentEl = document.getElementById('slot' + slot + 'Content');
            const slotEl = document.getElementById('slot' + slot);
            slotEl.classList.toggle('active-slot', activeSlot === slot);

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
        updateTeamList(); updateSlotDisplay(); updateStats(); updatePitchLog(); saveToLocalStorage();
    }

    // ====== LINEUP MANAGEMENT ======
    // index 0 unused; 1-9 = batting order slots
    let lineup = Array.from({length: 10}, () => ({ number: '', name: '', hand: '右打' }));

    function openLineupModal() {
        const container = document.getElementById('lineupRows');
        container.innerHTML = '';
        for (let i = 1; i <= 9; i++) {
            const p = lineup[i];
            const row = document.createElement('div');
            row.style.cssText = 'display:grid;grid-template-columns:28px 1fr 1fr 1fr;gap:6px;margin-bottom:8px;align-items:center;';
            row.innerHTML = `
                <div style="font-size:13px;font-weight:900;color:var(--ct-blue-dark);text-align:center;">${i}</div>
                <input type="number" inputmode="numeric" placeholder="背號" value="${p.number}" data-order="${i}" data-field="number"
                    style="padding:7px 6px;border:1.5px solid #d1d5db;border-radius:7px;font-size:13px;width:100%;box-sizing:border-box;text-align:center;"
                    onkeydown="if(event.key==='Enter')this.blur()">
                <input type="text" placeholder="姓名" value="${p.name}" data-order="${i}" data-field="name"
                    style="padding:7px 6px;border:1.5px solid #d1d5db;border-radius:7px;font-size:13px;width:100%;box-sizing:border-box;"
                    onkeydown="if(event.key==='Enter')this.blur()">
                <select data-order="${i}" data-field="hand"
                    style="padding:7px 4px;border:1.5px solid #d1d5db;border-radius:7px;font-size:12px;width:100%;box-sizing:border-box;">
                    <option value="右打" ${p.hand==='右打'?'selected':''}>右打</option>
                    <option value="左打" ${p.hand==='左打'?'selected':''}>左打</option>
                </select>`;
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

    const OUT_OUTCOMES = ['滾地球出局','飛球出局','平飛球出局','三振','趁傳出局','雙殺','出局','高飛犧牲打','犧牲觸擊'];
    // 打席結束（進入下一打者）的結果清單
    const PA_ENDING = ['滾地球出局','飛球出局','平飛球出局','高飛犧牲打','犧牲觸擊','三振','不死三振',
        '內野安打','一壘安打','二壘安打','三壘安打','全壘打','保送','觸身球','野選','趁傳出局','失誤','違規打擊','Push'];

    function toggleOutcome(btn) {
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

        const speedVal = document.getElementById('pitchSpeed').value;
        currentPitch.speed = speedVal ? parseInt(speedVal) : null;
        currentPitch.note = document.getElementById('pitchNote').value.trim() || null;
        currentPitch.timestamp = new Date().toISOString();
        currentPitch.basesSnapshot = [...gameState.bases]; // [1b, 2b, 3b]
        currentPitch.runnersOn = gameState.bases.some(b => b);

        // Compute count before this pitch
        const prev = allData.teams[currentTeam].pitchers[currentPitcher].pitches;
        const countBefore = computeCountBefore(prev, batterNumber, batterOrder);
        currentPitch.balls = countBefore.balls;
        currentPitch.strikes = countBefore.strikes;

        // For legacy compatibility, set outcome as primary outcome
        currentPitch.outcome = currentPitch.outcomes.length > 0 ? currentPitch.outcomes[0] : null;

        allData.teams[currentTeam].pitchers[currentPitcher].pitches.push({...currentPitch});

        // Sync to pitcherDB (cumulative across games)
        const pitcher = allData.teams[currentTeam].pitchers[currentPitcher];
        syncPitchToDB({...currentPitch}, currentTeam, pitcher.name, pitcher.number);

        // Update game state counts
        updateGameStateFromPitch(currentPitch);

        // 打席結束 → 自動前進棒次
        const hasEndingOutcome = currentPitch.outcomes.some(o => PA_ENDING.includes(o));
        if (hasEndingOutcome) {
            const curOrder = parseInt(batterOrder) || 0;
            if (curOrder >= 1 && curOrder <= 9) {
                const nextOrder = curOrder >= 9 ? 1 : curOrder + 1;
                document.getElementById('batterOrder').value = nextOrder;
                autoFillBatterFromOrder(nextOrder);
            }
            gameState.strikes = 0;
            gameState.balls = 0;
            renderCountLights();
        }

        updateSlotDisplay();
        updatePitchLog();
        updateStats();
        saveToLocalStorage();
        saveToFirebase();
        document.querySelectorAll('.pitch-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.zone-cell').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.outcome-btn').forEach(b => b.classList.remove('selected'));
        ['foulBtn','swingBtn','wildBtn'].forEach(id => document.getElementById(id).classList.remove('active'));
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
            outcomes: [], outcome: null, wild: false, foul: false, swing: false, pinchHit: false
        };
    }

    function adjustBatterOrder(delta) {
        const el = document.getElementById('batterOrder');
        const cur = parseInt(el.value) || 0;
        const next = cur + delta;
        const clamped = next < 1 ? 9 : next > 9 ? 1 : next;
        el.value = clamped;
        autoFillBatterFromOrder(clamped);
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
        const isPA  = outcomes.some(o => ['一壘安打','二壘安打','三壘安打','全壘打','內野安打',
            '保送','觸身球','野選','失誤','不死三振','Push'].includes(o));

        if (isOut) {
            gameState.outs++;
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
                gameState.strikes = 0; gameState.balls = 0;
                renderCountLights(); renderBases();
                updateScoreboard();
            }
        } else if (isPA) {
            gameState.strikes = 0; gameState.balls = 0;
            // Apply base running + auto score
            const { newBases, runsScored } = applyBaseRunning(gameState.bases, outcomes);
            gameState.bases = newBases;
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
        gameState.bases = [false, false, false];
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
        if (success) {
            // Advance the leading runner forward one base
            if (gameState.bases[2]) { // runner on 3rd - scores, remove
                gameState.bases[2] = false;
            } else if (gameState.bases[1]) { // runner on 2nd -> 3rd
                gameState.bases[1] = false;
                gameState.bases[2] = true;
            } else if (gameState.bases[0]) { // runner on 1st -> 2nd
                gameState.bases[0] = false;
                gameState.bases[1] = true;
            }
        } else {
            // Steal failed - leading runner out, add out
            if (gameState.bases[0]) gameState.bases[0] = false;
            else if (gameState.bases[1]) gameState.bases[1] = false;
            else if (gameState.bases[2]) gameState.bases[2] = false;
            gameState.outs++;
            if (gameState.outs >= 3) {
                gameState.outs = 0;
                gameState.bases = [false, false, false];
                if (gameState.half === '上') { gameState.half = '下'; }
                else { gameState.half = '上'; gameState.inning++; }
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
            gameState = { strikes:0, balls:0, outs:0, bases:[false,false,false], half:'上', inning:1 };
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
            gameState.bases = [false, false, false];
            renderCountLights(); renderBases();
        }
        updateScoreboard(); saveToLocalStorage();
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
            return;
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
            listEl.innerHTML = allEntries.map(([z,c])=>`<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f3f4f6;"><span style="font-weight:700;color:${z.startsWith('B')?'#065f46':'#92400e'};">${z}</span><span style="color:var(--ct-red);font-weight:700;">${c}</span></div>`).join('') || '-';
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
        const allTypes = ['快速球','上飄球','下墜球','變速球','內曲','外曲'];
        const changeUpTypes = ['下墜球','變速球','內曲','外曲'];
        const used = allTypes.filter(t => pitches.some(p => p.type===t));
        if (used.length === 0) { insight.innerHTML = ''; return; }
        insight.innerHTML = `<div style="background:#f0f9ff;border:2px solid var(--ct-blue);border-radius:8px;padding:10px;">
            <strong style="color:var(--ct-blue-dark);">🔄 各球種投球傾向（變化球標示）</strong>
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">
            ${used.map(type=>{
                const tp = pitches.filter(p=>p.type===type);
                const strikeRate = tp.length ? ((tp.filter(p=>p.result==='好球').length/tp.length)*100).toFixed(0) : 0;
                const isBreaking = changeUpTypes.includes(type);
                return `<span style="background:${isBreaking?'#7c3aed':'var(--ct-blue-dark)'};color:white;padding:4px 10px;border-radius:20px;font-size:13px;font-weight:700;">
                    ${type}${isBreaking?' 🔄':''}  好球率${strikeRate}%
                </span>`;
            }).join('')}
            </div>
        </div>`;
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
        if (pitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無資料</p>'; return; }

        // Zone definitions (from pitcher's view)
        // RHB inner: 1,4,7 / outer: 3,6,9
        // LHB inner: 3,6,9 / outer: 1,4,7
        const innerZonesRHB = ['1','4','7'];
        const outerZonesRHB = ['3','6','9'];
        const innerZonesLHB = ['3','6','9'];
        const outerZonesLHB = ['1','4','7'];

        // Rise types vs sink types
        const riseTypes = ['快速球','上飄球'];
        const sinkTypes = ['下墜球','內曲','外曲'];
        const changeupTypes = ['變速球'];

        const calc = (ps, innerZones, outerZones) => {
            const total = ps.length;
            if (total === 0) return null;
            const strikePs = ps.filter(p => !String(p.zone).startsWith('B'));
            const inner = strikePs.filter(p => innerZones.includes(String(p.zone))).length;
            const outer = strikePs.filter(p => outerZones.includes(String(p.zone))).length;
            const mid = strikePs.length - inner - outer;
            const rise = ps.filter(p => riseTypes.includes(p.type)).length;
            const sink = ps.filter(p => sinkTypes.includes(p.type)).length;
            const changeup = ps.filter(p => changeupTypes.includes(p.type)).length;
            const pct = n => total > 0 ? ((n/total)*100).toFixed(1)+'%' : '-';
            return { total, inner, outer, mid, rise, sink, changeup, pct };
        };

        const rhb = calc(pitches.filter(p => p.batterHand === '右打'), innerZonesRHB, outerZonesRHB);
        const lhb = calc(pitches.filter(p => p.batterHand === '左打'), innerZonesLHB, outerZonesLHB);

        const renderRow = (label, d, color) => {
            if (!d) return `<tr><td colspan="8" style="color:#9ca3af;font-size:12px;padding:8px;">${label}：尚無資料</td></tr>`;
            return `<tr style="background:${color}10;">
                <td style="font-weight:700;color:${color};padding:8px 10px;">${label}</td>
                <td style="text-align:center;font-weight:700;">${d.total}</td>
                <td style="text-align:center;color:#dc2626;font-weight:700;">${d.pct(d.inner)}</td>
                <td style="text-align:center;color:#2563eb;font-weight:700;">${d.pct(d.outer)}</td>
                <td style="text-align:center;color:#6b7280;">${d.pct(d.mid)}</td>
                <td style="text-align:center;color:#d97706;font-weight:700;">${d.pct(d.rise)}</td>
                <td style="text-align:center;color:#7c3aed;font-weight:700;">${d.pct(d.sink)}</td>
                <td style="text-align:center;color:#0891b2;font-weight:700;">${d.pct(d.changeup)}</td>
            </tr>`;
        };

        div.innerHTML = `
        <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
                <tr style="background:var(--ct-blue-dark);color:white;">
                    <th style="padding:8px 10px;text-align:left;">打者</th>
                    <th style="padding:8px;text-align:center;">投球數</th>
                    <th style="padding:8px;text-align:center;">內角%</th>
                    <th style="padding:8px;text-align:center;">外角%</th>
                    <th style="padding:8px;text-align:center;">中間%</th>
                    <th style="padding:8px;text-align:center;">↑上飄%</th>
                    <th style="padding:8px;text-align:center;">↓下墜%</th>
                    <th style="padding:8px;text-align:center;">🔵變速%</th>
                </tr>
            </thead>
            <tbody>
                ${renderRow('👉 對右打 (RHB)', rhb, '#dc2626')}
                ${renderRow('👈 對左打 (LHB)', lhb, '#2563eb')}
            </tbody>
        </table>
        </div>
        <p style="font-size:11px;color:#9ca3af;margin-top:6px;">內角定義：對RHB為1/4/7區，對LHB為3/6/9區。上飄：快速球/上飄球；下墜：下墜球/內曲/外曲；變速球獨立統計。</p>`;
    }

    // ====== 首球習慣分析 ======
    function updateFirstPitchAnalysis(pitches) {
        const div = document.getElementById('firstPitchAnalysis');
        if (!div) return;
        if (pitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無資料</p>'; return; }

        // Find first pitch of each PA: pitch where balls=0 and strikes=0
        const firstPitches = pitches.filter(p => (p.balls || 0) === 0 && (p.strikes || 0) === 0);
        if (firstPitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無首球資料（需記錄球數）</p>'; return; }

        const typeCount = {};
        firstPitches.forEach(p => { if (p.type) typeCount[p.type] = (typeCount[p.type]||0)+1; });
        const sorted = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
        const total = firstPitches.length;
        const pct = n => ((n/total)*100).toFixed(1);

        const top1 = sorted[0] || null;
        const top2 = sorted[1] || null;

        div.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;">
            <div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:2px solid var(--ct-yellow);border-radius:8px;padding:12px;">
                <div style="font-size:11px;color:#92400e;font-weight:700;margin-bottom:4px;">🥇 首球最高佔比球種</div>
                <div style="font-size:20px;font-weight:900;color:var(--ct-blue-dark);font-family:'Oswald','Noto Sans TC',sans-serif;">
                    ${top1 ? top1[0] + ' — ' + pct(top1[1]) + '%' : '尚無資料'}
                </div>
                ${top1 ? `<div style="font-size:12px;color:#78350f;margin-top:2px;">${top1[1]} 次首球 / 共 ${total} 個打席</div>` : ''}
            </div>
            <div style="background:linear-gradient(135deg,#d1fae5,#a7f3d0);border:2px solid var(--ct-green);border-radius:8px;padding:12px;">
                <div style="font-size:11px;color:#065f46;font-weight:700;margin-bottom:4px;">🥈 首球次高佔比球種</div>
                <div style="font-size:20px;font-weight:900;color:var(--ct-blue-dark);font-family:'Oswald','Noto Sans TC',sans-serif;">
                    ${top2 ? top2[0] + ' — ' + pct(top2[1]) + '%' : '僅有一種球種'}
                </div>
                ${top2 ? `<div style="font-size:12px;color:#064e3b;margin-top:2px;">${top2[1]} 次首球</div>` : ''}
            </div>
            ${sorted.length > 2 ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;">
                <div style="font-size:12px;font-weight:700;color:var(--ct-blue-dark);margin-bottom:6px;">全部首球球種分布</div>
                ${sorted.map(([type,cnt]) => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
                    <span style="font-weight:700;">${type}</span>
                    <span style="color:var(--ct-red);font-weight:700;">${cnt} 次（${pct(cnt)}%）</span>
                </div>`).join('')}
            </div>` : ''}
        </div>`;
    }

    // ====== PATTERN ANALYSIS ======
    function updatePatternAnalysis(pitches) {
        const div = document.getElementById('patternAnalysis');
        div.innerHTML = '';
        if (pitches.length === 0) { div.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:16px;">尚無資料</p>'; return; }
        const typeCount = {};
        pitches.forEach(p => { typeCount[p.type] = (typeCount[p.type]||0)+1; });
        const sortedTypes = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
        const total = pitches.length;
        const head1 = document.createElement('h3');
        head1.textContent = '🎯 常用球種比例';
        head1.style.color = 'var(--ct-blue-dark)';
        div.appendChild(head1);
        sortedTypes.forEach(([type,cnt]) => {
            const item = document.createElement('div');
            item.className = 'pattern-item';
            item.innerHTML = `<span style="font-size:16px;font-weight:900;color:var(--ct-blue-dark);font-family:'Oswald','Noto Sans TC',sans-serif;">${type}</span><span style="color:var(--ct-red);font-weight:700;">${cnt} 球 / ${((cnt/total)*100).toFixed(1)}%</span>`;
            div.appendChild(item);
        });
        if (pitches.length >= 2) {
            const head2 = document.createElement('h3');
            head2.textContent = '🔗 常見配球模式';
            head2.style.cssText = 'color:var(--ct-blue-dark);margin-top:12px;';
            div.appendChild(head2);
            const sequences = {};
            for (let i=1; i<pitches.length; i++) {
                const seq = `${pitches[i-1].type} → ${pitches[i].type}`;
                sequences[seq] = (sequences[seq]||0)+1;
            }
            Object.entries(sequences).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([seq,cnt]) => {
                const item = document.createElement('div');
                item.className = 'pattern-item';
                item.innerHTML = `<span style="font-size:14px;font-weight:700;color:var(--ct-blue-dark);">${seq}</span><span style="color:var(--ct-red);font-weight:700;">${cnt} 次</span>`;
                div.appendChild(item);
            });
        }
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

    function computeInnings(pitches) {
        const outs = pitches.filter(p => (p.outcomes||[p.outcome]).some(o=>o&&(o.includes('出局')||o==='三振'||o==='不死三振'))).length;
        return outs/3;
    }

    function updatePitchEffectiveness(pitches) {
        const div = document.getElementById('pitchEffectiveness');
        div.innerHTML = '';
        if (pitches.length===0) { div.innerHTML='<p style="color:#9ca3af;text-align:center;padding:16px;">尚無資料</p>'; return; }
        const allTypes = ['快速球','上飄球','下墜球','變速球','內曲','外曲'];
        const usedTypes = allTypes.filter(t => pitches.some(p=>p.type===t));
        const inningsTotal = computeInnings(pitches);
        const earnedRuns = pitches.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='全壘打')).length;
        const totalWalks = pitches.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='保送')).length;
        const totalHits = pitches.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
        const eraTotal = inningsTotal>0 ? ((earnedRuns*7)/inningsTotal).toFixed(2) : '--';
        const whipTotal = inningsTotal>0 ? ((totalHits+totalWalks)/inningsTotal).toFixed(2) : '--';
        usedTypes.forEach(type => {
            const tp = pitches.filter(p=>p.type===type);
            const total=tp.length;
            const strikes=tp.filter(p=>p.result==='好球').length;
            const balls=tp.filter(p=>p.result==='壞球').length;
            const swings=tp.filter(p=>p.swing||p.result==='揮空').length;
            const wilds=tp.filter(p=>p.wild).length;
            const hits=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'))).length;
            const ks=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='三振'||o==='不死三振')).length;
            const walks=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o==='保送')).length;
            const atBats=tp.filter(p=>(p.outcomes||[p.outcome]).some(o=>o&&(o.includes('安打')||o==='全壘打'||o.includes('出局')||o==='三振'))).length;
            const strikeRate=((strikes/total)*100).toFixed(1);
            const ballRate=((balls/total)*100).toFixed(1);
            const swingRate=((swings/total)*100).toFixed(1);
            const wildRate=((wilds/total)*100).toFixed(1);
            const kRate=atBats>0?((ks/atBats)*100).toFixed(1):'0.0';
            const hitRate=atBats>0?(hits/atBats).toFixed(3):'.000';
            const speeds=tp.filter(p=>p.speed).map(p=>p.speed);
            const avgSpeed=speeds.length>0?(speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1):'N/A';
            const ballAlert=parseFloat(ballRate)>=35;
            const wildAlert=parseFloat(wildRate)>=5;
            const card=document.createElement('div');
            card.className='pitch-effect-card';
            card.innerHTML=`
                <div class="pitch-effect-header">
                    <div class="pitch-effect-name">${type}</div>
                    <div class="pitch-effect-count">共 ${total} 球 · 平均 ${avgSpeed}</div>
                </div>
                <div class="pitch-effect-grid">
                    <div class="pitch-effect-stat"><div class="pitch-effect-stat-label">好球率</div><div class="pitch-effect-stat-value" style="color:#b45309;">${strikeRate}%</div></div>
                    <div class="pitch-effect-stat" style="border-left-color:${ballAlert?'#dc2626':'#10b981'};"><div class="pitch-effect-stat-label">壞球率</div><div class="pitch-effect-stat-value" style="color:${ballAlert?'#dc2626':'#065f46'};">${ballRate}%${ballAlert?' ⚠':''}</div></div>
                    <div class="pitch-effect-stat"><div class="pitch-effect-stat-label">揮空率</div><div class="pitch-effect-stat-value">${swingRate}%</div></div>
                    <div class="pitch-effect-stat" style="border-left-color:${wildAlert?'#dc2626':'#f97316'};"><div class="pitch-effect-stat-label">暴投率</div><div class="pitch-effect-stat-value" style="color:${wildAlert?'#dc2626':'#c2410c'};">${wildRate}%${wildAlert?' ⚠':''}</div></div>
                    <div class="pitch-effect-stat"><div class="pitch-effect-stat-label">三振率</div><div class="pitch-effect-stat-value">${kRate}%</div></div>
                    <div class="pitch-effect-stat"><div class="pitch-effect-stat-label">被打擊率</div><div class="pitch-effect-stat-value">${hitRate}</div></div>
                </div>`;
            div.appendChild(card);
        });
        // Summary
        const sumCard=document.createElement('div');
        sumCard.className='pitch-effect-card';
        sumCard.style.borderLeftColor='var(--ct-red)';
        sumCard.innerHTML=`<div class="pitch-effect-header"><div class="pitch-effect-name">全體</div><div class="pitch-effect-count">總投球 ${pitches.length} 球 · 估算局數 ${inningsTotal.toFixed(1)}</div></div><div class="pitch-effect-grid"><div class="pitch-effect-stat"><div class="pitch-effect-stat-label">ERA (估)</div><div class="pitch-effect-stat-value" style="color:var(--ct-red);">${eraTotal}</div></div><div class="pitch-effect-stat"><div class="pitch-effect-stat-label">WHIP</div><div class="pitch-effect-stat-value" style="color:var(--ct-red);">${whipTotal}</div></div></div><p style="font-size:11px;color:#6b7280;margin-top:5px;">※ ERA/WHIP 為依目前資料的估算值</p>`;
        div.appendChild(sumCard);
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
        const twoStrike = pitches.filter(p => (p.strikes || 0) === 2);
        if (twoStrike.length === 0) {
            div.innerHTML = '<p style="color:#9ca3af;padding:10px;">尚無兩好球資料（需記錄球數）</p>';
            return;
        }

        const rhb = twoStrike.filter(p => p.batterHand === '右打');
        const lhb = twoStrike.filter(p => p.batterHand === '左打');

        const buildSection = (ps, label, color) => {
            if (ps.length === 0) return `<div style="color:#9ca3af;font-size:12px;padding:8px;">尚無${label}資料</div>`;
            const total = ps.length;
            const pct = n => ((n/total)*100).toFixed(1);

            // Top types
            const typeCount = {};
            ps.forEach(p => { if (p.type) typeCount[p.type] = (typeCount[p.type]||0)+1; });
            const topTypes = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).slice(0,3);

            // Top zones
            const zoneCount = {};
            ps.forEach(p => { if (p.zone) zoneCount[p.zone] = (zoneCount[p.zone]||0)+1; });
            const topZones = Object.entries(zoneCount).sort((a,b)=>b[1]-a[1]).slice(0,3);

            const typeHTML = topTypes.map(([type,cnt],i) =>
                `<div style="display:flex;justify-content:space-between;padding:5px 8px;background:${i===0?'#fef3c7':'#f9fafb'};border-radius:5px;margin-bottom:3px;font-size:13px;">
                    <span style="font-weight:700;color:var(--ct-blue-dark);">${i===0?'🥇 ':''}${type}</span>
                    <span style="font-weight:700;color:var(--ct-red);">${cnt}球 ${pct(cnt)}%</span>
                </div>`).join('');

            const zoneHTML = topZones.map(([zone,cnt],i) => {
                const isStrike = !zone.startsWith('B');
                return `<div style="display:flex;justify-content:space-between;padding:5px 8px;background:${i===0?(isStrike?'#fef3c7':'#d1fae5'):'#f9fafb'};border-radius:5px;margin-bottom:3px;font-size:13px;">
                    <span style="font-weight:700;color:${isStrike?'#92400e':'#065f46'};">${i===0?'🎯 ':''}位置${zone}</span>
                    <span style="font-weight:700;color:var(--ct-red);">${cnt}球 ${pct(cnt)}%</span>
                </div>`;
            }).join('');

            return `
                <div style="border:2px solid ${color};border-radius:8px;padding:10px;background:${color}08;">
                    <div style="font-size:13px;font-weight:900;color:${color};margin-bottom:8px;">${label} <span style="font-size:11px;font-weight:400;color:#6b7280;">（${total}球）</span></div>
                    <div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:4px;">球種</div>
                    ${typeHTML || '<div style="color:#9ca3af;font-size:12px;">無資料</div>'}
                    <div style="font-size:11px;font-weight:700;color:#374151;margin:8px 0 4px;">進壘位置</div>
                    ${zoneHTML || '<div style="color:#9ca3af;font-size:12px;">無資料</div>'}
                </div>`;
        };

        div.innerHTML = `
        <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">共 ${twoStrike.length} 球兩好球紀錄（右打 ${rhb.length} / 左打 ${lhb.length}）</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            ${buildSection(rhb, '👉 對右打 (RHB)', '#dc2626')}
            ${buildSection(lhb, '👈 對左打 (LHB)', '#2563eb')}
        </div>`;
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
                try { localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData)); } catch(e) {}
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
                layout: { padding: 72 },
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
        e.target.classList.add('active');
        if (tab==='record') document.getElementById('recordTab').classList.add('active');
        else if (tab==='stats') { document.getElementById('statsTab').classList.add('active'); updateStats(); }
        else if (tab==='analysis') { document.getElementById('analysisTab').classList.add('active'); updateStats(); }
        else if (tab==='compare') { document.getElementById('compareTab').classList.add('active'); updateCompare(); }
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

        let typeHTML = '';
        allTypes.forEach(type => {
            const cntA = typesA[type] || 0;
            const cntB = typesB[type] || 0;
            const pctA = ((cntA/totalA)*100).toFixed(1);
            const pctB = ((cntB/totalB)*100).toFixed(1);
            typeHTML += `<div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <span style="font-weight:700;color:var(--ct-blue-dark);font-size:14px;">${type}</span>
                    <span style="font-size:12px;color:#6b7280;">${cntA}球 vs ${cntB}球</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:6px;align-items:center;">
                    <div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
                            <span style="color:var(--ct-gold);font-weight:700;">A</span><span>${pctA}%</span>
                        </div>
                        <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;">
                            <div style="height:100%;width:${pctA}%;background:linear-gradient(90deg,var(--ct-blue-dark),var(--ct-blue));border-radius:5px;transition:width 0.4s;"></div>
                        </div>
                    </div>
                    <div style="font-size:11px;color:#9ca3af;text-align:center;min-width:28px;">vs</div>
                    <div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
                            <span>${pctB}%</span><span style="color:#aaa;font-weight:700;">B</span>
                        </div>
                        <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;">
                            <div style="height:100%;width:${pctB}%;background:linear-gradient(90deg,#444,#666);border-radius:5px;transition:width 0.4s;margin-left:auto;"></div>
                        </div>
                    </div>
                </div>
            </div>`;
        });
        document.getElementById('comparePitchTypes').innerHTML = typeHTML || '<p style="color:#9ca3af;">尚無球種資料</p>';

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

        // ---- Effectiveness ----
        const allPitchTypes = PITCH_ORDER.filter(t => pitchesA.some(p=>p.type===t) || pitchesB.some(p=>p.type===t));
        let effHTML = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="background:linear-gradient(135deg,var(--ct-blue-dark),var(--ct-blue));color:white;">
                <th style="padding:8px;text-align:left;">球種</th>
                <th style="padding:8px;text-align:center;color:var(--ct-gold);">${shortA} 好球率</th>
                <th style="padding:8px;text-align:center;color:var(--ct-gold);">${shortA} 揮空率</th>
                <th style="padding:8px;text-align:center;color:#ccc;">${shortB} 好球率</th>
                <th style="padding:8px;text-align:center;color:#ccc;">${shortB} 揮空率</th>
            </tr></thead><tbody>`;
        allPitchTypes.forEach((type, i) => {
            const tpA = pitchesA.filter(p=>p.type===type);
            const tpB = pitchesB.filter(p=>p.type===type);
            const srA = tpA.length ? ((tpA.filter(p=>p.result==='好球').length/tpA.length)*100).toFixed(1)+'%' : '—';
            const swA = tpA.length ? ((tpA.filter(p=>p.swing).length/tpA.length)*100).toFixed(1)+'%' : '—';
            const srB = tpB.length ? ((tpB.filter(p=>p.result==='好球').length/tpB.length)*100).toFixed(1)+'%' : '—';
            const swB = tpB.length ? ((tpB.filter(p=>p.swing).length/tpB.length)*100).toFixed(1)+'%' : '—';
            effHTML += `<tr style="background:${i%2===0?'#f9fafb':'white'};">
                <td style="padding:8px 10px;font-weight:700;color:${PITCH_COLORS[type]||'var(--ct-blue-dark)'};">${type}</td>
                <td style="padding:8px;text-align:center;">${srA}</td>
                <td style="padding:8px;text-align:center;">${swA}</td>
                <td style="padding:8px;text-align:center;">${srB}</td>
                <td style="padding:8px;text-align:center;">${swB}</td>
            </tr>`;
        });
        effHTML += '</tbody></table></div>';
        document.getElementById('compareEffectiveness').innerHTML = effHTML || '<p style="color:#9ca3af;">尚無資料</p>';
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
    firebase.initializeApp(firebaseConfig);
    const db = firebase.database();
    // 啟用 Firebase 離線持久化（讓 Firebase SDK 自行處理離線快取）
    db.ref('.info/connected'); // 觸發連線監控初始化

    // 動態 DB_KEY：根據球隊代碼隔離數據
    let DB_KEY = 'pitcherScoutData'; // 預設，登入後會更新為 teams/{teamCode}/data
    let lastSaveTime = 0;
    let firebaseListening = false;
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
            teams: JSON.parse(JSON.stringify(data.teams || []))
        };
        return clean;
    }

    // ====== MULTI-TENANT DATA HELPERS ======
    // Returns the correct Firebase ref depending on auth mode:
    //   New SaaS:  USER_TEAM_REF.child('pitchers')  → teams/{teamCode}/pitchers
    //   Legacy:    db.ref(DB_KEY)                   → teams/{teamCode}/data
    function getDataRef() {
        return USER_TEAM_REF ? USER_TEAM_REF.child('pitchers') : db.ref(DB_KEY);
    }

    // Returns the payload to write: new mode stores raw teams array; legacy wraps in {teams:[]}
    function getFirebasePayload() {
        if (USER_TEAM_REF) return JSON.parse(JSON.stringify(allData.teams || []));
        return sanitizeForFirebase(allData);
    }

    // Normalises snapshot value from either storage format into a clean teams array
    function normalizeTeamsData(raw) {
        if (!raw) return null;
        let teams;
        if (USER_TEAM_REF) {
            // New path: snapshot IS the teams array/object
            teams = Array.isArray(raw) ? raw : Object.values(raw);
        } else {
            // Legacy path: snapshot = { teams: [...] }
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
        try { localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData)); } catch(e) {}
    }

    function forceSyncToFirebase() {
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
        getDataRef().on('value', snap => {
            if (Date.now() - lastSaveTime < 3000) return; // 忽略自己剛寫入觸發的更新
            const teams = normalizeTeamsData(snap.val());
            if (!teams) return;
            allData.teams = teams;
            allData.pitcherDB = {};
            rebuildPitcherDB();
            try { localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData)); } catch(e) {}
            updateTeamList(); updateSlotDisplay(); updatePitchLog(); updateStats(); updateScoreboard();
            setSyncStatus(true);
        });
    }

    function saveToFirebase() {
        lastSaveTime = Date.now();
        saveToLocalStorage();
        try {
            getDataRef().set(getFirebasePayload())
                .then(() => { setSyncStatus(true); pendingSync = false; })
                .catch(e => {
                    console.warn('[Firebase] 寫入失敗，標記待同步:', e.code);
                    pendingSync = true;
                    setSyncStatus(false);
                });
        } catch(e) {
            console.warn('[Firebase] 離線，資料已存本地，待連線後自動同步');
            pendingSync = true;
            setSyncStatus(false);
        }
    }

    function pullFromFirebase() {
        getDataRef().once('value')
            .then(snap => {
                const teams = normalizeTeamsData(snap.val());
                if (!teams || teams.length === 0) {
                    alert('雲端目前無資料，請先按「☁️ 上傳至雲端」把本機數據上傳。');
                    return;
                }
                if (!confirm(`雲端有 ${teams.length} 筆球隊資料，要覆蓋本機嗎？`)) return;
                allData.teams = teams;
                allData.pitcherDB = {};
                rebuildPitcherDB();
                try { localStorage.setItem('chineseTaipeiPitcherData', JSON.stringify(allData)); } catch(e) {}
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
        initFirebaseAuth();
    });

    // ====== FIREBASE AUTH（新多租戶 SaaS 入口）======

    function initFirebaseAuth() {
        firebase.auth().onAuthStateChanged(async (user) => {
            const ao = document.getElementById('authOverlay');
            const msp = document.getElementById('modeSelectionPage');
            if (!user) {
                // 未登入：顯示 authOverlay
                userSession = null;
                USER_TEAM_REF = null;
                if (ao) ao.style.display = 'flex';
                if (msp) msp.style.display = 'none';
                return;
            }
            // 登入成功：取得使用者權限
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

        // 管理員本地驗證
        if (code === ADMIN_CODE) {
            const inputHash = await _sha256(pw);
            if (inputHash === ADMIN_PW_HASH) {
                currentTeamCode = 'ADMIN';
                await _cacheCredential(code, 'scout', pw);
                enterSystem('scout');
            } else {
                errEl.textContent = '❌ 密碼錯誤';
            }
            return;
        }

        // 先試離線快取
        if (await _checkCachedCredential(code, 'scout', pw)) {
            currentTeamCode = code;
            try { localStorage.setItem('lastTeamCode', code); } catch(e) {}
            enterSystem('scout');
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
            if (!config) { errEl.textContent = '❌ 登入代碼不存在，請確認後再試'; return; }
            const stored = config.scoutPw;
            const inputHash = await _sha256(pw);
            const matches = _isHashed(stored) ? inputHash === stored : pw === stored;
            if (matches) {
                currentTeamCode = code;
                await _cacheCredential(code, 'scout', pw);
                try { localStorage.setItem('lastTeamCode', code); } catch(e) {}
                enterSystem('scout');
            } else {
                errEl.textContent = '❌ 密碼錯誤，請再試一次';
                document.getElementById('authPassword').value = '';
                document.getElementById('authPassword').focus();
            }
        } catch(e) {
            if (await _checkCachedCredential(code, 'scout', pw)) {
                currentTeamCode = code;
                enterSystem('scout');
            } else {
                errEl.textContent = '❌ 連線失敗，且無離線快取';
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
            enterSystem('view');
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
            enterSystem('view');
        } catch(e) {
            errEl.textContent = '❌ 連線失敗，請稍後再試';
        }
    }

    // 從模式選擇頁登出
    function doAuthLogout() {
        logout();
    }

    // 開發者專用：顯示舊版管理員登入表單
    function showLegacyLogin() {
        const ao = document.getElementById('authOverlay');
        const ls = document.getElementById('loginScreen');
        if (ao) ao.style.display = 'none';
        if (ls) ls.style.display = 'flex';
    }

    // 點擊「投手情蒐模式」按鈕後進入系統
    function enterPitcherMode() {
        controlUserRolePermissions(userRole);
        const legacyRole = (userRole === 'viewer') ? 'view' : 'scout';
        enterSystem(legacyRole);
    }

    // 頁面初始化（不依賴 Auth，僅載入本機資料與 UI）
    init();
