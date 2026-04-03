"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const CUSTOM_REPLIES_FILE   = path.join(__dirname, "../data/custom_replies.json");
const IMAGE_REPLIES_FILE    = path.join(__dirname, "../data/image_replies.json");
const BOT_CONFIG_FILE       = path.join(__dirname, "../data/bot_config.json");
const FBSTATE_FILE          = path.join(__dirname, "../data/fbstate.json");
const CUSTOM_COMMANDS_FILE  = path.join(__dirname, "../data/custom_commands.json");
const WHITELIST_FILE        = path.join(__dirname, "../data/whitelist.json");
const THREAD_CONFIG_FILE    = path.join(__dirname, "../data/thread_config.json");
const DATA_DIR              = path.join(__dirname, "../data");
const MAX_LOGS = 200;
const logs = [];
const alerts = [];

const state = {
    bots: [],
    developerID: "",
    loopEnabled: {},
    autoRespondEnabled: {},
    mutedThreads: {},
    totalRepliesSent: 0,
    startedAt: new Date(),
    botName: "",
    loginInProgress: false,
    get loggedIn()    { return this.bots.some(b => b.loggedIn); },
    get reconnecting(){ return !this.loggedIn && this.bots.some(b => b.reconnecting); },
};

let _cookieUpdateCb = null;
function setCookieUpdateHandler(cb) { _cookieUpdateCb = cb; }

let _loopControlCb = null;
function setLoopControlHandler(cb) { _loopControlCb = cb; }

const msgTimestamps = [];
function trackMessage() {
    msgTimestamps.push(Date.now());
    const cutoff = Date.now() - 24*3600*1000;
    while (msgTimestamps.length && msgTimestamps[0] < cutoff) msgTimestamps.shift();
}
function getHourlyStats() {
    const now = Date.now();
    const buckets = new Array(24).fill(0);
    for (const ts of msgTimestamps) {
        const h = Math.floor((now - ts) / 3600000);
        if (h < 24) buckets[23 - h]++;
    }
    return buckets;
}
function addAlert(type, message) {
    const entry = { time: new Date().toLocaleTimeString(), type, message };
    alerts.unshift(entry);
    if (alerts.length > 50) alerts.pop();
}

function readCustomCommands() { try{return JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE,"utf8"));}catch(_){return[];} }
function writeCustomCommands(a){ fs.writeFileSync(CUSTOM_COMMANDS_FILE,JSON.stringify(a,null,2),"utf8"); }
function readWhitelist() { try{return JSON.parse(fs.readFileSync(WHITELIST_FILE,"utf8"));}catch(_){return{enabled:false,uids:[]};} }
function writeWhitelist(w){ fs.writeFileSync(WHITELIST_FILE,JSON.stringify(w,null,2),"utf8"); }
function readThreadConfig() { try{return JSON.parse(fs.readFileSync(THREAD_CONFIG_FILE,"utf8"));}catch(_){return {};} }
function writeThreadConfig(c){ fs.writeFileSync(THREAD_CONFIG_FILE,JSON.stringify(c,null,2),"utf8"); }

function getFbstateFiles() {
    try {
        return fs.readdirSync(DATA_DIR)
            .filter(f => /^fbstate.*\.json$/i.test(f))
            .sort();
    } catch(_) { return ["fbstate.json"]; }
}

function resetAll() {
    logs.splice(0, logs.length);
    state.totalRepliesSent = 0;
    state.startedAt        = new Date();
    state.loopEnabled      = {};
    state.autoRespondEnabled = {};
    state.mutedThreads     = {};
    state.bots             = [];
    state.botName          = "";
    state.loginInProgress  = true;
}

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
    const hasFbstate    = (() => { try { const d = JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8")); return Array.isArray(d)&&d.length>0; } catch(_){ return false; } })();
    const customReplies = readCustomReplies();
    const imageReplies  = readImageReplies();

    const TABS = [
        {id:"dashboard", label:"Dashboard",    icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`},
        {id:"loop",      label:"Loop Queue",   icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`},
        {id:"threads",   label:"Threads",      icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`},
        {id:"cmds",      label:"Custom Cmds",  icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`},
        {id:"config",    label:"Config",       icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`},
        {id:"session",   label:"Cookie",       icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`},
        {id:"commands",  label:"Commands",     icon:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`},
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
    <div class="hero-glow"></div>
    <div class="hero-content">
        <div class="hero-left">
            <div class="hero-avatar">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/></svg>
            </div>
            <div class="hero-info">
                <h1 class="hero-title">Cozy Bot <span class="hero-ver">v2.2</span></h1>
                <p class="hero-desc">loop · auto-respond · lock · pm-loop · tts · group tools</p>
                <div class="pill-row">${botPills}</div>
            </div>
        </div>
        <div class="status-pill ${statusClass}">
            <span class="sp-dot"></span>${statusLabel}
        </div>
    </div>
</div>

<div class="stat-grid">
    <div class="stat-card sc-blue">
        <div class="sc-glow sc-glow-blue"></div>
        <div class="sc-icon-wrap sc-iw-blue">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="sc-val">${state.totalRepliesSent}</div>
        <div class="sc-label">Messages Sent</div>
    </div>
    <div class="stat-card sc-cyan">
        <div class="sc-glow sc-glow-cyan"></div>
        <div class="sc-icon-wrap sc-iw-cyan">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </div>
        <div class="sc-val">${loopCount}</div>
        <div class="sc-label">Active Loops</div>
    </div>
    <div class="stat-card sc-purple">
        <div class="sc-glow sc-glow-purple"></div>
        <div class="sc-icon-wrap sc-iw-purple">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
        </div>
        <div class="sc-val">${arCount}</div>
        <div class="sc-label">Auto-Respond <span class="sc-sub">${mutedCount} muted</span></div>
    </div>
    <div class="stat-card sc-emerald">
        <div class="sc-glow sc-glow-emerald"></div>
        <div class="sc-icon-wrap sc-iw-emerald">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="sc-val sc-val-sm">${getUptime()}</div>
        <div class="sc-label">Uptime</div>
    </div>
</div>

<div class="section-hd">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
    Thread Registry
</div>
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

<div class="section-hd" style="margin-top:20px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    Message Rate (Last 24h)
</div>
<div class="box" style="padding:12px 16px">
    <div class="box-hd" style="margin-bottom:10px"><span class="chip">GRAPH</span><span class="box-title">Hourly Message Volume</span></div>
    <div class="rate-graph" id="rateGraph">
        ${(()=>{const b=getHourlyStats();const mx=Math.max(...b,1);return b.map((v,i)=>{const pct=Math.round((v/mx)*100);const hr=(new Date().getHours()-23+i+24)%24;const label=`${String(hr).padStart(2,"0")}:00`;return `<div class="rg-col"><div class="rg-bar-wrap"><div class="rg-bar" style="height:${pct}%" title="${v} msgs at ${label}"></div></div><div class="rg-label">${hr%6===0?label:""}</div></div>`;}).join("")})()}
    </div>
</div>

${alerts.length>0?`
<div class="section-hd" style="margin-top:16px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
    Notification Feed
</div>
<div class="box" style="padding:0">
    <div class="box-hd"><span class="chip chip-y">ALERTS</span><span class="box-title">Recent Events</span><span class="box-meta">${alerts.length} alerts</span></div>
    <div class="log-area">${alerts.map(a=>`<div class="log-row log-${a.type==="error"?"e":a.type==="warn"?"w":"i"}"><span class="log-ts">${esc(a.time)}</span><span class="log-lv">${a.type.toUpperCase()}</span><span class="log-msg">${esc(a.message)}</span></div>`).join("")}</div>
</div>`:""}

<div class="section-hd" style="margin-top:20px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    Live Console
</div>
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
            const cls=b.loggedIn?"br-online":(b.reconnecting?"br-warn":"br-off");
            const lbl=b.loggedIn?"Online":(b.reconnecting?`Reconnecting…`:"Offline / Expired");
            return `<div class="bot-row ${cls}">
                <div class="br-dot"></div>
                <div class="br-name">${esc(b.label)}</div>
                <div class="br-status">${lbl}${b.nextReconnectIn>0?` · ${b.nextReconnectIn}s`:""}</div>
            </div>`;
        }).join("");

    const pageSession = `
<div class="cookie-intro">
    <div class="ci-bg">
        <svg class="ci-blob" viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg"><defs><filter id="blur1"><feGaussianBlur stdDeviation="80"/></filter></defs><g filter="url(#blur1)"><ellipse cx="180" cy="200" rx="180" ry="140" fill="#2563eb" opacity=".18"/><ellipse cx="420" cy="380" rx="160" ry="120" fill="#7c3aed" opacity=".14"/><ellipse cx="300" cy="100" rx="120" ry="80" fill="#06b6d4" opacity=".10"/></g></svg>
    </div>
    <div class="ci-card">
        <div class="ci-logo">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="url(#lg1)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="lg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient></defs><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <h2 class="ci-title">Enter Your Cookie</h2>
        <p class="ci-sub">Paste your Facebook <code>fbstate</code> JSON to connect the bot</p>

        <div class="ci-steps">
            <div class="ci-step"><div class="cs-num">1</div><div class="cs-text">Install <b>Cookie Editor</b> on Chrome or Firefox</div></div>
            <div class="ci-step"><div class="cs-num">2</div><div class="cs-text">Open <b>facebook.com</b> — log in to the bot account</div></div>
            <div class="ci-step"><div class="cs-num">3</div><div class="cs-text">Click Cookie Editor → <b>Export All</b> → copy the JSON</div></div>
            <div class="ci-step"><div class="cs-num">4</div><div class="cs-text">Paste it below and hit <b>Connect Bot</b></div></div>
        </div>

        <form method="POST" action="/api/fbstate/update?tab=session" class="ci-form">
            <div class="ci-ta-wrap">
                <textarea class="ci-ta" name="fbstate" id="cookieTa" required
                    placeholder='[&#10;  {"key":"c_user","value":"100000..."},&#10;  {"key":"xs","value":"..."},&#10;  ...&#10;]'></textarea>
                <div class="ci-ta-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </div>
            </div>
            <div id="cookiePv" style="display:none" class="cookie-pv"></div>
            <div class="ci-actions">
                <button class="ci-btn-primary" type="submit">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.1 6.1l.97-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    Connect Bot
                </button>
                <button class="ci-btn-ghost" type="button" onclick="document.getElementById('cookieTa').value='';document.getElementById('cookiePv').style.display='none'">Clear</button>
            </div>
        </form>

        <div class="ci-hint">Bot reconnects automatically — takes about 10 seconds after save.</div>
    </div>

    ${state.bots.length>0?`
    <div class="ci-bots">
        <div class="section-hd" style="margin-bottom:12px">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
            Connected Accounts
        </div>
        <div class="box"><div style="padding:4px 0">${botCards}</div></div>
    </div>`:""}
</div>

<div class="section-hd" style="margin-top:24px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    Multi-Cookie Manager
</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-p">ACCOUNTS</span><span class="box-title">Manage Multiple Bot Slots</span><span class="box-meta">${getFbstateFiles().length} slot(s)</span></div>
    <div style="padding:14px 16px;color:#888;font-size:12px;margin-bottom:4px">
        Each slot is a separate <code>fbstate*.json</code> file. Slot 1 = <code>fbstate.json</code>, Slot 2 = <code>fbstate2.json</code>, etc.
        Upload cookies to any slot independently.
    </div>
    <div style="display:grid;gap:12px;padding:0 14px 14px">${
        getFbstateFiles().concat(["fbstate2.json","fbstate3.json"]).filter((v,i,a)=>a.indexOf(v)===i).map((fname,idx)=>{
            const slotNum = idx+1;
            const bot = state.bots[idx];
            const statusTag = bot
                ? (bot.loggedIn ? `<span class="tag tag-g">Online</span>` : `<span class="tag tag-dim">Offline</span>`)
                : `<span class="tag tag-dim">Empty</span>`;
            const botName = bot?.botName || "—";
            return `<div style="background:#111;border:1px solid #222;border-radius:6px;padding:12px 14px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                    <span style="font-size:12px;color:#666">Slot ${slotNum}</span>
                    <code style="font-size:11px;color:#888">${fname}</code>
                    ${statusTag}
                    ${bot ? `<span style="font-size:12px;color:#aaa;margin-left:4px">${esc(botName)}</span>` : ""}
                </div>
                <form method="POST" action="/api/cookie/slot?tab=session" style="display:flex;gap:8px;align-items:flex-start">
                    <input type="hidden" name="slot" value="${fname}"/>
                    <textarea name="fbstate" rows="2" placeholder='[{"key":"c_user","value":"..."},...]'
                        style="flex:1;padding:7px 10px;background:#1a1a2e;border:1px solid #333;color:#eee;border-radius:5px;font-size:11px;font-family:monospace;resize:vertical"></textarea>
                    <button class="btn-add" type="submit" style="font-size:12px;padding:6px 14px;white-space:nowrap">Save Slot</button>
                </form>
            </div>`;
        }).join("")
    }</div>
</div>
<script>
document.getElementById('cookieTa').addEventListener('input',function(){
    const pv=document.getElementById('cookiePv');
    try{
        const a=JSON.parse(this.value.trim());
        if(!Array.isArray(a))throw new Error('not an array');
        const cu=a.find(c=>c.key==='c_user');
        const xs=a.find(c=>c.key==='xs');
        pv.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Valid — '+a.length+' cookies'+(cu?' &nbsp;·&nbsp; c_user: <b>'+cu.value+'</b>':'')+(xs?' &nbsp;·&nbsp; xs ✓':' &nbsp;·&nbsp; ⚠ no xs');
        pv.className='cookie-pv pv-ok';pv.style.display='flex';
    }catch(e){
        if(this.value.trim()){pv.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> '+e.message;pv.className='cookie-pv pv-err';pv.style.display='flex';}
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

    // ── PAGE: THREADS ─────────────────────────────────────────────────
    const threadCfg    = readThreadConfig();
    const wl           = readWhitelist();
    const knownThreads = Array.from(new Set([
        ...Object.keys(state.loopEnabled||{}),
        ...Object.keys(state.autoRespondEnabled||{}),
        ...Object.keys(state.mutedThreads||{}),
    ]));

    const threadRows = knownThreads.length===0
        ? `<tr><td colspan="5" style="color:#666;padding:14px;text-align:center">No known threads yet — start a loop to populate</td></tr>`
        : knownThreads.map(tid=>{
            const loop  = state.loopEnabled&&state.loopEnabled[tid];
            const ar    = state.autoRespondEnabled&&state.autoRespondEnabled[tid];
            const muted = state.mutedThreads&&state.mutedThreads[tid];
            const tc    = threadCfg[tid]||{};
            return `<tr>
                <td class="td-mono">${esc(tid)}</td>
                <td>${loop?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-dim">OFF</span>`}</td>
                <td>${ar?`<span class="tag tag-b">ON</span>`:`<span class="tag tag-dim">OFF</span>`}${muted?` <span class="tag tag-y">MUTED</span>`:""}</td>
                <td>
                    ${loop
                        ? `<form method="POST" action="/api/thread/stoploop?tab=threads" style="display:inline;margin:0"><input type="hidden" name="threadID" value="${esc(tid)}"/><button class="btn-rm" type="submit">⏹ Stop</button></form>`
                        : `<form method="POST" action="/api/thread/startloop?tab=threads" style="display:inline;margin:0"><input type="hidden" name="threadID" value="${esc(tid)}"/><button class="btn-add" type="submit" style="font-size:11px;padding:3px 10px">▶ Start</button></form>`
                    }
                </td>
                <td>
                    <form method="POST" action="/api/thread/config?tab=threads" style="display:flex;gap:6px;margin:0;align-items:center">
                        <input type="hidden" name="threadID" value="${esc(tid)}"/>
                        <input type="number" name="loopDelay" value="${tc.loopDelay!=null?tc.loopDelay:""}" placeholder="delay(s)" style="width:72px;padding:3px 6px;background:#1a1a2e;border:1px solid #333;color:#eee;border-radius:4px;font-size:11px"/>
                        <input type="text" name="loopReact" value="${tc.loopReact||""}" placeholder="emoji" style="width:52px;padding:3px 6px;background:#1a1a2e;border:1px solid #333;color:#eee;border-radius:4px;font-size:11px"/>
                        <button class="btn-add" type="submit" style="font-size:11px;padding:3px 10px">Save</button>
                    </form>
                </td>
            </tr>`;
        }).join("");

    const pageThreads = `
<div class="section-hd">Thread Manager</div>
<div class="box" style="padding:0">
    <div class="box-hd">
        <span class="chip">THREADS</span><span class="box-title">Active Threads</span>
        <span class="box-meta">${knownThreads.length} known</span>
        <form method="POST" action="/api/thread/stopall?tab=threads" style="display:inline;margin:0;margin-left:auto">
            <button class="btn-rm" type="submit" style="font-size:11px">⏹ Stop All Loops</button>
        </form>
    </div>
    <table>
        <thead><tr><th>Thread ID</th><th>Loop</th><th>Auto-Respond</th><th>Quick Actions</th><th style="width:260px">Per-Thread Config</th></tr></thead>
        <tbody>${threadRows}</tbody>
    </table>
</div>

<div class="section-hd" style="margin-top:20px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    Whitelist Mode
</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-y">WHITELIST</span><span class="box-title">Restrict Commands</span><span class="box-meta">${wl.enabled?"ENABLED":"DISABLED"}</span></div>
    <div style="padding:14px 16px">
        <form method="POST" action="/api/whitelist/toggle?tab=threads" style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
            <span style="color:#aaa;font-size:13px">Whitelist Mode: <strong style="color:${wl.enabled?"#4ade80":"#888"}">${wl.enabled?"ON":"OFF"}</strong></span>
            <button class="btn-add" type="submit" style="font-size:12px;padding:4px 12px">${wl.enabled?"Disable":"Enable"}</button>
        </form>
        <div style="color:#888;font-size:12px;margin-bottom:12px">When enabled, only UIDs below (plus authorized UIDs) can use bot commands.</div>
        <form method="POST" action="/api/whitelist/add?tab=threads" class="add-row">
            <input class="add-input" type="text" name="uid" placeholder="Facebook UID to whitelist" autocomplete="off" required/>
            <button class="btn-add" type="submit">+ Add</button>
        </form>
        <div class="q-list">${
            wl.uids.length===0
                ? `<div class="q-empty">No UIDs whitelisted yet</div>`
                : wl.uids.map((uid,i)=>`
                    <div class="qi">
                        <span class="qi-num">${String(i+1).padStart(2,"0")}</span>
                        <span class="qi-text">${esc(uid)}</span>
                        <form method="POST" action="/api/whitelist/remove?tab=threads" style="margin:0">
                            <input type="hidden" name="uid" value="${esc(uid)}"/>
                            <button class="btn-rm" type="submit">✕</button>
                        </form>
                    </div>`).join("")
        }</div>
    </div>
</div>`;

    // ── PAGE: CUSTOM COMMANDS ─────────────────────────────────────────
    const customCmds = readCustomCommands();
    const cmdRows2 = customCmds.length===0
        ? `<div class="q-empty">No custom commands yet — add one above</div>`
        : customCmds.map((c,i)=>`
            <div class="qi">
                <span class="qi-num">${String(i+1).padStart(2,"0")}</span>
                <code style="background:#111;padding:2px 8px;border-radius:4px;font-size:12px;color:#8ae4ff">!${esc(c.cmd)}</code>
                <span class="qi-text" style="flex:1;margin-left:8px">→ ${esc(c.reply)}</span>
                <form method="POST" action="/api/cmds/remove?tab=cmds" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    const pageCmds = `
<div class="section-hd">Custom Command Builder</div>
<div class="box">
    <div class="box-hd"><span class="chip chip-p">BUILDER</span><span class="box-title">Custom Commands</span><span class="box-meta">${customCmds.length} commands</span></div>
    <form method="POST" action="/api/cmds/add?tab=cmds" class="add-row" style="gap:8px">
        <span style="color:#888;font-size:14px;font-family:monospace;white-space:nowrap">!</span>
        <input class="add-input" type="text" name="cmd" placeholder="command (no !)" autocomplete="off" required style="max-width:180px"/>
        <input class="add-input" type="text" name="reply" placeholder="Bot reply text — use {name} for sender UID" autocomplete="off" required/>
        <button class="btn-add" type="submit">+ Add</button>
    </form>
    <div style="color:#666;font-size:11px;padding:0 14px 10px">Available placeholders: <code>{name}</code> = sender UID</div>
    <div class="q-list">${cmdRows2}</div>
</div>`;

    // ── ASSEMBLE ──────────────────────────────────────────────────────
    const pages = {dashboard:pageDashboard, loop:pageLoop, threads:pageThreads, cmds:pageCmds, config:pageConfig, session:pageSession, commands:pageCommands};
    const content = pages[t] || pageDashboard;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cozy Bot${t!=="dashboard"?" · "+TABS.find(x=>x.id===t)?.label:""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060c17;
  --s1:#0a1220;--s2:#0e1a2e;--s3:#132038;--s4:#182844;
  --b1:#172035;--b2:#1e2d45;--b3:#253652;--b4:#2e4268;
  --t1:#e8edf5;--t2:#8fa3be;--t3:#4e6585;--t4:#2d4060;
  --bl:#3b82f6;--bl2:#60a5fa;--bl3:#93c5fd;--bl4:#bfdbfe;
  --cy:#06b6d4;--cy2:#22d3ee;--cy3:#67e8f9;
  --gn:#059669;--gn2:#10b981;--gn3:#34d399;--gn4:#6ee7b7;
  --rd:#e11d48;--rd2:#f43f5e;--rd3:#fb7185;
  --yw:#d97706;--yw2:#f59e0b;--yw3:#fbbf24;
  --pu:#7c3aed;--pu2:#a855f7;--pu3:#c084fc;
  --mono:'JetBrains Mono',monospace;
  --sans:'Inter',sans-serif;
  --r:8px;--r2:10px;--r3:14px;--r4:18px;
  --shadow:0 1px 3px #0005,0 4px 16px #00000030;
  --shadow-lg:0 4px 24px #00000050,0 1px 2px #0005;
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--t1);font-family:var(--sans);font-size:13.5px;line-height:1.6;display:flex;flex-direction:column}

/* ── TOPBAR ── */
.topbar{height:54px;flex-shrink:0;background:var(--s1);border-bottom:1px solid var(--b2);display:flex;align-items:center;padding:0 20px;gap:16px;position:relative}
.topbar::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--bl)30,var(--cy)20,transparent)}
.logo{display:flex;align-items:center;gap:10px}
.logo-mark{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 16px #3b82f630,0 2px 8px #0004}
.logo-mark svg{color:#fff}
.logo-text{font-weight:800;font-size:14.5px;color:var(--t1);letter-spacing:-.02em;background:linear-gradient(135deg,var(--bl3),var(--cy2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo-badge{font-size:9px;font-weight:700;color:var(--t3);background:var(--s3);border:1px solid var(--b3);border-radius:5px;padding:2px 8px;letter-spacing:.12em;text-transform:uppercase;font-family:var(--mono)}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:11px;font-family:var(--mono);color:var(--t3)}
.tb-right b{color:var(--bl3)}
.tb-cookie-btn{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:7px;background:var(--s3);border:1px solid var(--b3);color:var(--t3);font-size:11px;font-weight:600;font-family:var(--sans);text-decoration:none;transition:all .15s;white-space:nowrap;cursor:pointer}
.tb-cookie-btn:hover{background:var(--s4);border-color:var(--bl);color:var(--bl2)}
.tb-cookie-btn svg{flex-shrink:0}
.live-dot{display:flex;align-items:center;gap:5px}
.ld{width:6px;height:6px;border-radius:50%;background:var(--gn3);box-shadow:0 0 8px var(--gn3);animation:pulse 2.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── NAV ── */
.nav{height:44px;flex-shrink:0;background:var(--s1);border-bottom:1px solid var(--b1);display:flex;align-items:stretch;padding:0 14px;gap:1px;overflow-x:auto}
.nav::-webkit-scrollbar{display:none}
.nav-item{display:flex;align-items:center;gap:7px;padding:0 15px;font-size:12.5px;font-weight:500;color:var(--t3);text-decoration:none;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap;position:relative}
.nav-item:hover{color:var(--t2)}
.nav-item.active{color:var(--bl2);border-bottom-color:var(--bl)}
.nav-item.active svg{color:var(--bl2)}
.nav-item svg{flex-shrink:0;transition:color .15s}

/* ── SCROLL AREA ── */
.page{flex:1;overflow-y:auto;padding:22px 22px 60px;animation:fadeUp .3s ease}
.page::-webkit-scrollbar{width:4px}
.page::-webkit-scrollbar-track{background:transparent}
.page::-webkit-scrollbar-thumb{background:var(--b3);border-radius:99px}

/* ── HERO ── */
.hero{background:var(--s1);border:1px solid var(--b2);border-radius:var(--r3);padding:0;margin-bottom:20px;position:relative;overflow:hidden}
.hero-glow{position:absolute;top:-60px;left:-60px;width:300px;height:200px;background:radial-gradient(circle,#2563eb18 0%,transparent 70%);pointer-events:none}
.hero-content{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:22px 24px;position:relative}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#1d4ed8,#7c3aed,#06b6d4)}
.hero-left{display:flex;align-items:center;gap:16px}
.hero-avatar{width:54px;height:54px;border-radius:12px;background:linear-gradient(135deg,#1d4ed8,#6d28d9);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 24px #3b82f625,var(--shadow)}
.hero-avatar svg{color:#fff}
.hero-title{font-size:21px;font-weight:800;letter-spacing:-.04em;margin-bottom:2px;color:var(--t1)}
.hero-ver{font-size:10px;font-weight:700;color:var(--t3);background:var(--s3);border:1px solid var(--b3);border-radius:5px;padding:2px 8px;vertical-align:middle;margin-left:8px;font-family:var(--mono);letter-spacing:.1em}
.hero-desc{font-size:12px;color:var(--t3);margin-bottom:10px;letter-spacing:.01em}
.pill-row{display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-family:var(--mono);padding:3px 10px;border-radius:6px;border:1px solid var(--b2);background:var(--s2);color:var(--t3)}
.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.pill-on{color:var(--gn3);border-color:#05966920;background:#05966910}
.pill-on i{animation:pulse 2.5s infinite}
.pill-warn{color:var(--yw3);border-color:#d9780620}
.pill-off{color:var(--t3)}
.pill-off i{opacity:.3}

/* ── STATUS PILL ── */
.status-pill{display:flex;align-items:center;gap:7px;padding:7px 15px;border-radius:99px;font-size:11.5px;font-weight:600;font-family:var(--mono);border:1px solid transparent;flex-shrink:0;align-self:flex-start;letter-spacing:.02em}
.st-on{color:var(--gn3);background:#05966912;border-color:#05966928}
.st-warn{color:var(--yw3);background:#d9780612;border-color:#d9780628}
.st-off{color:var(--rd3);background:#e11d4812;border-color:#e11d4828}
.sp-dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 2.5s infinite}

/* ── STAT GRID ── */
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
@media(max-width:720px){.stat-grid{grid-template-columns:1fr 1fr}}
.stat-card{background:var(--s1);border:1px solid var(--b2);border-radius:var(--r3);padding:20px 20px 16px;position:relative;overflow:hidden;transition:border-color .2s,transform .15s,box-shadow .2s;cursor:default}
.stat-card:hover{border-color:var(--b3);transform:translateY(-2px);box-shadow:var(--shadow-lg)}
.stat-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.sc-blue::after{background:linear-gradient(90deg,#1d4ed8,#3b82f6)}
.sc-cyan::after{background:linear-gradient(90deg,#0e7490,#06b6d4)}
.sc-purple::after{background:linear-gradient(90deg,#5b21b6,#a855f7)}
.sc-emerald::after{background:linear-gradient(90deg,#047857,#10b981)}
.sc-glow{position:absolute;top:-20px;right:-20px;width:100px;height:100px;border-radius:50%;filter:blur(30px);opacity:.25;pointer-events:none}
.sc-glow-blue{background:#3b82f6}
.sc-glow-cyan{background:#06b6d4}
.sc-glow-purple{background:#a855f7}
.sc-glow-emerald{background:#10b981}
.sc-icon-wrap{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;position:relative}
.sc-iw-blue{background:#1d4ed815;border:1px solid #3b82f620;color:var(--bl2)}
.sc-iw-cyan{background:#0e749015;border:1px solid #06b6d420;color:var(--cy2)}
.sc-iw-purple{background:#5b21b615;border:1px solid #a855f720;color:var(--pu3)}
.sc-iw-emerald{background:#04785715;border:1px solid #10b98120;color:var(--gn3)}
.sc-val{font-size:34px;font-weight:900;font-family:var(--mono);line-height:1;margin-bottom:5px;color:var(--t1);letter-spacing:-.03em}
.sc-val-sm{font-size:24px}
.sc-label{font-size:11px;color:var(--t3);font-weight:500;letter-spacing:.01em}
.sc-sub{font-size:10px;color:var(--t4);display:block;margin-top:2px}

/* ── SECTION HEADING ── */
.section-hd{font-size:9px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.18em;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.section-hd svg{color:var(--t4);flex-shrink:0}
.section-hd::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--b2),transparent)}

/* ── BOX / PANEL ── */
.box{background:var(--s1);border:1px solid var(--b2);border-radius:var(--r2);overflow:hidden;margin-bottom:16px;box-shadow:var(--shadow)}
.box-hd{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--s2);border-bottom:1px solid var(--b1)}
.box-title{font-size:12px;font-weight:600;color:var(--t2);flex:1}
.box-meta{font-size:11px;color:var(--t3);font-family:var(--mono)}

/* ── CHIP / BADGE ── */
.chip{font-size:8px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;padding:2px 8px;border-radius:5px;background:var(--s3);border:1px solid var(--b3);color:var(--t3)}
.chip-g{background:#05966912;border-color:#05966928;color:var(--gn3)}
.chip-p{background:#5b21b612;border-color:#a855f728;color:var(--pu3)}
.chip-r{background:#e11d4812;border-color:#e11d4828;color:var(--rd3)}
.chip-b{background:#1d4ed812;border-color:#3b82f628;color:var(--bl3)}

/* ── TAGS ── */
.tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;font-family:var(--mono);padding:2px 8px;border-radius:5px}
.tag-g{background:#05966914;color:var(--gn3);border:1px solid #05966928}
.tag-b{background:#1d4ed814;color:var(--bl3);border:1px solid #3b82f628}
.tag-y{background:#d9780614;color:var(--yw3);border:1px solid #d9780628}
.tag-dim{background:var(--s3);color:var(--t4);border:1px solid var(--b2)}

/* ── TABLE ── */
table{width:100%;border-collapse:collapse}
th{padding:8px 14px;text-align:left;font-size:9px;font-weight:700;color:var(--t4);text-transform:uppercase;letter-spacing:.14em;border-bottom:1px solid var(--b1);background:var(--s2)}
td{padding:9px 14px;border-bottom:1px solid var(--b1);color:var(--t2);font-size:12.5px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff03}
.td-mono{font-family:var(--mono);font-size:11px;color:var(--t3)}
.td-empty{text-align:center;color:var(--t3);padding:32px;font-size:12.5px}
.tc{width:1%;white-space:nowrap;padding-right:4px}
.tc code{font-size:11.5px;color:var(--bl2)}
.td-d{color:var(--t3);font-size:12px}

/* ── LOGS ── */
.log-area{background:var(--bg);max-height:360px;overflow-y:auto;font-family:var(--mono);font-size:10.5px}
.log-area::-webkit-scrollbar{width:3px}
.log-area::-webkit-scrollbar-thumb{background:var(--b3);border-radius:99px}
.lr{display:flex;gap:10px;padding:4px 14px;border-bottom:1px solid #ffffff04;line-height:1.5}
.lr:hover{background:#ffffff02}
.lt{color:var(--t4);font-size:9.5px;flex-shrink:0;min-width:66px;padding-top:1px}
.ll{font-size:8.5px;font-weight:700;flex-shrink:0;min-width:32px;padding-top:2px;text-transform:uppercase;color:var(--t4)}
.lm{color:var(--t3);word-break:break-word;flex:1;font-size:10.5px}
.lr-error .ll{color:var(--rd3)} .lr-error .lm{color:#fda4af}
.lr-warn  .ll{color:var(--yw3)} .lr-warn  .lm{color:#fde68a}
.lr-reply .ll{color:var(--gn3)} .lr-reply .lm{color:#6ee7b7}
.lr-info  .ll{color:var(--bl3)} .lr-info  .lm{color:var(--t3)}
.lr-idle  .ll,.lr-idle .lm{color:var(--t4)}

/* ── QUEUE ── */
.add-row{display:flex;gap:8px;padding:11px 13px;border-bottom:1px solid var(--b1)}
.add-input{flex:1;background:var(--bg);border:1px solid var(--b2);border-radius:var(--r);padding:7px 11px;color:var(--t1);font-size:12.5px;font-family:var(--mono);outline:none;transition:border-color .15s,box-shadow .15s}
.add-input:focus{border-color:var(--bl);box-shadow:0 0 0 3px #3b82f615}
.add-input::placeholder{color:var(--t4)}
.btn-add{background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;border:none;border-radius:var(--r);padding:7px 18px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;box-shadow:0 2px 8px #1d4ed840}
.btn-add:hover{background:linear-gradient(135deg,#2563eb,#3b82f6);box-shadow:0 4px 14px #3b82f640}
.q-list{max-height:340px;overflow-y:auto}
.q-list::-webkit-scrollbar{width:3px}
.q-list::-webkit-scrollbar-thumb{background:var(--b3);border-radius:99px}
.q-empty{color:var(--t4);text-align:center;padding:28px;font-size:12px}
.qi{display:flex;align-items:center;gap:10px;padding:8px 13px;border-bottom:1px solid var(--b1);transition:background .1s}
.qi:last-child{border-bottom:none}
.qi:hover{background:#ffffff02}
.qi-num{font-size:10px;color:var(--t4);min-width:22px;font-family:var(--mono)}
.qi-text{color:var(--t2);font-size:12px;word-break:break-all;flex:1;font-family:var(--mono)}
.qi-url{color:var(--cy2);font-size:10.5px}
.btn-rm{background:transparent;color:var(--t4);border:1px solid var(--b2);border-radius:5px;padding:3px 9px;font-size:11px;cursor:pointer;transition:all .15s}
.btn-rm:hover{background:#e11d4815;border-color:#e11d4840;color:var(--rd3)}

/* ── RATE GRAPH ── */
.rate-graph{display:flex;align-items:flex-end;gap:2px;height:80px;padding:4px 0}
.rg-col{display:flex;flex-direction:column;align-items:center;flex:1;height:100%}
.rg-bar-wrap{flex:1;display:flex;align-items:flex-end;width:100%}
.rg-bar{width:100%;background:linear-gradient(to top,#1d4ed8,#3b82f6);border-radius:2px 2px 0 0;min-height:2px;transition:height .3s}
.rg-label{font-size:8px;color:var(--t4);margin-top:3px;white-space:nowrap;font-family:var(--mono)}

/* ── TWO COL ── */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:780px){.two-col{grid-template-columns:1fr}}

/* ── CONFIG TABS ── */
.cfg-scroll-wrap{overflow-x:auto;margin-bottom:16px}
.cfg-scroll-wrap::-webkit-scrollbar{display:none}
.cfg-tabs{display:flex;gap:6px;min-width:max-content}
.cfg-tab{background:var(--s2);border:1px solid var(--b2);border-radius:99px;padding:6px 18px;font-size:12px;font-weight:500;color:var(--t3);cursor:pointer;transition:all .15s;font-family:var(--sans)}
.cfg-tab:hover{color:var(--t2);border-color:var(--b3)}
.cfg-tab.active{background:#1d4ed815;border-color:#3b82f635;color:var(--bl2)}

/* ── FORM ── */
.cfg-body{padding:14px 15px}
.fld{margin-bottom:13px}
.flbl{display:block;font-size:9px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.13em;margin-bottom:5px}
.finput,.fselect{width:100%;background:var(--bg);border:1px solid var(--b2);border-radius:var(--r);padding:7px 11px;color:var(--t1);font-size:12.5px;font-family:var(--mono);outline:none;transition:border-color .15s,box-shadow .15s}
.fselect{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%234e6585' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;cursor:pointer}
.finput:focus,.fselect:focus{border-color:var(--bl);box-shadow:0 0 0 3px #3b82f615}
.fhint{font-size:10px;color:var(--t4);margin-top:3px;line-height:1.5}
.fhint-top{font-size:11.5px;color:var(--t3);margin-bottom:13px;line-height:1.6}
.fhint-top.warn{color:var(--yw3)}

/* ── TOGGLE ── */
.toggle-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;cursor:pointer;font-size:12.5px;color:var(--t2);user-select:none}
.tcheck{display:none}
.ttrack{width:38px;height:21px;border-radius:99px;background:var(--b3);position:relative;flex-shrink:0;transition:background .2s;cursor:pointer;border:1px solid var(--b3)}
.tcheck:checked~.ttrack{background:var(--bl);border-color:var(--bl)}
.tthumb{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 4px #0004}
.tcheck:checked~.ttrack .tthumb{transform:translateX(17px)}

/* ── INFO BLOCK ── */
.info-block{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r);padding:12px 14px}
.ib-title{font-size:9.5px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.13em;margin-bottom:8px}
.ib-row{display:flex;align-items:baseline;gap:10px;padding:4px 0;font-size:12px;color:var(--t3);border-bottom:1px solid var(--b1);line-height:1.6}
.ib-row:last-child{border-bottom:none}
.ib-row code{flex-shrink:0;color:var(--bl2)}
.ib-row span{color:var(--t3)}

/* ── SAVE ── */
.save-row{display:flex;justify-content:center;margin-top:8px;padding-bottom:20px}
.btn-save{background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;border:none;border-radius:var(--r);padding:11px 36px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--sans);box-shadow:0 2px 12px #1d4ed840}
.btn-save:hover{background:linear-gradient(135deg,#2563eb,#3b82f6);box-shadow:0 4px 20px #3b82f650;transform:translateY(-1px)}

/* ── SESSION / COOKIE INTRO ── */
.cookie-intro{max-width:680px;margin:0 auto;padding-bottom:40px}
.ci-bg{position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:0}
.ci-blob{position:absolute;top:-100px;left:-100px;width:600px;height:600px;opacity:.6}
.ci-card{position:relative;z-index:1;background:var(--s1);border:1px solid var(--b2);border-radius:var(--r4);padding:36px;margin-bottom:20px;box-shadow:var(--shadow-lg);overflow:hidden}
.ci-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#1d4ed8,#7c3aed,#06b6d4)}
.ci-logo{width:60px;height:60px;border-radius:16px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 0 30px #3b82f630,0 4px 16px #0004}
.ci-title{font-size:26px;font-weight:900;letter-spacing:-.04em;color:var(--t1);margin-bottom:8px}
.ci-sub{font-size:13.5px;color:var(--t3);margin-bottom:28px;line-height:1.6}
.ci-steps{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:28px}
@media(max-width:500px){.ci-steps{grid-template-columns:1fr}}
.ci-step{display:flex;align-items:flex-start;gap:10px;background:var(--s2);border:1px solid var(--b1);border-radius:10px;padding:12px 14px}
.cs-num{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:var(--mono)}
.cs-text{font-size:12px;color:var(--t2);line-height:1.6}
.cs-text b{color:var(--t1)}
.ci-form{display:flex;flex-direction:column;gap:12px}
.ci-ta-wrap{position:relative}
.ci-ta{width:100%;background:var(--bg);border:1px solid var(--b2);border-radius:var(--r2);padding:14px;color:var(--t1);font-family:var(--mono);font-size:11px;outline:none;resize:vertical;min-height:160px;transition:border-color .2s,box-shadow .2s;line-height:1.7}
.ci-ta:focus{border-color:var(--bl);box-shadow:0 0 0 3px #3b82f618}
.ci-ta::placeholder{color:var(--t4)}
.ci-ta-icon{position:absolute;top:12px;right:12px;color:var(--t4);pointer-events:none}
.ci-actions{display:flex;gap:10px}
.ci-btn-primary{flex:1;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:#fff;border:none;border-radius:var(--r2);padding:13px 24px;font-size:13.5px;font-weight:700;cursor:pointer;transition:all .2s;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 20px #3b82f640}
.ci-btn-primary:hover{opacity:.9;box-shadow:0 6px 28px #3b82f660;transform:translateY(-1px)}
.ci-btn-ghost{background:var(--s2);color:var(--t3);border:1px solid var(--b2);border-radius:var(--r2);padding:13px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--sans)}
.ci-btn-ghost:hover{border-color:var(--b3);color:var(--t2)}
.ci-hint{font-size:11px;color:var(--t4);text-align:center;font-family:var(--mono)}
.ci-bots{position:relative;z-index:1}
.cookie-pv{padding:9px 12px;border-radius:8px;font-size:11px;font-family:var(--mono);align-items:center;gap:8px;line-height:1.5}
.pv-ok{background:#05966912;border:1px solid #05966928;color:var(--gn3)}
.pv-err{background:#e11d4812;border:1px solid #e11d4828;color:var(--rd3)}
.bot-row{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--b1)}
.bot-row:last-child{border-bottom:none}
.br-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:currentColor}
.br-online{color:var(--gn3)}
.br-warn{color:var(--yw3)}
.br-off{color:var(--rd3)}
.br-name{font-weight:600;font-size:13px;color:var(--t1);flex:1}
.br-status{font-size:11.5px;font-family:var(--mono);color:currentColor}
.notice{color:var(--t3);font-size:12.5px;padding:20px;text-align:center}

/* ── INLINE CODE ── */
code{background:var(--s3);border:1px solid var(--b2);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:11.5px;color:var(--cy2)}

/* ── MISC ── */
.notice-box{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:16px 18px}
.nb-hd{font-size:10.5px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}
.nb-ol{padding-left:18px;font-size:12.5px;color:var(--t3);line-height:2}
.nb-ol b{color:var(--t2)}
.hero-info{}

${t==="dashboard"?`<meta http-equiv="refresh" content="10"/>`:``}
</style>
</head>
<body>
<!-- TOPBAR -->
<div class="topbar">
    <div class="logo">
        <div class="logo-mark">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8.5" cy="15.5" r=".5" fill="white"/><circle cx="15.5" cy="15.5" r=".5" fill="white"/></svg>
        </div>
        <span class="logo-text">Cozy Bot</span>
        <span class="logo-badge">v2.2</span>
    </div>
    <div class="tb-right">
        <span class="tb-dev">dev <b>${esc(state.developerID||"—")}</b></span>
        <a href="/" class="tb-cookie-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            Change Cookie
        </a>
        <div class="live-dot"><div class="ld"></div>${t==="dashboard"?"auto-refresh 10s":"static"}</div>
    </div>
</div>

<!-- NAV -->
<nav class="nav">${navLinks}</nav>

<!-- PAGE -->
<div class="page">${content}</div>
</body>
</html>`;
}

function buildIntro() {
    const hasFbstate = (() => { try { const d = JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8")); return Array.isArray(d)&&d.length>0; } catch(_){ return false; } })();
    const existingCUser = (() => { try { const d = JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8")); const c=d.find(x=>x.key==="c_user"); return c?c.value:""; } catch(_){ return ""; } })();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cozy Bot — Connect</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060c17;--s1:#0a1220;--s2:#0e1a2e;--s3:#132038;
  --b1:#172035;--b2:#1e2d45;--b3:#253652;
  --t1:#e8edf5;--t2:#8fa3be;--t3:#4e6585;--t4:#2d4060;
  --bl:#3b82f6;--bl2:#60a5fa;--cy:#06b6d4;--cy2:#22d3ee;
  --gn:#059669;--gn2:#10b981;--gn3:#34d399;
  --rd:#e11d48;--rd2:#f43f5e;--rd3:#fb7185;
  --yw:#d97706;--yw2:#f59e0b;--yw3:#fbbf24;
  --pu:#7c3aed;
  --mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif;
  --r:10px;--r2:14px;--r3:20px;
  --shadow-xl:0 8px 40px #00000060,0 2px 8px #0005;
}
html,body{height:100%;overflow:hidden;background:var(--bg)}
body{font-family:var(--sans);color:var(--t1);display:flex;align-items:center;justify-content:center;position:relative}

/* ── ANIMATED BG ── */
.bg-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.bg-orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.12;animation:drift 14s ease-in-out infinite alternate}
.bg-orb-1{width:500px;height:400px;top:-100px;left:-150px;background:#2563eb;animation-delay:0s}
.bg-orb-2{width:400px;height:350px;bottom:-80px;right:-100px;background:#7c3aed;animation-delay:-5s}
.bg-orb-3{width:300px;height:250px;top:40%;left:40%;background:#06b6d4;animation-delay:-9s;opacity:.07}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(30px,20px) scale(1.06)}}

/* ── GRID BG ── */
.bg-grid{position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(var(--b1) 1px,transparent 1px),linear-gradient(90deg,var(--b1) 1px,transparent 1px);background-size:40px 40px;opacity:.25}

/* ── CARD ── */
.card{position:relative;z-index:10;width:100%;max-width:560px;background:var(--s1);border:1px solid var(--b2);border-radius:var(--r3);padding:44px;box-shadow:var(--shadow-xl);overflow:hidden;margin:20px}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#1d4ed8,#7c3aed 50%,#06b6d4)}

/* ── LOGO ── */
.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:32px}
.logo-icon{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);display:flex;align-items:center;justify-content:center;box-shadow:0 0 28px #3b82f628,0 4px 16px #0005;flex-shrink:0}
.logo-name{font-size:22px;font-weight:900;letter-spacing:-.04em;background:linear-gradient(135deg,#93c5fd,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo-ver{font-size:9px;font-weight:700;color:var(--t3);font-family:var(--mono);background:var(--s3);border:1px solid var(--b3);border-radius:4px;padding:2px 7px;letter-spacing:.12em;display:block;margin-top:3px}

/* ── HEADING ── */
.heading{font-size:28px;font-weight:900;letter-spacing:-.05em;margin-bottom:6px;color:var(--t1)}
.sub{font-size:13.5px;color:var(--t3);margin-bottom:28px;line-height:1.6}

/* ── EXISTING COOKIE NOTICE ── */
.existing-notice{background:var(--s2);border:1px solid #05966920;border-radius:var(--r);padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--gn3)}
.existing-notice svg{flex-shrink:0;color:var(--gn3)}
.en-text b{color:var(--t1)}

/* ── STEPS ── */
.steps{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:24px}
@media(max-width:480px){.steps{grid-template-columns:1fr}}
.step{display:flex;align-items:flex-start;gap:10px;background:var(--s2);border:1px solid var(--b1);border-radius:var(--r);padding:11px 13px}
.step-n{width:20px;height:20px;border-radius:5px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:var(--mono)}
.step-t{font-size:11.5px;color:var(--t2);line-height:1.6}
.step-t b{color:var(--t1)}

/* ── TEXTAREA ── */
.ta-wrap{position:relative;margin-bottom:12px}
.ta{width:100%;background:var(--bg);border:1.5px solid var(--b2);border-radius:var(--r2);padding:14px 40px 14px 14px;color:var(--t1);font-family:var(--mono);font-size:11px;outline:none;resize:none;height:150px;transition:border-color .2s,box-shadow .2s;line-height:1.7}
.ta:focus{border-color:var(--bl);box-shadow:0 0 0 3px #3b82f618}
.ta::placeholder{color:var(--t4)}
.ta.state-valid{border-color:var(--gn2)!important;box-shadow:0 0 0 3px #05966915!important}
.ta.state-expired{border-color:var(--yw2)!important;box-shadow:0 0 0 3px #d9780615!important}
.ta.state-invalid{border-color:var(--rd2)!important;box-shadow:0 0 0 3px #e11d4815!important}
.ta-paste-btn{position:absolute;top:10px;right:10px;background:var(--s3);border:1px solid var(--b3);border-radius:6px;padding:5px 8px;cursor:pointer;color:var(--t3);transition:all .15s;display:flex;align-items:center;gap:5px;font-size:10.5px;font-family:var(--sans);font-weight:500}
.ta-paste-btn:hover{color:var(--t2);border-color:var(--b4)}

/* ── STATUS BADGE ── */
.status-badge{display:none;align-items:center;gap:8px;padding:10px 14px;border-radius:var(--r);font-size:12px;font-family:var(--mono);margin-bottom:14px;line-height:1.5}
.sb-valid{background:#05966910;border:1px solid #05966925;color:var(--gn3)}
.sb-expired{background:#d9780610;border:1px solid #d9780625;color:var(--yw3)}
.sb-invalid{background:#e11d4810;border:1px solid #e11d4825;color:var(--rd3)}

/* ── BUTTONS ── */
.btn-row{display:flex;gap:10px}
.btn-connect{flex:1;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:#fff;border:none;border-radius:var(--r2);padding:14px 24px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:9px;box-shadow:0 4px 20px #3b82f640;letter-spacing:-.01em;position:relative;overflow:hidden}
.btn-connect::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,transparent 30%,#ffffff12 70%,transparent);opacity:0;transition:opacity .2s}
.btn-connect:hover::after{opacity:1}
.btn-connect:hover{box-shadow:0 6px 30px #3b82f660;transform:translateY(-1px)}
.btn-connect:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
.btn-connect:disabled::after{display:none}
.btn-skip{background:var(--s2);color:var(--t3);border:1px solid var(--b2);border-radius:var(--r2);padding:14px 18px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--sans);white-space:nowrap}
.btn-skip:hover{border-color:var(--b3);color:var(--t2)}

/* ── FOOTER ── */
.card-foot{margin-top:18px;text-align:center;font-size:11px;color:var(--t4);font-family:var(--mono)}
.card-foot a{color:var(--bl2);text-decoration:none}

/* ── SPINNER ── */
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{width:16px;height:16px;border:2px solid #ffffff40;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
</style>
</head>
<body>
<div class="bg-layer">
    <div class="bg-orb bg-orb-1"></div>
    <div class="bg-orb bg-orb-2"></div>
    <div class="bg-orb bg-orb-3"></div>
</div>
<div class="bg-grid"></div>

<div class="card">
    <div class="logo-wrap">
        <div class="logo-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8.5" cy="15.5" r=".7" fill="white"/><circle cx="15.5" cy="15.5" r=".7" fill="white"/></svg>
        </div>
        <div>
            <div class="logo-name">Cozy Bot</div>
            <span class="logo-ver">v2.2</span>
        </div>
    </div>

    <h1 class="heading">Enter Your Cookie</h1>
    <p class="sub">Paste your Facebook <code style="background:#132038;border:1px solid #253652;border-radius:4px;padding:1px 7px;font-family:var(--mono);font-size:11.5px;color:#22d3ee">fbstate</code> JSON — the system will verify it before connecting.</p>

    ${hasFbstate&&existingCUser?`
    <div class="existing-notice">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        <div class="en-text">Cookie already saved — <b>c_user: ${esc(existingCUser)}</b> &nbsp;·&nbsp; You can skip or replace it below.</div>
    </div>`:""}

    <div class="steps">
        <div class="step"><div class="step-n">1</div><div class="step-t">Install <b>Cookie Editor</b> on Chrome or Firefox</div></div>
        <div class="step"><div class="step-n">2</div><div class="step-t">Log in to Facebook as the <b>bot account</b></div></div>
        <div class="step"><div class="step-n">3</div><div class="step-t">Click Cookie Editor → <b>Export All</b> → copy JSON</div></div>
        <div class="step"><div class="step-n">4</div><div class="step-t">Paste below — system verifies automatically</div></div>
    </div>

    <div class="ta-wrap">
        <textarea class="ta" id="cookieTa" placeholder='[&#10;  {"key":"c_user","value":"100000..."},&#10;  {"key":"xs","value":"..."},&#10;  ...&#10;]' spellcheck="false"></textarea>
        <button class="ta-paste-btn" type="button" onclick="pasteClip()" title="Paste from clipboard">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Paste
        </button>
    </div>

    <div class="status-badge" id="statusBadge"></div>

    <div class="btn-row">
        <button class="btn-connect" id="connectBtn" disabled onclick="connectBot()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.1 6.1l.97-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            Connect Bot
        </button>
        ${hasFbstate?`<button class="btn-skip" onclick="location.href='/?tab=dashboard'">Skip →</button>`:""}
    </div>

    <div class="card-foot">Cookie never leaves your server &nbsp;·&nbsp; <a href="/?tab=dashboard">Go to dashboard →</a></div>
</div>

<script>
const ta  = document.getElementById('cookieTa');
const btn = document.getElementById('connectBtn');
const badge = document.getElementById('statusBadge');
let validCookieStr = null;
let checkTimer = null;

function showBadge(cls, iconSvg, msg){
    badge.className = 'status-badge ' + cls;
    badge.style.display = 'flex';
    badge.innerHTML = iconSvg + '<span style="flex:1">' + msg + '</span>';
}
function hideBadge(){ badge.style.display='none'; }
const iconOk   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>';
const iconWarn = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const iconErr  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

function checkCookie(val) {
    val = val.trim();
    ta.className = 'ta';
    hideBadge();
    btn.disabled = true;
    validCookieStr = null;
    if (!val) return;

    let arr;
    try { arr = JSON.parse(val); } catch(e) {
        ta.classList.add('state-invalid');
        showBadge('status-badge sb-invalid', iconErr, 'Invalid JSON — ' + e.message);
        return;
    }
    if (!Array.isArray(arr)) {
        ta.classList.add('state-invalid');
        showBadge('status-badge sb-invalid', iconErr, 'Must be a JSON array [ {...}, ... ]');
        return;
    }
    const cUser = arr.find(c => c.key === 'c_user');
    const xs    = arr.find(c => c.key === 'xs');
    if (!cUser) {
        ta.classList.add('state-invalid');
        showBadge('status-badge sb-invalid', iconErr, 'Missing <b>c_user</b> cookie — not a valid fbstate');
        return;
    }
    if (!xs) {
        ta.classList.add('state-invalid');
        showBadge('status-badge sb-invalid', iconErr, 'Missing <b>xs</b> cookie — session token not found');
        return;
    }

    // Check expiry dates
    const now = Date.now() / 1000;
    const expiredKeys = arr.filter(c => c.expirationDate && c.expirationDate > 0 && c.expirationDate < now).map(c => c.key);
    const criticalExpired = expiredKeys.filter(k => ['c_user','xs','datr','fr'].includes(k));

    if (criticalExpired.length > 0) {
        ta.classList.add('state-expired');
        showBadge('status-badge sb-expired', iconWarn,
            'Cookie is <b>Expired</b> — ' + criticalExpired.join(', ') + ' expired. Re-export from browser.');
        return;
    }

    // Check if ALL cookies have no expiry (might still be expired but can't tell client-side)
    const hasAnyExpiry = arr.some(c => c.expirationDate && c.expirationDate > 0);

    ta.classList.add('state-valid');
    validCookieStr = val;
    btn.disabled = false;
    const uid = cUser.value;
    const msg = '<b>Valid</b> &nbsp;·&nbsp; ' + arr.length + ' cookies &nbsp;·&nbsp; c_user: <b>' + uid + '</b>'
              + (xs ? ' &nbsp;·&nbsp; xs ✓' : '')
              + (!hasAnyExpiry ? ' &nbsp;·&nbsp; <span style="color:#fbbf24">no expiry data</span>' : '');
    showBadge('status-badge sb-valid', iconOk, msg);
}

ta.addEventListener('input', function(){
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => checkCookie(this.value), 320);
});

async function pasteClip() {
    try {
        const text = await navigator.clipboard.readText();
        ta.value = text;
        checkCookie(text);
    } catch(_) {
        ta.focus();
        document.execCommand('paste');
    }
}

async function connectBot() {
    if (!validCookieStr) return;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Connecting…';
    try {
        const body = 'fbstate=' + encodeURIComponent(validCookieStr);
        const res  = await fetch('/api/fbstate/connect', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
        const data = await res.json();
        if (data.ok) {
            btn.innerHTML = iconOk + ' Connected!';
            btn.style.background = 'linear-gradient(135deg,#059669,#10b981)';
            setTimeout(() => location.href = '/?page=login-process', 600);
        } else {
            btn.disabled = false;
            btn.innerHTML = 'Connect Bot';
            showBadge('status-badge sb-invalid', iconErr, data.error || 'Save failed');
        }
    } catch(e) {
        btn.disabled = false;
        btn.innerHTML = 'Connect Bot';
        showBadge('status-badge sb-invalid', iconErr, 'Network error: ' + e.message);
    }
}
</script>
</body>
</html>`;
}

function startDashboard(port=5000) {
    const server = http.createServer(async(req,res)=>{
        const url   = new URL(req.url, "http://localhost");
        const path2 = url.pathname;
        const tabParam = url.searchParams.get("tab");
        const tab   = tabParam || "dashboard";

        function redirect(t){ res.writeHead(302,{Location:t?`/?tab=${t}`:"/"});res.end(); }
        function htmlErr(msg){ res.writeHead(200,{"Content-Type":"text/html"});res.end(`<!DOCTYPE html><html><body style="background:#060c17;color:#fb7185;font-family:monospace;padding:40px"><h3>❌ ${msg}</h3><br><a href="/" style="color:#60a5fa">← Go back</a></body></html>`); }
        function json(data,code=200){ res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(data)); }

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
            // ── /api/fbstate/connect — JSON endpoint for intro page
            if (path2==="/api/fbstate/connect" && req.method==="POST") {
                const raw = await readRawBody(req);
                const eqIdx = raw.indexOf("fbstate=");
                let jsonStr = "";
                if (eqIdx !== -1) jsonStr = decodeURIComponent(raw.slice(eqIdx+8).replace(/\+/g," "));
                jsonStr = jsonStr.trim();
                if(!jsonStr){ json({ok:false,error:"No data received."}); return; }
                let parsed;
                try{ parsed=JSON.parse(jsonStr); }catch(e){ json({ok:false,error:"Invalid JSON: "+e.message}); return; }
                if(!Array.isArray(parsed)){ json({ok:false,error:"Must be a JSON array"}); return; }
                if(!parsed.some(c=>c.key==="c_user")){ json({ok:false,error:"Missing c_user cookie — not a valid fbstate"}); return; }
                if(!parsed.some(c=>c.key==="xs")){ json({ok:false,error:"Missing xs cookie — session token not found"}); return; }
                const now=Date.now()/1000;
                const expired=parsed.filter(c=>c.expirationDate&&c.expirationDate>0&&c.expirationDate<now&&["c_user","xs","datr"].includes(c.key));
                if(expired.length>0){ json({ok:false,error:"Cookie is expired ("+expired.map(c=>c.key).join(", ")+") — re-export from browser"}); return; }
                fs.writeFileSync(FBSTATE_FILE,JSON.stringify(parsed,null,2),"utf8");
                resetAll();
                if(_cookieUpdateCb) _cookieUpdateCb();
                json({ok:true}); return;
            }
            // ── /api/login-status — polling endpoint for login process page
            if (path2==="/api/login-status" && req.method==="GET") {
                json({loggedIn:state.loggedIn, botName:state.botName, loginInProgress:state.loginInProgress}); return;
            }
            // ── /api/fbstate/update — form POST from Cookie tab
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
                resetAll();
                if(_cookieUpdateCb) _cookieUpdateCb();
                res.writeHead(302,{Location:"/?page=login-process"});res.end(); return;
            }
            if (path2==="/api/state" && req.method==="GET") {
                res.writeHead(200,{"Content-Type":"application/json"});
                res.end(JSON.stringify({logs,state})); return;
            }
            // ── /api/cmds/add
            if (path2==="/api/cmds/add" && req.method==="POST") {
                const fields = await parseBody(req);
                const cmd  = (fields.cmd||"").trim().replace(/^!/,"").toLowerCase();
                const reply= (fields.reply||"").trim();
                if (!cmd||!reply){ htmlErr("Command and reply required."); return; }
                const list = readCustomCommands();
                if (!list.find(c=>c.cmd===cmd)) list.push({cmd,reply});
                writeCustomCommands(list);
                redirect(fields._tab||"cmds"); return;
            }
            // ── /api/cmds/remove
            if (path2==="/api/cmds/remove" && req.method==="POST") {
                const fields = await parseBody(req);
                const idx = parseInt(fields.index);
                const list = readCustomCommands();
                if (!isNaN(idx) && idx>=0 && idx<list.length) list.splice(idx,1);
                writeCustomCommands(list);
                redirect(fields._tab||"cmds"); return;
            }
            // ── /api/whitelist/toggle
            if (path2==="/api/whitelist/toggle" && req.method==="POST") {
                const wl = readWhitelist();
                wl.enabled = !wl.enabled;
                writeWhitelist(wl);
                redirect("threads"); return;
            }
            // ── /api/whitelist/add
            if (path2==="/api/whitelist/add" && req.method==="POST") {
                const fields = await parseBody(req);
                const uid = (fields.uid||"").trim();
                if (!uid){ htmlErr("UID required."); return; }
                const wl = readWhitelist();
                if (!wl.uids.includes(uid)) wl.uids.push(uid);
                writeWhitelist(wl);
                redirect("threads"); return;
            }
            // ── /api/whitelist/remove
            if (path2==="/api/whitelist/remove" && req.method==="POST") {
                const fields = await parseBody(req);
                const uid = (fields.uid||"").trim();
                const wl = readWhitelist();
                wl.uids = wl.uids.filter(u=>u!==uid);
                writeWhitelist(wl);
                redirect("threads"); return;
            }
            // ── /api/thread/config
            if (path2==="/api/thread/config" && req.method==="POST") {
                const fields = await parseBody(req);
                const tid = (fields.threadID||"").trim();
                if (!tid){ htmlErr("threadID required."); return; }
                const all = readThreadConfig();
                all[tid] = all[tid]||{};
                if (fields.loopDelay!=="") all[tid].loopDelay = parseFloat(fields.loopDelay)||1;
                else delete all[tid].loopDelay;
                if (fields.loopReact&&fields.loopReact.trim()) all[tid].loopReact = fields.loopReact.trim();
                else delete all[tid].loopReact;
                writeThreadConfig(all);
                redirect("threads"); return;
            }
            // ── /api/thread/startloop
            if (path2==="/api/thread/startloop" && req.method==="POST") {
                const fields = await parseBody(req);
                const tid = (fields.threadID||"").trim();
                if (tid && _loopControlCb) _loopControlCb("start", tid);
                redirect("threads"); return;
            }
            // ── /api/thread/stoploop
            if (path2==="/api/thread/stoploop" && req.method==="POST") {
                const fields = await parseBody(req);
                const tid = (fields.threadID||"").trim();
                if (tid && _loopControlCb) _loopControlCb("stop", tid);
                redirect("threads"); return;
            }
            // ── /api/thread/stopall
            if (path2==="/api/thread/stopall" && req.method==="POST") {
                if (_loopControlCb) {
                    const active = Object.keys(state.loopEnabled||{}).filter(tid=>state.loopEnabled[tid]);
                    active.forEach(tid=>_loopControlCb("stop",tid));
                }
                redirect("threads"); return;
            }
            // ── /api/cookie/slot
            if (path2==="/api/cookie/slot" && req.method==="POST") {
                const fields = await parseBody(req);
                const slotFile = (fields.slot||"fbstate.json").replace(/[^a-zA-Z0-9_.]/g,"");
                const jsonStr = (fields.fbstate||"").trim();
                if (!jsonStr){ htmlErr("No cookie data provided."); return; }
                let parsed;
                try{ parsed=JSON.parse(jsonStr); }catch(e){ htmlErr("Invalid JSON: "+String(e)); return; }
                if (!Array.isArray(parsed)){ htmlErr("fbstate must be a JSON array."); return; }
                if (!parsed.some(c=>c.key==="c_user")){ htmlErr("No c_user cookie found."); return; }
                const slotPath = path.join(DATA_DIR, slotFile);
                fs.writeFileSync(slotPath, JSON.stringify(parsed,null,2),"utf8");
                addAlert("info", `Cookie slot ${slotFile} updated`);
                if (slotFile==="fbstate.json") {
                    resetAll();
                    if (_cookieUpdateCb) _cookieUpdateCb();
                    res.writeHead(302,{Location:"/?page=login-process"});res.end();
                } else {
                    redirect("session");
                }
                return;
            }
            // ── /api/hourly-stats
            if (path2==="/api/hourly-stats" && req.method==="GET") {
                json(getHourlyStats()); return;
            }
            // ── /api/alerts
            if (path2==="/api/alerts" && req.method==="GET") {
                json(alerts); return;
            }
            // ── Show login process page
            if (path2==="/" && url.searchParams.get("page")==="login-process") {
                let html;
                try{ html=buildLoginProcess(); }catch(e){ html=`<pre style="color:red">${e.stack}</pre>`; }
                res.writeHead(200,{"Content-Type":"text/html"});
                res.end(html); return;
            }
            // ── Show intro page at / (no tab param)
            if (!tabParam && path2==="/") {
                let html;
                try{ html=buildIntro(); }catch(e){ html=`<pre style="color:red">${e.stack}</pre>`; }
                res.writeHead(200,{"Content-Type":"text/html"});
                res.end(html); return;
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

function buildLoginProcess() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Logging In — Cozy Bot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060c17;--s1:#0a1220;--s2:#0e1a2e;--s3:#132038;
  --b1:#172035;--b2:#1e2d45;--b3:#253652;
  --t1:#e8edf5;--t2:#8fa3be;--t3:#4e6585;
  --bl:#3b82f6;--bl2:#60a5fa;--bl3:#93c5fd;
  --cy:#06b6d4;--cy2:#22d3ee;
  --gn:#059669;--gn2:#10b981;--gn3:#34d399;
  --pu:#7c3aed;
  --mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif;
}
html,body{height:100%;overflow:hidden;background:var(--bg)}
body{font-family:var(--sans);color:var(--t1);display:flex;align-items:center;justify-content:center;position:relative}

.bg-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.bg-orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.12;animation:drift 14s ease-in-out infinite alternate}
.bg-orb-1{width:500px;height:400px;top:-100px;left:-150px;background:#2563eb;animation-delay:0s}
.bg-orb-2{width:400px;height:350px;bottom:-80px;right:-100px;background:#7c3aed;animation-delay:-5s}
.bg-orb-3{width:300px;height:250px;top:40%;left:40%;background:#06b6d4;animation-delay:-9s;opacity:.07}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(30px,20px) scale(1.06)}}
.bg-grid{position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(var(--b1) 1px,transparent 1px),linear-gradient(90deg,var(--b1) 1px,transparent 1px);background-size:40px 40px;opacity:.2}

.card{position:relative;z-index:10;width:100%;max-width:500px;background:var(--s1);border:1px solid var(--b2);border-radius:20px;padding:52px 44px;box-shadow:0 8px 40px #00000060,0 2px 8px #0005;overflow:hidden;margin:20px;text-align:center}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#1d4ed8,#7c3aed 50%,#06b6d4)}

.logo-icon{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);display:flex;align-items:center;justify-content:center;box-shadow:0 0 32px #3b82f630,0 4px 20px #0005;margin:0 auto 24px}

/* ── PHASE: LOGGING IN ── */
#phaseLogin{display:flex;flex-direction:column;align-items:center;gap:20px}
.spinner-ring{width:56px;height:56px;border:3px solid var(--b3);border-top-color:var(--bl2);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.login-label{font-size:11px;font-weight:700;font-family:var(--mono);letter-spacing:.18em;color:var(--t3);text-transform:uppercase}
.login-text{font-size:22px;font-weight:800;letter-spacing:-.04em;color:var(--t1)}
.login-text span{background:linear-gradient(135deg,var(--bl3),var(--cy2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.blink{animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

.dots{display:flex;gap:7px;justify-content:center;margin-top:4px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--bl2);animation:dotBounce 1.2s ease-in-out infinite}
.dot:nth-child(2){animation-delay:.2s}
.dot:nth-child(3){animation-delay:.4s}
@keyframes dotBounce{0%,80%,100%{transform:scale(0.6);opacity:.4}40%{transform:scale(1.1);opacity:1}}

.progress-bar{width:100%;height:3px;background:var(--b2);border-radius:99px;overflow:hidden;margin-top:8px}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--bl),var(--cy));border-radius:99px;animation:progressAnim 15s linear forwards}
@keyframes progressAnim{0%{width:0%}60%{width:72%}90%{width:88%}100%{width:88%}}

/* ── PHASE: SUCCESS ── */
#phaseSuccess{display:none;flex-direction:column;align-items:center;gap:16px;animation:fadeUp .5s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.success-check{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#059669,#10b981);display:flex;align-items:center;justify-content:center;box-shadow:0 0 40px #05966940,0 4px 20px #0005;animation:popIn .5s cubic-bezier(.36,.07,.19,.97)}
@keyframes popIn{0%{transform:scale(0)}70%{transform:scale(1.15)}100%{transform:scale(1)}}
.success-label{font-size:11px;font-weight:700;font-family:var(--mono);letter-spacing:.18em;color:var(--gn3);text-transform:uppercase}
.success-title{font-size:13px;font-weight:600;color:var(--t3)}
.success-name{font-size:26px;font-weight:900;letter-spacing:-.05em;background:linear-gradient(135deg,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-top:2px}
.redirect-hint{font-size:11px;color:var(--t4);font-family:var(--mono);margin-top:8px}

/* ── PHASE: TIMEOUT ── */
#phaseTimeout{display:none;flex-direction:column;align-items:center;gap:14px}
.timeout-icon{font-size:40px}
.timeout-msg{font-size:13px;color:var(--t3);line-height:1.7;max-width:320px}
.btn-dash{margin-top:8px;padding:12px 28px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--sans);letter-spacing:-.01em;transition:all .2s}
.btn-dash:hover{transform:translateY(-1px);box-shadow:0 6px 24px #3b82f640}
</style>
</head>
<body>
<div class="bg-layer">
    <div class="bg-orb bg-orb-1"></div>
    <div class="bg-orb bg-orb-2"></div>
    <div class="bg-orb bg-orb-3"></div>
</div>
<div class="bg-grid"></div>

<div class="card">
    <div class="logo-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8.5" cy="15.5" r=".7" fill="white"/><circle cx="15.5" cy="15.5" r=".7" fill="white"/></svg>
    </div>

    <!-- LOGGING IN -->
    <div id="phaseLogin">
        <div class="spinner-ring"></div>
        <div>
            <div class="login-label">Please wait</div>
            <div class="login-text">LOGGING IN YOUR <span>COOKIE</span><span class="blink">_</span></div>
        </div>
        <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
        <div class="progress-bar"><div class="progress-fill"></div></div>
    </div>

    <!-- SUCCESS -->
    <div id="phaseSuccess">
        <div class="success-check">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div>
            <div class="success-label">✓ Authentication complete</div>
            <div class="success-title">SUCCESSFULLY LOGGED AS</div>
            <div class="success-name" id="botNameEl">—</div>
        </div>
        <div class="redirect-hint">Redirecting to dashboard…</div>
    </div>

    <!-- TIMEOUT -->
    <div id="phaseTimeout">
        <div class="timeout-icon">⏱</div>
        <div class="timeout-msg">Login is taking longer than expected. The bot may still be connecting. You can go to the dashboard now.</div>
        <button class="btn-dash" onclick="location.href='/?tab=dashboard'">Go to Dashboard →</button>
    </div>
</div>

<script>
const phaseLogin   = document.getElementById('phaseLogin');
const phaseSuccess = document.getElementById('phaseSuccess');
const phaseTimeout = document.getElementById('phaseTimeout');
const botNameEl    = document.getElementById('botNameEl');

let attempts = 0;
const MAX_ATTEMPTS = 80;

async function poll() {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
        phaseLogin.style.display   = 'none';
        phaseTimeout.style.display = 'flex';
        return;
    }
    try {
        const res  = await fetch('/api/login-status');
        const data = await res.json();
        if (data.loggedIn && data.botName) {
            botNameEl.textContent = data.botName;
            phaseLogin.style.display   = 'none';
            phaseSuccess.style.display = 'flex';
            setTimeout(() => { location.href = '/?tab=dashboard'; }, 2800);
            return;
        }
    } catch(_) {}
    setTimeout(poll, 1500);
}

setTimeout(poll, 1000);
</script>
</body>
</html>`;
}

module.exports = { startDashboard, addLog, state, setCookieUpdateHandler, setLoopControlHandler, trackMessage, addAlert };
