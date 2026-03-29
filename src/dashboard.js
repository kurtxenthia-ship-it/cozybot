"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const CUSTOM_REPLIES_FILE = path.join(__dirname, "../data/custom_replies.json");
const IMAGE_REPLIES_FILE  = path.join(__dirname, "../data/image_replies.json");
const BOT_CONFIG_FILE     = path.join(__dirname, "../data/bot_config.json");
const FBSTATE_FILE        = path.join(__dirname, "../data/fbstate.json");
const MAX_LOGS = 200;
const logs = [];

const state = {
    bots: [],
    developerID: "",
    loopEnabled: {},
    autoRespondEnabled: {},
    mutedThreads: {},
    totalRepliesSent: 0,
    startedAt: new Date(),
    get loggedIn()    { return this.bots.some(b => b.loggedIn); },
    get reconnecting(){ return !this.loggedIn && this.bots.some(b => b.reconnecting); },
};

function addLog(type, message) {
    const entry = { time: new Date().toLocaleTimeString(), type, message };
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.pop();
}

function getUptime() {
    const ms = Date.now() - state.startedAt.getTime();
    const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
    if(d>0)return`${d}d ${h%24}h`;
    if(h>0)return`${h}h ${m%60}m`;
    if(m>0)return`${m}m ${s%60}s`;
    return`${s}s`;
}

function esc(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function readCustomReplies() { try{return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8"));}catch(_){return[];} }
function writeCustomReplies(a){ fs.writeFileSync(CUSTOM_REPLIES_FILE,JSON.stringify(a,null,2),"utf8"); }
function readImageReplies() { try{return JSON.parse(fs.readFileSync(IMAGE_REPLIES_FILE,"utf8"));}catch(_){return[];} }
function writeImageReplies(a){ fs.writeFileSync(IMAGE_REPLIES_FILE,JSON.stringify(a,null,2),"utf8"); }
function readBotConfig() {
    try{return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE,"utf8"));}
    catch(_){return{loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false,silentMode:false,loopSilentMode:false};}
}
function writeBotConfig(c){ fs.writeFileSync(BOT_CONFIG_FILE,JSON.stringify(c,null,2),"utf8"); }

// Fixed body parser — handles = signs inside values
function parseBody(req) {
    return new Promise(resolve => {
        let raw = "";
        req.on("data", c => { raw += c.toString(); });
        req.on("end", () => {
            const p = {};
            raw.split("&").forEach(pair => {
                const eqIdx = pair.indexOf("=");
                if (eqIdx === -1) return;
                try {
                    const k = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
                    const v = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
                    p[k] = v;
                } catch(_) {}
            });
            resolve(p);
        });
    });
}

// Read raw body as-is (for JSON payloads)
function readRawBody(req) {
    return new Promise(resolve => {
        let raw = "";
        req.on("data", c => { raw += c.toString(); });
        req.on("end", () => resolve(raw));
    });
}

function buildHTML(tab) {
    const t = tab || "dashboard";
    const threads       = Object.keys({...state.loopEnabled,...state.autoRespondEnabled});
    const uniqueThreads = [...new Set(threads)];
    const loopCount     = Object.values(state.loopEnabled||{}).filter(Boolean).length;
    const arCount       = Object.values(state.autoRespondEnabled||{}).filter(Boolean).length;
    const mutedCount    = Object.values(state.mutedThreads||{}).filter(Boolean).length;
    const isOnline      = state.loggedIn;
    const isRecon       = state.reconnecting;
    const statusDot     = isOnline?"#22c55e":(isRecon?"#f59e0b":"#ef4444");
    const statusText    = isOnline?"Online":(isRecon?"Reconnecting…":"Offline");
    const cfg           = readBotConfig();
    const customReplies = readCustomReplies();
    const imageReplies  = readImageReplies();

    const SVG_ICONS = {
        dashboard: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
        loop:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
        config:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
        session:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
        commands:  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    };

    const TABS = [
        {id:"dashboard",label:"Dashboard"},
        {id:"loop",     label:"Loop Queue"},
        {id:"config",   label:"Config"},
        {id:"session",  label:"Session"},
        {id:"commands", label:"Commands"},
    ];

    const navLinks = TABS.map(tb=>`
        <a href="/?tab=${tb.id}" class="nav-item ${t===tb.id?"active":""}">
            <span class="nav-icon">${SVG_ICONS[tb.id]||""}</span>
            <span class="nav-label">${tb.label}</span>
        </a>`).join("");

    // Bot pills
    const botBadges = state.bots.length===0
        ? `<div class="pill pill-off"><span class="pdot"></span>No bots loaded</div>`
        : state.bots.map(b=>{
            const cls = b.loggedIn?"pill-on":(b.reconnecting?"pill-warn":"pill-off");
            const lbl = b.loggedIn?"Online":(b.reconnecting?`Reconnecting ${b.nextReconnectIn}s`:"Offline");
            return `<div class="pill ${cls}"><span class="pdot"></span><b>${esc(b.label)}</b> — ${lbl}</div>`;
        }).join("");

    // Log rows
    const logRows = logs.length===0
        ? `<div class="lrow lidle"><span class="ltime">--:--</span><span class="llvl">IDLE</span><span class="lmsg">Waiting…</span></div>`
        : logs.slice(0,120).map(l=>{
            const lv={error:"ERR",warn:"WARN",reply:"SEND",info:"INFO"}[l.type]||"INFO";
            return `<div class="lrow l${l.type}"><span class="ltime">${esc(l.time)}</span><span class="llvl">${lv}</span><span class="lmsg">${esc(l.message)}</span></div>`;
        }).join("");

    // ── PAGE: DASHBOARD ───────────────────────────────────────────────
    const pageDashboard = `
        <div class="hero">
            <div class="hero-top">
                <div class="hero-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a2 2 0 0 1 2 2v1h1a3 3 0 0 1 3 3v1a2 2 0 0 1 0 4v1a3 3 0 0 1-3 3h-1v1a2 2 0 0 1-4 0v-1H9a3 3 0 0 1-3-3v-1a2 2 0 0 1 0-4V8a3 3 0 0 1 3-3h1V4a2 2 0 0 1 2-2z"/><circle cx="9" cy="11" r="1" fill="currentColor"/><circle cx="15" cy="11" r="1" fill="currentColor"/></svg></div>
                <div>
                    <div class="hero-title">Cozy Bot Panel</div>
                    <div class="hero-sub">loop (dot) · auto-respond (!on/!off) · group tools · tts</div>
                </div>
                <div class="status-badge" style="--sc:${statusDot}">
                    <span class="sdot"></span>${statusText}
                </div>
            </div>
            <div class="pill-row">${botBadges}</div>
        </div>
        <div class="cards">
            <div class="card"><div class="ct ci"></div><div class="clabel">Messages Sent</div><div class="cval" style="color:#7b8ff7">${state.totalRepliesSent}</div><div class="csub">total dispatches</div></div>
            <div class="card"><div class="ct cg"></div><div class="clabel">Active Loops</div><div class="cval" style="color:#34d399">${loopCount}</div><div class="csub">dot-triggered</div></div>
            <div class="card"><div class="ct cp"></div><div class="clabel">Auto-Respond</div><div class="cval" style="color:#c084fc">${arCount}</div><div class="csub">${mutedCount} muted · groups only</div></div>
            <div class="card"><div class="ct ca"></div><div class="clabel">Uptime</div><div class="cval" style="color:#fbbf24;font-size:${getUptime().length>6?"18":"26"}px;padding-top:4px">${getUptime()}</div><div class="csub">since boot</div></div>
        </div>
        <div class="section-label">Thread Registry</div>
        <div class="panel">
            <div class="ph"><span class="pbadge pbadge-g">LIVE</span><span class="ph-title">Active Threads</span><span class="ph-meta">${uniqueThreads.length} total</span></div>
            <table>
                <thead><tr><th>Thread ID</th><th>Loop (dot)</th><th>Auto-Respond (!on/!off)</th></tr></thead>
                <tbody>${
                    uniqueThreads.length===0
                    ? `<tr><td colspan="3" class="td-empty">No threads yet — send <code>.</code> (dot) in Messenger to start</td></tr>`
                    : uniqueThreads.map(tid=>{
                        const loop  = state.loopEnabled&&state.loopEnabled[tid];
                        const ar    = state.autoRespondEnabled&&state.autoRespondEnabled[tid];
                        const muted = state.mutedThreads&&state.mutedThreads[tid];
                        return `<tr>
                            <td class="td-mono">${esc(tid)}</td>
                            <td>${loop?`<span class="badge bg">🔄 ON</span>`:`<span class="badge br">OFF</span>`}</td>
                            <td>${ar?`<span class="badge bg">💬 ON</span>`:`<span class="badge br">OFF</span>`}${muted?` <span class="badge by">🔇</span>`:""}</td>
                        </tr>`;
                    }).join("")
                }</tbody>
            </table>
        </div>
        <div class="section-label">Live Logs</div>
        <div class="panel" style="padding:0">
            <div class="ph"><span class="pbadge">LOGS</span><span class="ph-title">Real-time Events</span><span class="ph-meta">${logs.length} entries</span></div>
            <div class="log-wrap">${logRows}</div>
        </div>`;

    // ── PAGE: LOOP QUEUE ──────────────────────────────────────────────
    const textQueueRows = customReplies.length===0
        ? `<div class="empty-q">Queue is empty — add your first message above</div>`
        : customReplies.map((w,i)=>`
            <div class="qi">
                <span class="qi-n">${String(i+1).padStart(2,"0")}</span>
                <span class="qi-v">${esc(w)}</span>
                <form method="POST" action="/api/replies/remove?tab=loop" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    const imgRows = imageReplies.length===0
        ? `<div class="empty-q">No custom image URLs — add one above</div>`
        : imageReplies.map((u,i)=>`
            <div class="qi">
                <span class="qi-n">${String(i+1).padStart(2,"0")}</span>
                <span class="qi-v" style="color:#60a5fa;font-size:11px">${esc(u)}</span>
                <form method="POST" action="/api/images/remove?tab=loop" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    const pageLoop = `
        <div class="two-col">
            <div>
                <div class="section-label">Text Message Pool</div>
                <div class="panel">
                    <div class="ph"><span class="pbadge">QUEUE</span><span class="ph-title">Custom Text Replies</span><span class="ph-meta" style="color:var(--ac2)">${customReplies.length} custom · ${customReplies.length+102} total</span></div>
                    <form class="irow" method="POST" action="/api/replies/add?tab=loop">
                        <input class="ifield" type="text" name="word" placeholder="Add new message to loop pool…" autocomplete="off" required/>
                        <button class="btn-add" type="submit">＋ Add</button>
                    </form>
                    <div class="ql">${textQueueRows}</div>
                </div>
            </div>
            <div>
                <div class="section-label">Image URL Pool</div>
                <div class="panel">
                    <div class="ph"><span class="pbadge pbadge-p">IMAGES</span><span class="ph-title">Custom Image URLs</span><span class="ph-meta" style="color:var(--pu2)">${imageReplies.length} URLs</span></div>
                    <form class="irow" method="POST" action="/api/images/add?tab=loop">
                        <input class="ifield" type="url" name="url" placeholder="https://example.com/image.jpg" autocomplete="off" required/>
                        <button class="btn-add" type="submit">＋ Add</button>
                    </form>
                    <div class="ql">${imgRows}</div>
                </div>
            </div>
        </div>`;

    // ── PAGE: CONFIG ──────────────────────────────────────────────────
    const pageConfig = `
        <form method="POST" action="/api/config/save?tab=config">
        <div class="two-col">
            <div>
                <div class="section-label">Loop Engine</div>
                <div class="panel">
                    <div class="ph"><span class="pbadge">LOOP</span><span class="ph-title">Dot Trigger Settings</span></div>
                    <div class="cfg-body">
                        <div class="cfg-field"><label class="cfg-label">Reaction Emoji</label><input class="cfg-input" type="text" name="loopReact" value="${esc(cfg.loopReact||'😆')}" maxlength="8"/></div>
                        <div class="cfg-field"><label class="cfg-label">Delay (seconds)</label><input class="cfg-input" type="number" name="loopDelay" value="${cfg.loopDelay||5}" min="1" max="300"/><div class="cfg-hint">Interval between messages</div></div>
                        <div class="cfg-field"><label class="cfg-label">Image Chance (%)</label><input class="cfg-input" type="number" name="imageProbability" value="${cfg.imageProbability||20}" min="0" max="100"/></div>
                        <div class="cfg-field"><label class="cfg-label">Loop Mode</label>
                            <select class="cfg-select" name="loopMode">
                                <option value="sequential" ${cfg.loopMode==="sequential"?"selected":""}>Sequential</option>
                                <option value="shuffle" ${cfg.loopMode==="shuffle"?"selected":""}>Shuffle / Random</option>
                            </select>
                        </div>
                        <div class="cfg-field"><label class="cfg-label">Max Messages (0 = unlimited)</label><input class="cfg-input" type="number" name="maxLoopCount" value="${cfg.maxLoopCount||0}" min="0"/></div>
                        <div class="cfg-field"><label class="cfg-label">Auto-Stop After (min, 0 = off)</label><input class="cfg-input" type="number" name="autoStopMinutes" value="${cfg.autoStopMinutes||0}" min="0"/></div>
                        <div class="cfg-field"><label class="cfg-label">Start Message</label><input class="cfg-input" type="text" name="loopStartMsg" value="${esc(cfg.loopStartMsg||'')}" placeholder="Sent when loop starts"/></div>
                        <div class="cfg-field"><label class="cfg-label">Stop Message</label><input class="cfg-input" type="text" name="loopStopMsg" value="${esc(cfg.loopStopMsg||'')}" placeholder="Sent when loop stops"/></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="reactOnly" name="reactOnlyMode" value="1" ${cfg.reactOnlyMode?"checked":""}><label for="reactOnly">React-only mode (no images)</label></div>
                    </div>
                </div>
            </div>
            <div>
                <div class="section-label">General Settings</div>
                <div class="panel">
                    <div class="ph"><span class="pbadge pbadge-g">GENERAL</span><span class="ph-title">Bot Behavior</span></div>
                    <div class="cfg-body">
                        <div class="cfg-field"><label class="cfg-label">TTS Language</label>
                            <select class="cfg-select" name="ttsLang">
                                ${[["tl","Tagalog"],["en","English"],["ja","Japanese"],["ko","Korean"],["zh","Chinese"],["es","Spanish"],["fr","French"],["de","German"]].map(([v,n])=>`<option value="${v}" ${cfg.ttsLang===v?"selected":""}>${n}</option>`).join("")}
                            </select>
                        </div>
                        <div class="cfg-field"><label class="cfg-label">Welcome Message</label><input class="cfg-input" type="text" name="greetMsg" value="${esc(cfg.greetMsg||'Welcome! 👋')}" placeholder="For new members"/></div>
                        <div class="cfg-field"><label class="cfg-label">Anti-Spam Max Msgs</label><input class="cfg-input" type="number" name="antiSpamMaxMsg" value="${cfg.antiSpamMaxMsg||5}" min="2"/></div>
                        <div class="cfg-field"><label class="cfg-label">Anti-Spam Window (sec)</label><input class="cfg-input" type="number" name="antiSpamWindowSec" value="${cfg.antiSpamWindowSec||10}" min="3"/></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="greetNew" name="greetNewMembers" value="1" ${cfg.greetNewMembers?"checked":""}><label for="greetNew">Greet new members</label></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="antiSpam" name="antiSpamEnabled" value="1" ${cfg.antiSpamEnabled?"checked":""}><label for="antiSpam">Anti-spam auto-kick</label></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="autoSeen" name="autoSeenEnabled" value="1" ${cfg.autoSeenEnabled?"checked":""}><label for="autoSeen">Auto mark seen</label></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="typing" name="typingSimulate" value="1" ${cfg.typingSimulate?"checked":""}><label for="typing">Simulate typing</label></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="silentMode" name="silentMode" value="1" ${cfg.silentMode?"checked":""}><label for="silentMode">Auto-respond with /silent (suppress notif — hides msgs from notif-based bots)</label></div>
                        <div class="cfg-toggle"><input class="cfg-check" type="checkbox" id="loopSilentMode" name="loopSilentMode" value="1" ${cfg.loopSilentMode?"checked":""}><label for="loopSilentMode">Loop with /silent (suppress notif on loop messages — hides loop from notif-based bots)</label></div>
                    </div>
                </div>
            </div>
        </div>
        <div style="display:flex;justify-content:center;margin-top:4px">
            <button class="btn-save" type="submit">▶ Save All Configuration</button>
        </div>
        </form>`;

    // ── PAGE: SESSION ─────────────────────────────────────────────────
    const botStatusCards = state.bots.length===0
        ? `<div class="notice">No bots loaded yet.</div>`
        : state.bots.map(b=>{
            const c=b.loggedIn?"#22c55e":(b.reconnecting?"#f59e0b":"#ef4444");
            const l=b.loggedIn?"✅ Online":(b.reconnecting?"🔄 Reconnecting…":"❌ Offline / Expired");
            return `<div class="bot-card"><div class="bc-name">${esc(b.label)}</div><div class="bc-status" style="color:${c}">${l}</div>${b.nextReconnectIn>0?`<div class="bc-sub">Next try in ${b.nextReconnectIn}s</div>`:""}</div>`;
        }).join("");

    const pageSession = `
        <div class="two-col">
            <div>
                <div class="section-label">Bot Status</div>
                <div class="panel">
                    <div class="ph"><span class="pbadge">ACCOUNTS</span><span class="ph-title">Logged-in Bots</span></div>
                    <div style="padding:16px;display:flex;flex-direction:column;gap:10px">${botStatusCards}</div>
                </div>
                <div class="notice-box">
                    <div class="nb-title">📌 How to get a new session</div>
                    <ol class="nb-list">
                        <li>Install <b>Cookie Editor</b> extension on Chrome/Firefox</li>
                        <li>Open <b>facebook.com</b> and log into your bot account</li>
                        <li>Click Cookie Editor → <b>Export All</b> → copy the JSON</li>
                        <li>Paste into the form on the right and click Save</li>
                    </ol>
                </div>
            </div>
            <div>
                <div class="section-label">Paste New Cookie</div>
                <div class="panel">
                    <div class="ph"><span class="pbadge pbadge-g">UPDATE</span><span class="ph-title">Update fbstate.json</span></div>
                    <div style="padding:16px">
                        <div class="cfg-hint" style="margin-bottom:10px;color:#fbbf24">⚠️ Make sure it's a JSON array starting with <code>[</code> and ending with <code>]</code>. The bot restarts automatically after saving.</div>
                        <form method="POST" action="/api/fbstate/update?tab=session" id="cookieForm">
                            <textarea class="cookie-area" name="fbstate" id="cookieArea"
                                placeholder='Paste fbstate JSON here&#10;[&#10;  {"key":"c_user","value":"..."},&#10;  {"key":"xs","value":"..."},&#10;  ...&#10;]'
                                required></textarea>
                            <div id="cookiePreview" class="cookie-preview" style="display:none"></div>
                            <div style="display:flex;gap:8px;margin-top:10px">
                                <button class="btn-cookie" type="submit">💾 Save &amp; Restart</button>
                                <button class="btn-cookie-clear" type="button" onclick="document.getElementById('cookieArea').value='';document.getElementById('cookiePreview').style.display='none'">✕ Clear</button>
                            </div>
                        </form>
                        <div class="cfg-hint" style="margin-top:10px">After saving, wait ~10s for the bot to reconnect. Check the Dashboard tab for the new status.</div>
                    </div>
                </div>
            </div>
        </div>
        <script>
        document.getElementById('cookieArea').addEventListener('input', function() {
            const prev = document.getElementById('cookiePreview');
            try {
                const arr = JSON.parse(this.value.trim());
                if (Array.isArray(arr)) {
                    const cuser = arr.find(c=>c.key==='c_user');
                    const xs = arr.find(c=>c.key==='xs');
                    prev.innerHTML = '✅ Valid JSON · '+arr.length+' cookies'+
                        (cuser?' · c_user: <b>'+cuser.value+'</b>':'')+
                        (xs?' · xs found':' · ⚠️ no xs cookie');
                    prev.style.display='block';
                    prev.className='cookie-preview cpv-ok';
                } else { throw new Error('not array'); }
            } catch(e) {
                if(this.value.trim()) {
                    prev.innerHTML='❌ Invalid JSON — '+e.message;
                    prev.style.display='block';
                    prev.className='cookie-preview cpv-err';
                } else { prev.style.display='none'; }
            }
        });
        </script>`;

    // ── PAGE: COMMANDS ────────────────────────────────────────────────
    const CMDS = [
        {sec:"Loop (dot trigger — groups & PMs)",rows:[
            [". (dot)","Toggle loop ON or OFF in any chat (group or PM)"],
            ["!status","Show current loop + auto-respond status"],
        ]},
        {sec:"Auto-Respond (groups only)",rows:[
            ["!on","Enable auto-respond — replies to every incoming message"],
            ["!off","Disable auto-respond"],
            ["!mute","Pause auto-respond (loop still runs)"],
            ["!unmute","Resume auto-respond"],
            ["!broadcast &lt;text&gt;","Send a message to all auto-respond active threads"],
        ]},
        {sec:"Group Management",rows:[
            ["!nn &lt;name&gt;","Nickname all members + lock the nickname"],
            ["!cg &lt;name&gt;","Change group name + lock it"],
            ["!banner [url]","Set and lock the group photo"],
            ["!kick &lt;uid&gt;","Remove a member from the group"],
            ["!add &lt;uid&gt;","Add someone to the group"],
            ["!emoji &lt;emoji&gt;","Change the group emoji"],
            ["!color &lt;name&gt;","Change chat color (blue, pink, green, etc.)"],
            ["!freeze / !unfreeze","Freeze group — anyone who chats gets kicked"],
            ["!lock","Show all active protections"],
        ]},
        {sec:"Permissions",rows:[
            ["!perms &lt;uid&gt; &lt;time&gt;","Grant temp permissions (e.g. 30s, 5min, 1h)"],
            ["!revoke [uid]","Remove temp permissions"],
            ["!gp &lt;url&gt; / !gp off","Lock profile picture — restores every 5min"],
            ["!antirestrict","Get notified when bot is kicked from a group"],
            ["!antichat","Auto-retry failed message sends"],
        ]},
        {sec:"Utilities",rows:[
            ["!say &lt;text&gt;","Make the bot send a message"],
            ["!vm &lt;text&gt;","Send a voice message via TTS"],
            ["!spam &lt;n&gt; &lt;msg&gt;","Send a message n times (max 20)"],
            ["!seen","Mark all messages as seen"],
            ["!count","Count 1 to 20 in the chat"],
            ["!info","Show group info (name, members, IDs, status)"],
            ["!id","Get UID of a replied message's sender"],
            ["!myid","Show your own Facebook ID"],
            ["!test","Ping the bot"],
            ["!help","Show the full command list inside Messenger"],
        ]},
        {sec:"Fun / Unexpected",rows:[
            ["!flip","Flip a coin — heads or tails"],
            ["!roll [sides]","Roll a dice, default 6-sided"],
            ["!8ball &lt;question&gt;","Ask the magic 8 ball"],
            ["!pick a | b | c","Randomly pick one option from a list"],
            ["!reverse &lt;text&gt;","Send text backwards"],
            ["!shout &lt;text&gt;","LOUD spaced-out ALL CAPS"],
            ["!mock &lt;text&gt;","aLtErNaTiNg cAsE (spongebob mode)"],
            ["!clap &lt;text&gt;","Put claps between each word"],
            ["!timer &lt;sec&gt;","Set a countdown — bot pings when done"],
            ["!repeat &lt;n&gt; &lt;text&gt;","Send a message stacked n times (max 10)"],
        ]},
    ];

    const cmdSections = CMDS.map(sec=>`
        <div class="panel" style="margin-bottom:14px">
            <div class="ph"><span class="pbadge pbadge-p">${sec.sec.split(" ")[0].toUpperCase()}</span><span class="ph-title">${sec.sec}</span></div>
            <table>
                <thead><tr><th style="width:220px">Command</th><th>Description</th></tr></thead>
                <tbody>${sec.rows.map(([c,d])=>`<tr><td class="tc">${c}</td><td class="td2">${d}</td></tr>`).join("")}</tbody>
            </table>
        </div>`).join("");

    const pageCommands = `
        <div class="section-label">Command Reference</div>
        ${cmdSections}
        <div class="notice-box" style="margin-top:0">
            <div class="nb-title">Trigger Summary</div>
            <p style="color:#8b95c0;font-size:12.5px;line-height:1.7">
                <code>. (dot)</code> — Toggles the <b>loop</b> ON/OFF in any chat (group or PM)<br>
                <code>!on</code> / <code>!off</code> — Toggles <b>auto-respond</b> — groups ONLY<br>
                All other <code>!</code> commands — require developer or temp permissions
            </p>
        </div>`;

    // ── PAGES MAP ─────────────────────────────────────────────────────
    const pages = {dashboard:pageDashboard, loop:pageLoop, config:pageConfig, session:pageSession, commands:pageCommands};
    const pageContent = pages[t] || pageDashboard;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cozy Bot Panel${t!=="dashboard"?" · "+t.charAt(0).toUpperCase()+t.slice(1):""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0c0a0f;--s0:#110e16;--s1:#17131f;--s2:#1e1829;--s3:#261e34;
  --b0:#2e2340;--b1:#3d3057;--b2:#52406e;
  --tx:#ede5f8;--tx2:#a890d0;--tx3:#6e5a94;--muted:#4a3868;
  --ac:#c084fc;--ac2:#d8a8ff;
  --acg:linear-gradient(135deg,#9333ea,#c084fc,#e0b8ff);
  --gn:#10b981;--gn2:#34d399;
  --rd:#f43f5e;--rd2:#fb7185;
  --yw:#f59e0b;--yw2:#fbbf24;
  --pu:#a855f7;--pu2:#c084fc;
  --mono:'JetBrains Mono',monospace;
  --sans:'Inter',sans-serif;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--tx);font-family:var(--sans);font-size:13.5px;line-height:1.6;display:flex;flex-direction:column}

/* ── TOPBAR ── */
.topbar{
  height:50px;flex-shrink:0;
  background:var(--s0);border-bottom:1px solid var(--b0);
  display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:12px;
}
.tb-l{display:flex;align-items:center;gap:12px}
.logo{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:13px;font-weight:700;color:var(--ac2)}
.logo-sq{width:28px;height:28px;border-radius:8px;background:var(--acg);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;box-shadow:0 0 14px #5b6ef140}
.ver-tag{font-family:var(--mono);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;padding:2px 8px;border-radius:4px;background:#5b6ef514;border:1px solid #5b6ef528;color:var(--ac2)}
.tb-r{display:flex;align-items:center;gap:16px;font-family:var(--mono);font-size:11px;color:var(--tx3)}
.tb-r b{color:var(--ac2)}
.sync{display:flex;align-items:center;gap:5px}
.lsdot{width:5px;height:5px;border-radius:50%;background:var(--gn);animation:blink 2.4s ease-in-out infinite;box-shadow:0 0 5px var(--gn)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}

/* ── NAV TABS ── */
.nav-bar{
  height:44px;flex-shrink:0;
  background:var(--s1);border-bottom:1px solid var(--b0);
  display:flex;align-items:stretch;padding:0 12px;gap:2px;
}
.nav-item{
  display:flex;align-items:center;gap:7px;padding:0 16px;
  font-size:12px;font-weight:500;color:var(--tx3);text-decoration:none;
  border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap;
}
.nav-item:hover{color:var(--tx2);border-bottom-color:var(--b2)}
.nav-item.active{color:var(--ac2);border-bottom-color:var(--ac)}
.nav-icon{font-size:14px}
.nav-label{letter-spacing:.01em}

/* ── CONTENT AREA ── */
.content-area{flex:1;overflow-y:auto;padding:22px 24px 50px}
.content-area::-webkit-scrollbar{width:5px}
.content-area::-webkit-scrollbar-thumb{background:var(--b1);border-radius:99px}

/* ── HERO ── */
.hero{background:var(--s1);border:1px solid var(--b0);border-radius:12px;padding:20px 22px;margin-bottom:18px;position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:-50px;right:-50px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,#5b6ef512,transparent 70%);pointer-events:none}
.hero-top{display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap}
.hero-icon{width:46px;height:46px;border-radius:11px;background:var(--acg);display:flex;align-items:center;justify-content:center;font-size:21px;box-shadow:0 0 22px #5b6ef140;flex-shrink:0}
.hero-title{font-size:19px;font-weight:800;color:var(--tx);letter-spacing:-.02em}
.hero-sub{font-size:11px;color:var(--tx3);font-family:var(--mono);margin-top:2px}
.status-badge{display:flex;align-items:center;gap:6px;margin-left:auto;padding:4px 12px;border-radius:6px;border:1px solid #ffffff10;background:#ffffff05;font-size:11.5px;font-family:var(--mono);color:var(--sc,#22c55e)}
.sdot{width:7px;height:7px;border-radius:50%;background:var(--sc,#22c55e);box-shadow:0 0 8px var(--sc,#22c55e);animation:blink 2.4s ease-in-out infinite}
.pill-row{display:flex;flex-wrap:wrap;gap:7px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:7px;border:1px solid var(--b1);background:var(--s2);font-size:11px;font-family:var(--mono)}
.pill-on{border-color:#10b98130;color:var(--gn2)}.pill-warn{border-color:#f59e0b30;color:var(--yw2)}.pill-off{color:var(--tx3)}
.pdot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;animation:blink 2.4s ease-in-out infinite}
.pill-off .pdot{animation:none;opacity:.3}

/* ── CARDS ── */
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
@media(max-width:750px){.cards{grid-template-columns:1fr 1fr}}
.card{background:var(--s1);border:1px solid var(--b0);border-radius:10px;padding:15px 16px 12px;position:relative;overflow:hidden;transition:border-color .2s}
.card:hover{border-color:var(--b1)}
.ct{position:absolute;top:0;left:0;right:0;height:2.5px;border-radius:10px 10px 0 0}
.ci{background:linear-gradient(90deg,#4338ca,#7b8ff7)}
.cg{background:linear-gradient(90deg,#059669,#34d399)}
.cp{background:linear-gradient(90deg,#7c3aed,#c084fc)}
.ca{background:linear-gradient(90deg,#d97706,#fbbf24)}
.clabel{font-size:9px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.15em;margin-bottom:7px}
.cval{font-size:28px;font-weight:800;line-height:1;font-family:var(--mono)}
.csub{font-size:10px;color:var(--tx3);margin-top:5px}

/* ── SECTION LABEL ── */
.section-label{display:flex;align-items:center;gap:9px;font-size:9.5px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.17em;margin-bottom:10px}
.section-label::after{content:'';flex:1;height:1px;background:var(--b0)}

/* ── PANEL ── */
.panel{background:var(--s1);border:1px solid var(--b0);border-radius:10px;overflow:hidden;margin-bottom:18px}
.ph{display:flex;align-items:center;gap:10px;padding:10px 15px;background:var(--s2);border-bottom:1px solid var(--b0)}
.ph-title{font-size:11.5px;font-weight:600;color:var(--tx2);flex:1}
.ph-meta{font-size:10.5px;color:var(--tx3);font-family:var(--mono)}
.pbadge{font-size:8.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:2px 8px;border-radius:4px;background:#5b6ef514;border:1px solid #5b6ef525;color:var(--ac2)}
.pbadge-g{background:#10b98113;border-color:#10b98125;color:var(--gn2)}
.pbadge-p{background:#a855f713;border-color:#a855f725;color:var(--pu2)}

/* ── TABLE ── */
table{width:100%;border-collapse:collapse}
th{padding:9px 15px;text-align:left;font-size:8.5px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.13em;background:var(--s2);border-bottom:1px solid var(--b0)}
td{padding:9px 15px;border-bottom:1px solid var(--b0);font-size:12.5px;vertical-align:middle;color:var(--tx2)}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff02}
.td-mono{font-family:var(--mono);font-size:11px;color:var(--tx3)}
.td-empty{text-align:center;color:var(--tx3);padding:26px;font-size:12.5px}
.td-empty code{background:var(--s2);border:1px solid var(--b1);border-radius:4px;padding:1px 6px;font-family:var(--mono);color:var(--ac2)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;font-family:var(--mono)}
.bg{background:#10b98116;color:var(--gn2);border:1px solid #10b98126}
.br{background:#ef444416;color:var(--rd2);border:1px solid #ef444426}
.by{background:#f59e0b16;color:var(--yw2);border:1px solid #f59e0b26}

/* ── QUEUE LIST ── */
.irow{display:flex;gap:8px;padding:12px 14px;border-bottom:1px solid var(--b0);flex-wrap:wrap;align-items:center}
.ifield{flex:1;min-width:140px;background:var(--bg);border:1px solid var(--b1);border-radius:6px;padding:7px 11px;color:var(--tx);font-size:12.5px;outline:none;transition:border-color .2s;font-family:var(--mono)}
.ifield:focus{border-color:var(--ac)}
.ifield::placeholder{color:var(--muted)}
.btn-add{background:var(--acg);color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn-add:hover{opacity:.85}
.btn-rm{background:#ef444412;color:var(--rd2);border:1px solid #ef444428;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn-rm:hover{background:#ef444425}
.ql{max-height:340px;overflow-y:auto}
.ql::-webkit-scrollbar{width:3px}
.ql::-webkit-scrollbar-thumb{background:var(--b1);border-radius:99px}
.qi{display:flex;align-items:center;gap:10px;padding:7px 14px;border-bottom:1px solid var(--b0);transition:background .1s}
.qi:last-child{border-bottom:none}
.qi:hover{background:#ffffff02}
.qi-n{font-size:10px;color:var(--muted);min-width:22px;font-family:var(--mono)}
.qi-v{color:var(--tx2);font-size:12px;word-break:break-all;flex:1;font-family:var(--mono)}
.empty-q{color:var(--tx3);text-align:center;padding:22px;font-size:12px}

/* ── LOGS ── */
.log-wrap{max-height:380px;overflow-y:auto;background:var(--bg);font-family:var(--mono);font-size:11px}
.log-wrap::-webkit-scrollbar{width:3px}
.log-wrap::-webkit-scrollbar-thumb{background:var(--b1);border-radius:99px}
.lrow{display:flex;gap:10px;padding:3px 14px;line-height:1.5}
.lrow:hover{background:#ffffff02}
.ltime{color:var(--muted);font-size:9.5px;flex-shrink:0;min-width:64px;padding-top:1px}
.llvl{font-size:9px;font-weight:700;flex-shrink:0;min-width:34px;padding-top:2px;text-transform:uppercase}
.lmsg{color:var(--tx3);word-break:break-word;flex:1;font-size:10.5px}
.lerror .llvl{color:var(--rd2)}.lerror .lmsg{color:#fca5a5}
.lwarn  .llvl{color:var(--yw2)}.lwarn  .lmsg{color:#fde68a}
.lreply .llvl{color:var(--gn2)}.lreply .lmsg{color:#6ee7b7}
.linfo  .llvl{color:var(--ac2)}.linfo  .lmsg{color:var(--tx3)}
.lidle  .llvl,.lidle .lmsg{color:var(--muted)}

/* ── TWO COL ── */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:800px){.two-col{grid-template-columns:1fr}}

/* ── CONFIG FORM ── */
.cfg-body{padding:14px 15px}
.cfg-field{margin-bottom:13px}
.cfg-label{display:block;font-size:9px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.12em;margin-bottom:4px}
.cfg-input,.cfg-select{width:100%;background:var(--bg);border:1px solid var(--b1);border-radius:6px;padding:7px 11px;color:var(--tx);font-size:12px;outline:none;transition:border-color .2s;font-family:var(--mono)}
.cfg-select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23555e85' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:26px;cursor:pointer}
.cfg-input:focus,.cfg-select:focus{border-color:var(--ac)}
.cfg-hint{font-size:9.5px;color:var(--muted);margin-top:3px;line-height:1.4}
.cfg-toggle{display:flex;align-items:center;gap:9px;margin-bottom:11px;cursor:pointer}
.cfg-check{width:32px;height:18px;border-radius:9px;cursor:pointer;background:var(--b1);border:none;outline:none;position:relative;appearance:none;transition:background .2s;flex-shrink:0}
.cfg-check:checked{background:var(--ac)}
.cfg-check::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .2s}
.cfg-check:checked::after{transform:translateX(14px)}
.cfg-toggle label{font-size:12px;color:var(--tx2);cursor:pointer;user-select:none}
.btn-save{background:var(--acg);color:#fff;border:none;border-radius:8px;padding:11px 36px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn-save:hover{opacity:.85}

/* ── SESSION PAGE ── */
.bot-card{background:var(--s2);border:1px solid var(--b0);border-radius:8px;padding:14px 16px}
.bc-name{font-size:13px;font-weight:600;color:var(--tx);margin-bottom:4px}
.bc-status{font-size:12px;font-family:var(--mono)}
.bc-sub{font-size:10.5px;color:var(--tx3);margin-top:3px;font-family:var(--mono)}
.notice-box{background:var(--s2);border:1px solid var(--b0);border-radius:10px;padding:16px 18px;margin-bottom:18px}
.nb-title{font-size:11px;font-weight:700;color:var(--ac2);margin-bottom:10px;text-transform:uppercase;letter-spacing:.1em}
.nb-list{padding-left:18px;font-size:12.5px;color:var(--tx2);line-height:2}
.nb-list b{color:var(--tx)}
.cookie-area{width:100%;background:var(--bg);border:1px solid var(--b1);border-radius:7px;padding:10px 12px;color:var(--tx);font-family:var(--mono);font-size:10.5px;outline:none;resize:vertical;min-height:180px;transition:border-color .2s;line-height:1.6}
.cookie-area:focus{border-color:var(--ac)}
.cookie-area::placeholder{color:var(--muted)}
.cookie-preview{padding:8px 12px;border-radius:6px;font-size:11px;font-family:var(--mono);margin-top:8px}
.cpv-ok{background:#10b98112;border:1px solid #10b98128;color:var(--gn2)}
.cpv-err{background:#ef444412;border:1px solid #ef444428;color:var(--rd2)}
.btn-cookie{flex:1;background:linear-gradient(135deg,#059669,#10b981);color:#fff;border:none;border-radius:7px;padding:9px;font-size:12.5px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn-cookie:hover{opacity:.85}
.btn-cookie-clear{background:var(--s2);color:var(--tx3);border:1px solid var(--b1);border-radius:7px;padding:9px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
.btn-cookie-clear:hover{background:var(--s3)}
code{background:var(--s2);border:1px solid var(--b1);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:11px;color:var(--ac2)}

/* ── COMMANDS PAGE ── */
.tc{font-family:var(--mono);font-size:11.5px;color:var(--ac2);white-space:nowrap;width:1%;padding-right:4px}
.td2{color:var(--tx3);font-size:12px}

/* ── NOTICE ── */
.notice{color:var(--tx3);font-size:12.5px;padding:20px;text-align:center}

/* auto-refresh for dashboard only */
${t==="dashboard"?`<meta http-equiv="refresh" content="10"/>`:""}
</style>
</head>
<body>

<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-l">
    <div class="logo">
      <div class="logo-sq"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a2 2 0 0 1 2 2v1h1a3 3 0 0 1 3 3v1a2 2 0 0 1 0 4v1a3 3 0 0 1-3 3h-1v1a2 2 0 0 1-4 0v-1H9a3 3 0 0 1-3-3v-1a2 2 0 0 1 0-4V8a3 3 0 0 1 3-3h1V4a2 2 0 0 1 2-2z"/><circle cx="9" cy="11" r="1" fill="#fff"/><circle cx="15" cy="11" r="1" fill="#fff"/></svg></div>
      Cozy Bot
    </div>
    <span class="ver-tag">v2.1</span>
  </div>
  <div class="tb-r">
    <span>dev <b>${esc(state.developerID||"—")}</b></span>
    <div class="sync"><div class="lsdot"></div>${t==="dashboard"?"auto-refresh 10s":"static view"}</div>
  </div>
</div>

<!-- NAV TABS -->
<nav class="nav-bar">${navLinks}</nav>

<!-- CONTENT -->
<div class="content-area">
${pageContent}
</div>

</body>
</html>`;
}

function startDashboard(port=5000) {
    const server = http.createServer(async(req,res)=>{
        const url  = new URL(req.url, "http://localhost");
        const path2= url.pathname;
        const tab  = url.searchParams.get("tab") || "dashboard";

        function redirect(t) {
            res.writeHead(302, {Location: t ? `/?tab=${t}` : "/"});
            res.end();
        }
        function htmlErr(msg) {
            res.writeHead(200,{"Content-Type":"text/html"});
            res.end(`<!DOCTYPE html><html><body style="background:#080a12;color:#ef4444;font-family:monospace;padding:40px"><h3>❌ ${msg}</h3><br><a href="/" style="color:#7b8ff7">← Go back</a></body></html>`);
        }

        try {
            // ── Add text reply
            if (path2==="/api/replies/add" && req.method==="POST") {
                const p = await parseBody(req);
                const w = (p.word||"").trim();
                if(w){ const a=readCustomReplies(); a.push(w); writeCustomReplies(a); }
                redirect(tab); return;
            }
            // ── Remove text reply
            if (path2==="/api/replies/remove" && req.method==="POST") {
                const p = await parseBody(req);
                const idx = parseInt(p.index);
                if(!isNaN(idx)){ const a=readCustomReplies(); if(idx>=0&&idx<a.length)a.splice(idx,1); writeCustomReplies(a); }
                redirect(tab); return;
            }
            // ── Add image URL
            if (path2==="/api/images/add" && req.method==="POST") {
                const p = await parseBody(req);
                const u = (p.url||"").trim();
                if(u&&u.startsWith("http")){ const a=readImageReplies(); a.push(u); writeImageReplies(a); }
                redirect(tab); return;
            }
            // ── Remove image URL
            if (path2==="/api/images/remove" && req.method==="POST") {
                const p = await parseBody(req);
                const idx = parseInt(p.index);
                if(!isNaN(idx)){ const a=readImageReplies(); if(idx>=0&&idx<a.length)a.splice(idx,1); writeImageReplies(a); }
                redirect(tab); return;
            }
            // ── Save config
            if (path2==="/api/config/save" && req.method==="POST") {
                const p = await parseBody(req);
                const cfg = readBotConfig();
                if(p.loopReact!==undefined)        cfg.loopReact         = p.loopReact.trim()||"😆";
                if(p.loopDelay!==undefined)        cfg.loopDelay         = Math.max(1,parseInt(p.loopDelay)||5);
                if(p.imageProbability!==undefined) cfg.imageProbability  = Math.min(100,Math.max(0,parseInt(p.imageProbability)||20));
                if(p.loopMode!==undefined)         cfg.loopMode          = ["sequential","shuffle"].includes(p.loopMode)?p.loopMode:"sequential";
                if(p.loopStartMsg!==undefined)     cfg.loopStartMsg      = p.loopStartMsg.trim();
                if(p.loopStopMsg!==undefined)      cfg.loopStopMsg       = p.loopStopMsg.trim();
                if(p.maxLoopCount!==undefined)     cfg.maxLoopCount      = Math.max(0,parseInt(p.maxLoopCount)||0);
                if(p.autoStopMinutes!==undefined)  cfg.autoStopMinutes   = Math.max(0,parseInt(p.autoStopMinutes)||0);
                if(p.ttsLang!==undefined)          cfg.ttsLang           = p.ttsLang.trim()||"tl";
                cfg.reactOnlyMode    = p.reactOnlyMode==="1";
                cfg.greetNewMembers  = p.greetNewMembers==="1";
                if(p.greetMsg!==undefined)         cfg.greetMsg          = p.greetMsg.trim()||"Welcome! 👋";
                cfg.antiSpamEnabled  = p.antiSpamEnabled==="1";
                if(p.antiSpamMaxMsg!==undefined)   cfg.antiSpamMaxMsg    = Math.max(2,parseInt(p.antiSpamMaxMsg)||5);
                if(p.antiSpamWindowSec!==undefined)cfg.antiSpamWindowSec = Math.max(3,parseInt(p.antiSpamWindowSec)||10);
                cfg.autoSeenEnabled  = p.autoSeenEnabled==="1";
                cfg.typingSimulate   = p.typingSimulate==="1";
                cfg.silentMode       = p.silentMode==="1";
                cfg.loopSilentMode   = p.loopSilentMode==="1";
                writeBotConfig(cfg);
                redirect(tab); return;
            }
            // ── Update fbstate (cookie) — reads raw body, parses form manually
            if (path2==="/api/fbstate/update" && req.method==="POST") {
                const raw = await readRawBody(req);
                // find the fbstate= field from raw form body
                const eqIdx = raw.indexOf("fbstate=");
                let jsonStr = "";
                if (eqIdx !== -1) {
                    jsonStr = decodeURIComponent(raw.slice(eqIdx + 8).replace(/\+/g, " "));
                }
                jsonStr = jsonStr.trim();
                if (!jsonStr) { htmlErr("No data received. Please paste your fbstate JSON."); return; }
                let parsed;
                try { parsed = JSON.parse(jsonStr); }
                catch(e) { htmlErr("Invalid JSON: "+String(e).replace(/</g,"&lt;")); return; }
                if (!Array.isArray(parsed)) { htmlErr("fbstate must be a JSON array [ {...}, {...} ]"); return; }
                if (!parsed.some(c=>c.key==="c_user")) { htmlErr("No c_user cookie found — are you sure this is a Facebook fbstate?"); return; }
                fs.writeFileSync(FBSTATE_FILE, JSON.stringify(parsed,null,2), "utf8");
                addLog("info","✅ fbstate updated from dashboard — bot reconnecting...");
                redirect(tab); return;
            }
            // ── State JSON API
            if (path2==="/api/state" && req.method==="GET") {
                res.writeHead(200,{"Content-Type":"application/json"});
                res.end(JSON.stringify({logs,state})); return;
            }
            // ── Main page
            let html;
            try { html = buildHTML(tab); }
            catch(e) {
                html = `<!DOCTYPE html><html><body style="background:#080a12;color:#ef4444;font-family:monospace;padding:40px"><h2>Render error</h2><pre>${String(e)}</pre><meta http-equiv="refresh" content="5"/></body></html>`;
            }
            res.writeHead(200,{"Content-Type":"text/html"});
            res.end(html);
        } catch(e) {
            try{res.writeHead(500);res.end("Server error: "+e.message);}catch(_){}
        }
    });

    server.on("error", err=>console.error("[cozy-bot] Dashboard error:",err));
    server.listen(port,"0.0.0.0",()=>console.log(`[cozy-bot] Dashboard running on port ${port}`));
}

module.exports = { startDashboard, addLog, state };
