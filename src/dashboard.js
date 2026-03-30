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
    catch(_){return{
        loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",
        loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,
        ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,
        greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,
        antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false,
        silentMode:false,loopSilentMode:false,
        autoReactEnabled:false,autoReactEmoji:"😆",
    };}
}
function writeBotConfig(c){ fs.writeFileSync(BOT_CONFIG_FILE,JSON.stringify(c,null,2),"utf8"); }

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
    const cfg           = readBotConfig();
    const customReplies = readCustomReplies();
    const imageReplies  = readImageReplies();

    const TABS = [
        {id:"dashboard", label:"Dashboard",    icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`},
        {id:"loop",      label:"Loop Queue",   icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`},
        {id:"config",    label:"Config",       icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`},
        {id:"session",   label:"Session",      icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`},
        {id:"commands",  label:"Commands",     icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`},
    ];

    const navLinks = TABS.map(tb=>`
        <a href="/?tab=${tb.id}" class="nav-item${t===tb.id?" active":""}">
            ${tb.icon}<span>${tb.label}</span>
        </a>`).join("");

    // ── STATUS ────────────────────────────────────────────────────────
    const statusColor = isOnline?"#22c55e":(isRecon?"#f59e0b":"#ef4444");
    const statusLabel = isOnline?"Online":(isRecon?"Reconnecting":"Offline");
    const statusClass = isOnline?"st-on":(isRecon?"st-warn":"st-off");

    const botPills = state.bots.length===0
        ? `<span class="pill pill-off">No bots loaded</span>`
        : state.bots.map(b=>{
            const cls = b.loggedIn?"pill-on":(b.reconnecting?"pill-warn":"pill-off");
            const lbl = b.loggedIn?"Online":(b.reconnecting?`Reconnecting ${b.nextReconnectIn}s`:"Offline");
            return `<span class="pill ${cls}"><i></i>${esc(b.label)} — ${lbl}</span>`;
        }).join("");

    const logRows = logs.length===0
        ? `<div class="lr lr-idle"><span class="lt">--:--</span><span class="ll">IDLE</span><span class="lm">Waiting for events…</span></div>`
        : logs.slice(0,120).map(l=>{
            const lv={error:"ERR",warn:"WARN",reply:"OUT",info:"INFO"}[l.type]||"INFO";
            return `<div class="lr lr-${l.type}"><span class="lt">${esc(l.time)}</span><span class="ll">${lv}</span><span class="lm">${esc(l.message)}</span></div>`;
        }).join("");

    // ── PAGE: DASHBOARD ───────────────────────────────────────────────
    const pageDashboard = `
<div class="hero">
    <div class="hero-left">
        <div class="hero-avatar">🤖</div>
        <div>
            <h1 class="hero-title">Cozy Bot <span class="hero-ver">v2.2</span></h1>
            <p class="hero-desc">loop · auto-respond · lock · pm-loop · tts · group tools</p>
            <div class="pill-row">${botPills}</div>
        </div>
    </div>
    <div class="status-pill ${statusClass}">
        <span class="sp-dot"></span>${statusLabel}
    </div>
</div>

<div class="stat-grid">
    <div class="stat-card sc-blue">
        <div class="sc-icon">💬</div>
        <div class="sc-val">${state.totalRepliesSent}</div>
        <div class="sc-label">Messages Sent</div>
    </div>
    <div class="stat-card sc-green">
        <div class="sc-icon">🔄</div>
        <div class="sc-val">${loopCount}</div>
        <div class="sc-label">Active Loops</div>
    </div>
    <div class="stat-card sc-purple">
        <div class="sc-icon">🤖</div>
        <div class="sc-val">${arCount}</div>
        <div class="sc-label">Auto-Respond <span class="sc-sub">${mutedCount} muted</span></div>
    </div>
    <div class="stat-card sc-orange">
        <div class="sc-icon">⏱</div>
        <div class="sc-val sc-val-sm">${getUptime()}</div>
        <div class="sc-label">Uptime</div>
    </div>
</div>

<div class="section-hd">Thread Registry</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-g">LIVE</span><span class="box-title">Active Threads</span><span class="box-meta">${uniqueThreads.length} registered</span></div>
    <table>
        <thead><tr><th>Thread ID</th><th>Loop (dot)</th><th>Auto-Respond</th></tr></thead>
        <tbody>${
            uniqueThreads.length===0
            ? `<tr><td colspan="3" class="td-empty">No threads yet — send <code>.</code> in Messenger to start a loop</td></tr>`
            : uniqueThreads.map(tid=>{
                const loop  = state.loopEnabled&&state.loopEnabled[tid];
                const ar    = state.autoRespondEnabled&&state.autoRespondEnabled[tid];
                const muted = state.mutedThreads&&state.mutedThreads[tid];
                return `<tr>
                    <td class="td-mono">${esc(tid)}</td>
                    <td>${loop?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-dim">OFF</span>`}</td>
                    <td>${ar?`<span class="tag tag-b">ON</span>`:`<span class="tag tag-dim">OFF</span>`}${muted?` <span class="tag tag-y">MUTED</span>`:""}</td>
                </tr>`;
            }).join("")
        }</tbody>
    </table>
</div>

<div class="section-hd" style="margin-top:20px">Live Console</div>
<div class="box" style="padding:0">
    <div class="box-hd"><span class="chip">LOG</span><span class="box-title">Real-time Events</span><span class="box-meta">${logs.length} entries</span></div>
    <div class="log-area">${logRows}</div>
</div>`;

    // ── PAGE: LOOP QUEUE ──────────────────────────────────────────────
    const textQueueRows = customReplies.length===0
        ? `<div class="q-empty">Queue is empty — add your first message above</div>`
        : customReplies.map((w,i)=>`
            <div class="qi">
                <span class="qi-num">${String(i+1).padStart(2,"0")}</span>
                <span class="qi-text">${esc(w)}</span>
                <form method="POST" action="/api/replies/remove?tab=loop" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    const imgRows = imageReplies.length===0
        ? `<div class="q-empty">No image URLs yet — paste one above</div>`
        : imageReplies.map((u,i)=>`
            <div class="qi">
                <span class="qi-num">${String(i+1).padStart(2,"0")}</span>
                <span class="qi-text qi-url">${esc(u)}</span>
                <form method="POST" action="/api/images/remove?tab=loop" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    const pageLoop = `
<div class="two-col">
    <div>
        <div class="section-hd">Text Pool</div>
        <div class="box">
            <div class="box-hd"><span class="chip">QUEUE</span><span class="box-title">Loop Messages</span><span class="box-meta">${customReplies.length} messages</span></div>
            <form class="add-row" method="POST" action="/api/replies/add?tab=loop">
                <input class="add-input" type="text" name="word" placeholder="Add new message to loop pool…" autocomplete="off" required/>
                <button class="btn-add" type="submit">+ Add</button>
            </form>
            <div class="q-list">${textQueueRows}</div>
        </div>
    </div>
    <div>
        <div class="section-hd">Image Pool</div>
        <div class="box">
            <div class="box-hd"><span class="chip chip-p">IMAGES</span><span class="box-title">Image URLs</span><span class="box-meta">${imageReplies.length} URLs</span></div>
            <form class="add-row" method="POST" action="/api/images/add?tab=loop">
                <input class="add-input" type="url" name="url" placeholder="https://example.com/image.jpg" autocomplete="off" required/>
                <button class="btn-add" type="submit">+ Add</button>
            </form>
            <div class="q-list">${imgRows}</div>
        </div>
    </div>
</div>`;

    // ── PAGE: CONFIG ──────────────────────────────────────────────────
    const pageConfig = `
<div class="cfg-scroll-wrap">
    <div class="cfg-tabs" id="cfgTabs">
        <button class="cfg-tab active" onclick="showCat('loop',this)">🔄 Loop</button>
        <button class="cfg-tab" onclick="showCat('autorespond',this)">💬 Auto-Respond</button>
        <button class="cfg-tab" onclick="showCat('react',this)">👍 Auto-React</button>
        <button class="cfg-tab" onclick="showCat('silent',this)">🔕 Silent</button>
        <button class="cfg-tab" onclick="showCat('security',this)">🔒 Security</button>
        <button class="cfg-tab" onclick="showCat('voice',this)">🎙 Voice / TTS</button>
    </div>
</div>
<form method="POST" action="/api/config/save?tab=config">

<!-- LOOP -->
<div class="cfg-cat" id="cat-loop">
<div class="two-col">
<div>
<div class="section-hd">Loop Engine</div>
<div class="box">
    <div class="box-hd"><span class="chip">LOOP</span><span class="box-title">Dot Trigger Settings</span></div>
    <div class="cfg-body">
        <div class="fld"><label class="flbl">Reaction Emoji</label><input class="finput" type="text" name="loopReact" value="${esc(cfg.loopReact||'😆')}" maxlength="8"/></div>
        <div class="fld"><label class="flbl">Delay (seconds)</label><input class="finput" type="number" name="loopDelay" value="${cfg.loopDelay||1}" min="1" max="300"/><div class="fhint">Interval between loop messages</div></div>
        <div class="fld"><label class="flbl">Image Chance (%)</label><input class="finput" type="number" name="imageProbability" value="${cfg.imageProbability||20}" min="0" max="100"/></div>
        <div class="fld"><label class="flbl">Loop Mode</label>
            <select class="fselect" name="loopMode">
                <option value="sequential" ${cfg.loopMode==="sequential"?"selected":""}>Sequential</option>
                <option value="shuffle" ${cfg.loopMode==="shuffle"?"selected":""}>Shuffle / Random</option>
            </select>
        </div>
        <div class="fld"><label class="flbl">Max Messages (0 = unlimited)</label><input class="finput" type="number" name="maxLoopCount" value="${cfg.maxLoopCount||0}" min="0"/></div>
        <div class="fld"><label class="flbl">Auto-Stop After (min, 0 = off)</label><input class="finput" type="number" name="autoStopMinutes" value="${cfg.autoStopMinutes||0}" min="0"/></div>
        <div class="fld"><label class="flbl">Start Message</label><input class="finput" type="text" name="loopStartMsg" value="${esc(cfg.loopStartMsg||'')}" placeholder="Sent when loop starts (blank = none)"/></div>
        <div class="fld"><label class="flbl">Stop Message</label><input class="finput" type="text" name="loopStopMsg" value="${esc(cfg.loopStopMsg||'')}" placeholder="Sent when loop stops (blank = none)"/></div>
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="reactOnlyMode" value="1" ${cfg.reactOnlyMode?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>React-only mode (no images)</span></label>
    </div>
</div>
</div>
<div>
<div class="section-hd">PM Loop</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-g">PM</span><span class="box-title">Trigger via Dot</span></div>
    <div class="cfg-body">
        <div class="info-block">
            <div class="ib-title">How to start a PM loop</div>
            <div class="ib-row"><code>.</code><span>Toggle loop in current chat (group or PM)</span></div>
            <div class="ib-row"><code>. 61234567890</code><span>Loop PM by Facebook UID</span></div>
            <div class="ib-row"><code>. John</code><span>Search friends by name, loop their PM</span></div>
            <div class="ib-row"><code>!looppm &lt;uid&gt;</code><span>Start PM loop via command</span></div>
            <div class="ib-row"><code>!stoppm &lt;uid&gt;</code><span>Stop PM loop via command</span></div>
        </div>
    </div>
</div>
</div>
</div>
</div>

<!-- AUTO-RESPOND -->
<div class="cfg-cat" id="cat-autorespond" style="display:none">
<div class="two-col">
<div>
<div class="section-hd">Auto-Respond</div>
<div class="box">
    <div class="box-hd"><span class="chip">AUTO</span><span class="box-title">Behavior Settings</span></div>
    <div class="cfg-body">
        <div class="fld fhint-top">Enable with <code>!on</code> in a group. Disable with <code>!off</code>.</div>
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="greetNewMembers" value="1" ${cfg.greetNewMembers?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Greet new members when they join</span></label>
        <div class="fld"><label class="flbl">Welcome Message</label><input class="finput" type="text" name="greetMsg" value="${esc(cfg.greetMsg||'Welcome! 👋')}" placeholder="For new members"/></div>
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="autoSeenEnabled" value="1" ${cfg.autoSeenEnabled?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Auto mark messages as seen</span></label>
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="typingSimulate" value="1" ${cfg.typingSimulate?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Simulate typing indicator</span></label>
    </div>
</div>
</div>
<div>
<div class="section-hd">Anti-Spam</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-r">SPAM</span><span class="box-title">Anti-Spam Kick</span></div>
    <div class="cfg-body">
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="antiSpamEnabled" value="1" ${cfg.antiSpamEnabled?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Auto-kick spammers (groups only)</span></label>
        <div class="fld"><label class="flbl">Max Messages Before Kick</label><input class="finput" type="number" name="antiSpamMaxMsg" value="${cfg.antiSpamMaxMsg||5}" min="2"/></div>
        <div class="fld"><label class="flbl">Detection Window (seconds)</label><input class="finput" type="number" name="antiSpamWindowSec" value="${cfg.antiSpamWindowSec||10}" min="3"/></div>
    </div>
</div>
</div>
</div>
</div>

<!-- AUTO-REACT -->
<div class="cfg-cat" id="cat-react" style="display:none">
<div class="two-col">
<div>
<div class="section-hd">Auto-React</div>
<div class="box">
    <div class="box-hd"><span class="chip">REACT</span><span class="box-title">React to Every Message</span></div>
    <div class="cfg-body">
        <div class="fld fhint-top">Bot automatically reacts to every incoming message with the chosen emoji.</div>
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="autoReactEnabled" value="1" ${cfg.autoReactEnabled?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Enable auto-react</span></label>
        <div class="fld"><label class="flbl">Reaction Emoji</label><input class="finput" type="text" name="autoReactEmoji" value="${esc(cfg.autoReactEmoji||'😆')}" maxlength="8"/></div>
    </div>
</div>
</div>
<div>
<div class="section-hd">Loop Reactions</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-g">LOOP</span><span class="box-title">Per-Message Reactions</span></div>
    <div class="cfg-body">
        <div class="info-block">
            <div class="ib-title">About loop reactions</div>
            <div style="color:var(--t3);font-size:12px;line-height:1.8">Bot reacts to its own loop messages with the Loop Reaction Emoji.<br>Currently set to: <b style="font-size:18px">${esc(cfg.loopReact||'😆')}</b><br>Change it in the <b>Loop</b> tab.</div>
        </div>
    </div>
</div>
</div>
</div>
</div>

<!-- SILENT -->
<div class="cfg-cat" id="cat-silent" style="display:none">
<div class="two-col">
<div>
<div class="section-hd">Silent Mode</div>
<div class="box">
    <div class="box-hd"><span class="chip">SILENT</span><span class="box-title">No-Notification Sends</span></div>
    <div class="cfg-body">
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="silentMode" value="1" ${cfg.silentMode?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Auto-respond with silent mode</span></label>
        <label class="toggle-row"><input class="tcheck" type="checkbox" name="loopSilentMode" value="1" ${cfg.loopSilentMode?"checked":""}><span class="ttrack"><span class="tthumb"></span></span><span>Loop messages with silent mode</span></label>
    </div>
</div>
</div>
<div>
<div class="section-hd">How It Works</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-p">INFO</span><span class="box-title">Silent Delivery</span></div>
    <div class="cfg-body">
        <div class="info-block">
            <div class="ib-row"><span style="color:#22c55e">✓</span><span>Message delivered normally — still readable</span></div>
            <div class="ib-row"><span>🔕</span><span>No push notification on recipient device</span></div>
            <div class="ib-row"><span>👻</span><span>/silent prefix hidden — chat looks clean</span></div>
            <div class="ib-row"><span>🤖</span><span>Bypasses bots that trigger on notifications</span></div>
        </div>
    </div>
</div>
</div>
</div>
</div>

<!-- SECURITY -->
<div class="cfg-cat" id="cat-security" style="display:none">
<div class="two-col">
<div>
<div class="section-hd">Group Lock</div>
<div class="box">
    <div class="box-hd"><span class="chip">LOCK</span><span class="box-title">Lock Protections</span></div>
    <div class="cfg-body">
        <div class="fld fhint-top">All locks restore in &lt;80ms automatically.</div>
        <div class="info-block">
            <div class="ib-row"><code>!nn &lt;name&gt;</code><span>Lock all nicknames</span></div>
            <div class="ib-row"><code>!nn1 &lt;uid&gt; &lt;n&gt;</code><span>Lock one nickname</span></div>
            <div class="ib-row"><code>!clearnn</code><span>Remove nickname lock</span></div>
            <div class="ib-row"><code>!cg &lt;name&gt;</code><span>Lock group name</span></div>
            <div class="ib-row"><code>!uncg</code><span>Unlock group name</span></div>
            <div class="ib-row"><code>!banner [url]</code><span>Lock group photo</span></div>
            <div class="ib-row"><code>!unbanner</code><span>Unlock group photo</span></div>
            <div class="ib-row"><code>!freeze / !unfreeze</code><span>Kick non-admins on chat</span></div>
            <div class="ib-row"><code>!gmute / !gunmute</code><span>Mute-kick a specific user</span></div>
        </div>
    </div>
</div>
</div>
<div>
<div class="section-hd">Admin Tools</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-r">ADMIN</span><span class="box-title">Anti-Restrict & Perms</span></div>
    <div class="cfg-body">
        <div class="info-block">
            <div class="ib-row"><code>!antirestrict</code><span>Notify when bot is kicked</span></div>
            <div class="ib-row"><code>!promote &lt;uid&gt;</code><span>Make member a group admin</span></div>
            <div class="ib-row"><code>!demote &lt;uid&gt;</code><span>Remove admin status</span></div>
            <div class="ib-row"><code>!perms &lt;uid&gt; &lt;time&gt;</code><span>Grant temp permissions</span></div>
            <div class="ib-row"><code>!revoke [uid]</code><span>Remove temp permissions</span></div>
        </div>
    </div>
</div>
</div>
</div>
</div>

<!-- VOICE -->
<div class="cfg-cat" id="cat-voice" style="display:none">
<div class="two-col">
<div>
<div class="section-hd">Text-to-Speech</div>
<div class="box">
    <div class="box-hd"><span class="chip">TTS</span><span class="box-title">Voice Message Settings</span></div>
    <div class="cfg-body">
        <div class="fld"><label class="flbl">TTS Language</label>
            <select class="fselect" name="ttsLang">
                ${[["tl","Tagalog"],["en","English"],["ja","Japanese"],["ko","Korean"],["zh","Chinese"],["es","Spanish"],["fr","French"],["de","German"],["it","Italian"],["pt","Portuguese"],["th","Thai"],["vi","Vietnamese"],["id","Indonesian"]].map(([v,n])=>`<option value="${v}" ${cfg.ttsLang===v?"selected":""}>${n}</option>`).join("")}
            </select>
        </div>
        <div class="info-block" style="margin-top:10px">
            <div class="ib-row"><code>!vm &lt;text&gt;</code><span>Send voice in current chat</span></div>
            <div class="ib-row"><code>!vmpm &lt;uid&gt; &lt;text&gt;</code><span>Send voice to a PM</span></div>
        </div>
    </div>
</div>
</div>
<div>
<div class="section-hd">Scheduled Messages</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-g">SCHED</span><span class="box-title">Schedule Command</span></div>
    <div class="cfg-body">
        <div class="info-block">
            <div class="ib-title">Usage</div>
            <div class="ib-row"><code>!schedule &lt;sec&gt; &lt;msg&gt;</code><span>Delay 1–3600 seconds</span></div>
            <div style="color:var(--t3);font-size:11.5px;margin-top:8px">Example: <code>!schedule 60 hello</code><br>Sends "hello" after 60 seconds.</div>
        </div>
    </div>
</div>
</div>
</div>
</div>

<div class="save-row">
    <button class="btn-save" type="submit">Save Configuration</button>
</div>
</form>
<script>
function showCat(id,btn){
    document.querySelectorAll('.cfg-cat').forEach(e=>e.style.display='none');
    document.querySelectorAll('.cfg-tab').forEach(e=>e.classList.remove('active'));
    document.getElementById('cat-'+id).style.display='';
    btn.classList.add('active');
}
</script>`;

    // ── PAGE: SESSION ─────────────────────────────────────────────────
    const botCards = state.bots.length===0
        ? `<div class="notice">No bots loaded yet.</div>`
        : state.bots.map(b=>{
            const c=b.loggedIn?"#22c55e":(b.reconnecting?"#f59e0b":"#ef4444");
            const lbl=b.loggedIn?"Online":(b.reconnecting?`Reconnecting…`:"Offline / Expired");
            return `<div class="bot-row"><div class="br-name">${esc(b.label)}</div><div class="br-status" style="color:${c}">${lbl}${b.nextReconnectIn>0?` · ${b.nextReconnectIn}s`:""}</div></div>`;
        }).join("");

    const pageSession = `
<div class="two-col">
<div>
<div class="section-hd">Bot Status</div>
<div class="box">
    <div class="box-hd"><span class="chip">ACCOUNTS</span><span class="box-title">Logged-in Bots</span></div>
    <div style="padding:14px 16px;display:flex;flex-direction:column;gap:8px">${botCards}</div>
</div>
<div class="notice-box">
    <div class="nb-hd">📌 How to get a new fbstate</div>
    <ol class="nb-ol">
        <li>Install <b>Cookie Editor</b> on Chrome or Firefox</li>
        <li>Open <b>facebook.com</b>, log into the bot account</li>
        <li>Click Cookie Editor → <b>Export All</b> → copy JSON</li>
        <li>Paste in the form on the right and click Save</li>
    </ol>
</div>
</div>
<div>
<div class="section-hd">Update Cookie</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-g">UPDATE</span><span class="box-title">Paste New fbstate.json</span></div>
    <div style="padding:14px 16px">
        <div class="fhint-top warn" style="margin-bottom:10px">⚠️ Must be a JSON array starting with <code>[</code> and ending with <code>]</code></div>
        <form method="POST" action="/api/fbstate/update?tab=session">
            <textarea class="cookie-ta" name="fbstate"
                placeholder='[&#10;  {"key":"c_user","value":"..."},&#10;  {"key":"xs","value":"..."},&#10;  ...&#10;]'
                id="cookieTa" required></textarea>
            <div id="cookiePv" style="display:none" class="cookie-pv"></div>
            <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn-save" type="submit" style="flex:1">💾 Save &amp; Restart</button>
                <button class="btn-clear" type="button" onclick="document.getElementById('cookieTa').value='';document.getElementById('cookiePv').style.display='none'">Clear</button>
            </div>
        </form>
        <div class="fhint" style="margin-top:10px">Bot reconnects automatically after save — wait ~10 seconds.</div>
    </div>
</div>
</div>
</div>
<script>
document.getElementById('cookieTa').addEventListener('input',function(){
    const pv=document.getElementById('cookiePv');
    try{
        const a=JSON.parse(this.value.trim());
        if(!Array.isArray(a))throw new Error('not an array');
        const cu=a.find(c=>c.key==='c_user');
        const xs=a.find(c=>c.key==='xs');
        pv.innerHTML='✅ Valid · '+a.length+' cookies'+(cu?' · c_user: <b>'+cu.value+'</b>':'')+(xs?' · xs ✓':' · ⚠️ no xs');
        pv.className='cookie-pv pv-ok';pv.style.display='block';
    }catch(e){
        if(this.value.trim()){pv.innerHTML='❌ '+e.message;pv.className='cookie-pv pv-err';pv.style.display='block';}
        else pv.style.display='none';
    }
});
</script>`;

    // ── PAGE: COMMANDS ────────────────────────────────────────────────
    const CMDS = [
        {sec:"Loop & Messaging",chip:"LOOP",rows:[
            [". (dot)","Toggle loop ON/OFF in current chat (group or PM)"],
            [". <uid>","Toggle PM loop with a specific Facebook UID"],
            [". <name>","Search friends by name and toggle their PM loop"],
            ["!stop","Force-stop the loop in current thread"],
            ["!looppm <uid>","Start PM loop with a UID"],
            ["!stoppm <uid>","Stop PM loop with a UID"],
            ["!schedule <sec> <msg>","Send message after N seconds (1–3600)"],
            ["!say <text>","Make bot send a plain message"],
            ["!spam <n> <msg>","Send message n times (max 20)"],
            ["!forward <tid> <msg>","Send message to another thread"],
            ["!repeat <n> <text>","Stack message n times (max 10)"],
        ]},
        {sec:"Auto-Respond",chip:"AUTO",rows:[
            ["!on","Enable auto-respond in current group"],
            ["!off","Disable auto-respond"],
            ["!mute","Pause auto-respond (loop still runs)"],
            ["!unmute","Resume auto-respond"],
            ["!broadcast <text>","Send message to all auto-respond threads"],
        ]},
        {sec:"Group Management",chip:"GROUP",rows:[
            ["!nn <name>","Set + lock nickname for ALL members"],
            ["!nn1 <uid> <name>","Set + lock nickname for ONE member"],
            ["!clearnn","Clear and unlock all nicknames"],
            ["!cg <name>","Change + lock group name"],
            ["!uncg","Unlock group name"],
            ["!banner [url]","Set + lock group photo"],
            ["!unbanner","Unlock group photo"],
            ["!kick <uid>","Remove a member"],
            ["!add <uid>","Add someone to the group"],
            ["!promote <uid>","Make member a group admin"],
            ["!demote <uid>","Remove admin status"],
            ["!emoji <emoji>","Change group emoji"],
            ["!color <name>","Change chat color (blue, pink, green…)"],
            ["!freeze / !unfreeze","Kick non-admins who send a message"],
            ["!gmute <uid>","Silently kick on their next message"],
            ["!gunmute <uid>","Remove gmute"],
            ["!members","List all member UIDs"],
            ["!info","Group info — name, members, admins"],
            ["!lock","Show all active protections"],
        ]},
        {sec:"Voice & Tools",chip:"TTS",rows:[
            ["!vm <text>","Send TTS voice message in current chat"],
            ["!vmpm <uid> <text>","Send TTS voice to a PM"],
            ["!react <emoji>","React to a replied message"],
            ["!perms <uid> <time>","Grant temp permissions (30s, 5min, 1h)"],
            ["!revoke [uid]","Remove temp permissions (blank = revoke all)"],
            ["!antirestrict","Toggle kick-notification"],
            ["!seen","Mark all messages as seen"],
            ["!id","Get UID of replied message sender"],
            ["!myid","Show your own Facebook ID"],
            ["!status","Loop + auto-respond status for this thread"],
            ["!test","Ping the bot — responds 'pong'"],
            ["!help","Command list in Messenger"],
        ]},
        {sec:"Fun",chip:"FUN",rows:[
            ["!flip","Coin flip — heads or tails"],
            ["!roll [sides]","Dice roll, default 6-sided"],
            ["!8ball <q>","Magic 8 ball answer"],
            ["!pick a | b | c","Randomly pick one option"],
            ["!reverse <text>","Reverse the text"],
            ["!shout <text>","LOUD spaced-out ALL CAPS"],
            ["!mock <text>","aLtErNaTiNg cAsE"],
            ["!clap <text>","👏 between each word"],
            ["!timer <sec>","Countdown — bot pings when done"],
            ["!count","Count 1 to 20"],
        ]},
    ];

    const cmdHTML = CMDS.map(s=>`
<div class="box" style="margin-bottom:14px">
    <div class="box-hd"><span class="chip">${s.chip}</span><span class="box-title">${s.sec}</span></div>
    <table>
        <thead><tr><th style="width:220px">Command</th><th>Description</th></tr></thead>
        <tbody>${s.rows.map(([c,d])=>`<tr><td class="tc"><code>${c}</code></td><td class="td-d">${d}</td></tr>`).join("")}</tbody>
    </table>
</div>`).join("");

    const pageCommands = `<div class="section-hd">Command Reference</div>${cmdHTML}`;

    // ── ASSEMBLE ──────────────────────────────────────────────────────
    const pages = {dashboard:pageDashboard, loop:pageLoop, config:pageConfig, session:pageSession, commands:pageCommands};
    const content = pages[t] || pageDashboard;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cozy Bot${t!=="dashboard"?" · "+TABS.find(x=>x.id===t)?.label:""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0d0d;
  --s1:#141414;--s2:#1a1a1a;--s3:#202020;--s4:#272727;
  --b1:#222;--b2:#2e2e2e;--b3:#3a3a3a;
  --t1:#f2f2f2;--t2:#a0a0a0;--t3:#666;--t4:#3c3c3c;
  --bl:#3b82f6;--bl2:#60a5fa;--bl3:#93c5fd;
  --gn:#16a34a;--gn2:#22c55e;--gn3:#4ade80;
  --rd:#dc2626;--rd2:#ef4444;--rd3:#f87171;
  --yw:#d97706;--yw2:#f59e0b;--yw3:#fbbf24;
  --pu:#7c3aed;--pu2:#a855f7;--pu3:#c084fc;
  --or:#ea580c;--or2:#f97316;--or3:#fb923c;
  --mono:'JetBrains Mono',monospace;
  --sans:'Inter',sans-serif;
  --r:8px;--r2:10px;--r3:12px;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--t1);font-family:var(--sans);font-size:13.5px;line-height:1.6;display:flex;flex-direction:column}

/* ── TOPBAR ── */
.topbar{height:52px;flex-shrink:0;background:var(--s1);border-bottom:1px solid var(--b2);display:flex;align-items:center;padding:0 20px;gap:16px}
.logo{display:flex;align-items:center;gap:10px}
.logo-mark{width:30px;height:30px;border-radius:var(--r);background:linear-gradient(135deg,#2563eb,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.logo-text{font-weight:700;font-size:14px;color:var(--t1);letter-spacing:-.01em}
.logo-badge{font-size:9px;font-weight:700;color:var(--t3);background:var(--s3);border:1px solid var(--b2);border-radius:4px;padding:1px 7px;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono)}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:11.5px;font-family:var(--mono);color:var(--t3)}
.tb-right b{color:var(--t2)}
.live-dot{display:flex;align-items:center;gap:5px}
.ld{width:6px;height:6px;border-radius:50%;background:var(--gn2);box-shadow:0 0 6px var(--gn2);animation:pulse 2.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}

/* ── NAV ── */
.nav{height:42px;flex-shrink:0;background:var(--s1);border-bottom:1px solid var(--b1);display:flex;align-items:stretch;padding:0 12px;gap:2px;overflow-x:auto}
.nav::-webkit-scrollbar{display:none}
.nav-item{display:flex;align-items:center;gap:7px;padding:0 14px;font-size:12.5px;font-weight:500;color:var(--t3);text-decoration:none;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
.nav-item:hover{color:var(--t2)}
.nav-item.active{color:var(--t1);border-bottom-color:var(--bl)}
.nav-item svg{flex-shrink:0}

/* ── SCROLL AREA ── */
.page{flex:1;overflow-y:auto;padding:22px 22px 60px}
.page::-webkit-scrollbar{width:4px}
.page::-webkit-scrollbar-thumb{background:var(--b3);border-radius:99px}

/* ── HERO ── */
.hero{background:var(--s1);border:1px solid var(--b2);border-radius:var(--r3);padding:22px 24px;margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.hero-left{display:flex;align-items:center;gap:16px}
.hero-avatar{width:52px;height:52px;border-radius:var(--r2);background:linear-gradient(135deg,#1d4ed8,#6d28d9);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.hero-title{font-size:20px;font-weight:800;letter-spacing:-.03em;margin-bottom:2px}
.hero-ver{font-size:11px;font-weight:600;color:var(--t3);background:var(--s3);border:1px solid var(--b2);border-radius:4px;padding:1px 8px;vertical-align:middle;margin-left:6px;font-family:var(--mono)}
.hero-desc{font-size:12px;color:var(--t3);margin-bottom:10px}
.pill-row{display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-family:var(--mono);padding:3px 10px;border-radius:6px;border:1px solid var(--b2);background:var(--s2);color:var(--t3)}
.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.pill-on{color:var(--gn3);border-color:#16a34a30;background:#16a34a0a}
.pill-on i{animation:pulse 2.5s infinite}
.pill-warn{color:var(--yw3);border-color:#d9780630}
.pill-off{color:var(--t3)}
.pill-off i{opacity:.3;animation:none}

/* ── STATUS PILL ── */
.status-pill{display:flex;align-items:center;gap:7px;padding:6px 14px;border-radius:99px;font-size:12px;font-weight:600;font-family:var(--mono);border:1px solid transparent;flex-shrink:0;align-self:flex-start}
.st-on{color:var(--gn3);background:#16a34a0f;border-color:#16a34a28}
.st-warn{color:var(--yw3);background:#d978060f;border-color:#d9780628}
.st-off{color:var(--rd3);background:#dc26260f;border-color:#dc262628}
.sp-dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 2.5s infinite}

/* ── STAT GRID ── */
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
@media(max-width:720px){.stat-grid{grid-template-columns:1fr 1fr}}
.stat-card{background:var(--s1);border:1px solid var(--b2);border-radius:var(--r2);padding:18px 18px 14px;position:relative;overflow:hidden;transition:border-color .15s,transform .1s}
.stat-card:hover{border-color:var(--b3);transform:translateY(-1px)}
.stat-card::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;border-radius:var(--r2) var(--r2) 0 0}
.sc-blue::before{background:linear-gradient(90deg,#1d4ed8,#3b82f6)}
.sc-green::before{background:linear-gradient(90deg,#15803d,#22c55e)}
.sc-purple::before{background:linear-gradient(90deg,#6d28d9,#a855f7)}
.sc-orange::before{background:linear-gradient(90deg,#c2410c,#f97316)}
.sc-icon{font-size:18px;margin-bottom:10px}
.sc-val{font-size:32px;font-weight:800;font-family:var(--mono);line-height:1;margin-bottom:4px;color:var(--t1)}
.sc-val-sm{font-size:22px}
.sc-label{font-size:11px;color:var(--t3);font-weight:500}
.sc-sub{font-size:10px;color:var(--t4);display:block;margin-top:1px}

/* ── SECTION HEADING ── */
.section-hd{font-size:9px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.18em;margin-bottom:10px;display:flex;align-items:center;gap:10px}
.section-hd::after{content:'';flex:1;height:1px;background:var(--b1)}

/* ── BOX / PANEL ── */
.box{background:var(--s1);border:1px solid var(--b2);border-radius:var(--r2);overflow:hidden;margin-bottom:16px}
.box-hd{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--s2);border-bottom:1px solid var(--b1)}
.box-title{font-size:12px;font-weight:600;color:var(--t2);flex:1}
.box-meta{font-size:11px;color:var(--t3);font-family:var(--mono)}

/* ── CHIP / BADGE ── */
.chip{font-size:8px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;padding:2px 8px;border-radius:5px;background:var(--s3);border:1px solid var(--b3);color:var(--t2)}
.chip-g{background:#15803d12;border-color:#15803d28;color:var(--gn3)}
.chip-p{background:#6d28d912;border-color:#6d28d928;color:var(--pu3)}
.chip-r{background:#dc262612;border-color:#dc262628;color:var(--rd3)}
.chip-b{background:#1d4ed812;border-color:#1d4ed828;color:var(--bl3)}

/* ── TAGS ── */
.tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;font-family:var(--mono);padding:2px 8px;border-radius:5px}
.tag-g{background:#15803d14;color:var(--gn3);border:1px solid #15803d28}
.tag-b{background:#1d4ed814;color:var(--bl3);border:1px solid #1d4ed828}
.tag-y{background:#d9780614;color:var(--yw3);border:1px solid #d9780628}
.tag-dim{background:var(--s3);color:var(--t4);border:1px solid var(--b2)}

/* ── TABLE ── */
table{width:100%;border-collapse:collapse}
th{padding:8px 14px;text-align:left;font-size:9px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.14em;border-bottom:1px solid var(--b1);background:var(--s2)}
td{padding:9px 14px;border-bottom:1px solid var(--b1);color:var(--t2);font-size:12.5px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff02}
.td-mono{font-family:var(--mono);font-size:11px;color:var(--t3)}
.td-empty{text-align:center;color:var(--t3);padding:28px;font-size:12.5px}
.tc{width:1%;white-space:nowrap;padding-right:4px}
.tc code{font-size:11.5px;color:var(--bl2)}
.td-d{color:var(--t3);font-size:12px}

/* ── LOGS ── */
.log-area{background:var(--bg);max-height:360px;overflow-y:auto;font-family:var(--mono);font-size:10.5px}
.log-area::-webkit-scrollbar{width:3px}
.log-area::-webkit-scrollbar-thumb{background:var(--b3);border-radius:99px}
.lr{display:flex;gap:10px;padding:3.5px 14px;border-bottom:1px solid #ffffff04;line-height:1.5}
.lr:hover{background:#ffffff02}
.lt{color:var(--t4);font-size:9.5px;flex-shrink:0;min-width:66px;padding-top:1px}
.ll{font-size:8.5px;font-weight:700;flex-shrink:0;min-width:32px;padding-top:2px;text-transform:uppercase;color:var(--t4)}
.lm{color:var(--t3);word-break:break-word;flex:1;font-size:10.5px}
.lr-error .ll{color:var(--rd3)} .lr-error .lm{color:#fca5a5}
.lr-warn  .ll{color:var(--yw3)} .lr-warn  .lm{color:#fde68a}
.lr-reply .ll{color:var(--gn3)} .lr-reply .lm{color:#86efac}
.lr-info  .ll{color:var(--bl3)} .lr-info  .lm{color:var(--t3)}
.lr-idle  .ll,.lr-idle .lm{color:var(--t4)}

/* ── QUEUE ── */
.add-row{display:flex;gap:8px;padding:11px 13px;border-bottom:1px solid var(--b1)}
.add-input{flex:1;background:var(--bg);border:1px solid var(--b2);border-radius:var(--r);padding:7px 11px;color:var(--t1);font-size:12.5px;font-family:var(--mono);outline:none;transition:border-color .15s}
.add-input:focus{border-color:var(--bl)}
.add-input::placeholder{color:var(--t4)}
.btn-add{background:#1d4ed8;color:#fff;border:none;border-radius:var(--r);padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn-add:hover{background:#2563eb}
.q-list{max-height:340px;overflow-y:auto}
.q-list::-webkit-scrollbar{width:3px}
.q-list::-webkit-scrollbar-thumb{background:var(--b3);border-radius:99px}
.q-empty{color:var(--t4);text-align:center;padding:24px;font-size:12px}
.qi{display:flex;align-items:center;gap:10px;padding:7px 13px;border-bottom:1px solid var(--b1);transition:background .1s}
.qi:last-child{border-bottom:none}
.qi:hover{background:#ffffff02}
.qi-num{font-size:10px;color:var(--t4);min-width:22px;font-family:var(--mono)}
.qi-text{color:var(--t2);font-size:12px;word-break:break-all;flex:1;font-family:var(--mono)}
.qi-url{color:var(--bl2);font-size:10.5px}
.btn-rm{background:transparent;color:var(--t4);border:1px solid var(--b2);border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;transition:all .15s}
.btn-rm:hover{background:#dc262618;border-color:#dc262640;color:var(--rd3)}

/* ── TWO COL ── */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:780px){.two-col{grid-template-columns:1fr}}

/* ── CONFIG TABS ── */
.cfg-scroll-wrap{overflow-x:auto;margin-bottom:16px}
.cfg-scroll-wrap::-webkit-scrollbar{display:none}
.cfg-tabs{display:flex;gap:6px;min-width:max-content}
.cfg-tab{background:var(--s2);border:1px solid var(--b2);border-radius:99px;padding:6px 16px;font-size:12px;font-weight:500;color:var(--t3);cursor:pointer;transition:all .15s;font-family:var(--sans)}
.cfg-tab:hover{color:var(--t2);border-color:var(--b3)}
.cfg-tab.active{background:#1d4ed818;border-color:#3b82f640;color:var(--bl2)}

/* ── FORM ── */
.cfg-body{padding:14px 15px}
.fld{margin-bottom:12px}
.flbl{display:block;font-size:9px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.13em;margin-bottom:4px}
.finput,.fselect{width:100%;background:var(--bg);border:1px solid var(--b2);border-radius:var(--r);padding:7px 10px;color:var(--t1);font-size:12.5px;font-family:var(--mono);outline:none;transition:border-color .15s}
.fselect{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23555' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;cursor:pointer}
.finput:focus,.fselect:focus{border-color:var(--bl)}
.fhint{font-size:10px;color:var(--t4);margin-top:3px;line-height:1.5}
.fhint-top{font-size:11.5px;color:var(--t3);margin-bottom:13px;line-height:1.6}
.fhint-top.warn{color:var(--yw3)}

/* ── TOGGLE ── */
.toggle-row{display:flex;align-items:center;gap:10px;margin-bottom:11px;cursor:pointer;font-size:12.5px;color:var(--t2);user-select:none}
.tcheck{display:none}
.ttrack{width:36px;height:20px;border-radius:99px;background:var(--b3);position:relative;flex-shrink:0;transition:background .2s;cursor:pointer}
.tcheck:checked~.ttrack{background:var(--bl)}
.tthumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s}
.tcheck:checked~.ttrack .tthumb{transform:translateX(16px)}

/* ── INFO BLOCK ── */
.info-block{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r);padding:12px 14px}
.ib-title{font-size:9.5px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.13em;margin-bottom:8px}
.ib-row{display:flex;align-items:baseline;gap:10px;padding:3px 0;font-size:12px;color:var(--t3);border-bottom:1px solid var(--b1);line-height:1.6}
.ib-row:last-child{border-bottom:none}
.ib-row code{flex-shrink:0;color:var(--bl2)}
.ib-row span{color:var(--t3)}

/* ── SAVE ── */
.save-row{display:flex;justify-content:center;margin-top:6px;padding-bottom:20px}
.btn-save{background:#1d4ed8;color:#fff;border:none;border-radius:var(--r);padding:10px 32px;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s;font-family:var(--sans)}
.btn-save:hover{background:#2563eb}

/* ── SESSION ── */
.bot-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--b1)}
.bot-row:last-child{border-bottom:none}
.br-name{font-weight:600;font-size:13px;color:var(--t1)}
.br-status{font-size:12px;font-family:var(--mono)}
.notice-box{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:16px 18px}
.nb-hd{font-size:10.5px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}
.nb-ol{padding-left:18px;font-size:12.5px;color:var(--t3);line-height:2}
.nb-ol b{color:var(--t2)}
.cookie-ta{width:100%;background:var(--bg);border:1px solid var(--b2);border-radius:var(--r);padding:10px 12px;color:var(--t1);font-family:var(--mono);font-size:10.5px;outline:none;resize:vertical;min-height:180px;transition:border-color .15s;line-height:1.6}
.cookie-ta:focus{border-color:var(--bl)}
.cookie-ta::placeholder{color:var(--t4)}
.cookie-pv{padding:7px 11px;border-radius:6px;font-size:11px;font-family:var(--mono);margin-top:8px}
.pv-ok{background:#15803d12;border:1px solid #15803d28;color:var(--gn3)}
.pv-err{background:#dc262612;border:1px solid #dc262628;color:var(--rd3)}
.btn-clear{background:var(--s3);color:var(--t3);border:1px solid var(--b2);border-radius:var(--r);padding:10px 16px;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s}
.btn-clear:hover{background:var(--s4);color:var(--t2)}
.notice{color:var(--t3);font-size:12.5px;padding:20px;text-align:center}

/* ── INLINE CODE ── */
code{background:var(--s3);border:1px solid var(--b2);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:11.5px;color:var(--bl2)}

${t==="dashboard"?`<meta http-equiv="refresh" content="10"/>`:``}
</style>
</head>
<body>
<!-- TOPBAR -->
<div class="topbar">
    <div class="logo">
        <div class="logo-mark">🤖</div>
        <span class="logo-text">Cozy Bot</span>
        <span class="logo-badge">v2.2</span>
    </div>
    <div class="tb-right">
        <span>dev <b>${esc(state.developerID||"—")}</b></span>
        <div class="live-dot"><div class="ld"></div>${t==="dashboard"?"auto-refresh":"static"}</div>
    </div>
</div>

<!-- NAV -->
<nav class="nav">${navLinks}</nav>

<!-- PAGE -->
<div class="page">${content}</div>
</body>
</html>`;
}

function startDashboard(port=5000) {
    const server = http.createServer(async(req,res)=>{
        const url   = new URL(req.url, "http://localhost");
        const path2 = url.pathname;
        const tab   = url.searchParams.get("tab") || "dashboard";

        function redirect(t){ res.writeHead(302,{Location:t?`/?tab=${t}`:"/"});res.end(); }
        function htmlErr(msg){ res.writeHead(200,{"Content-Type":"text/html"});res.end(`<!DOCTYPE html><html><body style="background:#0d0d0d;color:#f87171;font-family:monospace;padding:40px"><h3>❌ ${msg}</h3><br><a href="/" style="color:#60a5fa">← Go back</a></body></html>`); }

        try {
            if (path2==="/api/replies/add" && req.method==="POST") {
                const p = await parseBody(req);
                const w = (p.word||"").trim();
                if(w){ const a=readCustomReplies(); a.push(w); writeCustomReplies(a); }
                redirect(tab); return;
            }
            if (path2==="/api/replies/remove" && req.method==="POST") {
                const p = await parseBody(req);
                const idx = parseInt(p.index);
                if(!isNaN(idx)){ const a=readCustomReplies(); if(idx>=0&&idx<a.length)a.splice(idx,1); writeCustomReplies(a); }
                redirect(tab); return;
            }
            if (path2==="/api/images/add" && req.method==="POST") {
                const p = await parseBody(req);
                const u = (p.url||"").trim();
                if(u&&u.startsWith("http")){ const a=readImageReplies(); a.push(u); writeImageReplies(a); }
                redirect(tab); return;
            }
            if (path2==="/api/images/remove" && req.method==="POST") {
                const p = await parseBody(req);
                const idx = parseInt(p.index);
                if(!isNaN(idx)){ const a=readImageReplies(); if(idx>=0&&idx<a.length)a.splice(idx,1); writeImageReplies(a); }
                redirect(tab); return;
            }
            if (path2==="/api/config/save" && req.method==="POST") {
                const p = await parseBody(req);
                const cfg = readBotConfig();
                if(p.loopReact!==undefined)        cfg.loopReact         = p.loopReact.trim()||"😆";
                if(p.loopDelay!==undefined)        cfg.loopDelay         = Math.max(1,parseInt(p.loopDelay)||1);
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
                cfg.autoReactEnabled = p.autoReactEnabled==="1";
                if(p.autoReactEmoji!==undefined)   cfg.autoReactEmoji    = p.autoReactEmoji.trim()||"😆";
                writeBotConfig(cfg);
                redirect(tab); return;
            }
            if (path2==="/api/fbstate/update" && req.method==="POST") {
                const raw = await readRawBody(req);
                const eqIdx = raw.indexOf("fbstate=");
                let jsonStr = "";
                if (eqIdx !== -1) jsonStr = decodeURIComponent(raw.slice(eqIdx+8).replace(/\+/g," "));
                jsonStr = jsonStr.trim();
                if(!jsonStr){ htmlErr("No data received."); return; }
                let parsed;
                try{ parsed=JSON.parse(jsonStr); }catch(e){ htmlErr("Invalid JSON: "+String(e).replace(/</g,"&lt;")); return; }
                if(!Array.isArray(parsed)){ htmlErr("fbstate must be a JSON array [ {...}, ... ]"); return; }
                if(!parsed.some(c=>c.key==="c_user")){ htmlErr("No c_user cookie — is this really an fbstate?"); return; }
                fs.writeFileSync(FBSTATE_FILE,JSON.stringify(parsed,null,2),"utf8");
                addLog("info","✅ fbstate updated — bot reconnecting…");
                redirect(tab); return;
            }
            if (path2==="/api/state" && req.method==="GET") {
                res.writeHead(200,{"Content-Type":"application/json"});
                res.end(JSON.stringify({logs,state})); return;
            }
            let html;
            try{ html=buildHTML(tab); }
            catch(e){ html=`<!DOCTYPE html><html><body style="background:#0d0d0d;color:#f87171;font-family:monospace;padding:40px"><h2>Render error</h2><pre>${String(e)}</pre><meta http-equiv="refresh" content="5"/></body></html>`; }
            res.writeHead(200,{"Content-Type":"text/html"});
            res.end(html);
        } catch(e) {
            try{res.writeHead(500);res.end("Server error: "+e.message);}catch(_){}
        }
    });
    server.on("error",err=>console.error("[cozy-bot] Dashboard error:",err));
    server.listen(port,"0.0.0.0",()=>console.log(`[cozy-bot] Dashboard running on port ${port}`));
}

module.exports = { startDashboard, addLog, state };
