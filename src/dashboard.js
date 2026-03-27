"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const CUSTOM_REPLIES_FILE = path.join(__dirname, "../data/custom_replies.json");
const BOT_CONFIG_FILE     = path.join(__dirname, "../data/bot_config.json");
const MAX_LOGS = 150;
const logs = [];
const state = {
    bots: [],
    developerID: "",
    autoReplyEnabled: {},
    mutedThreads: {},
    totalRepliesSent: 0,
    nicknameMap: {},
    startedAt: new Date(),
    antiRestrict: false,
    antiChat: {},
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
    const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
    if (d>0) return `${d}d ${h%24}h`;
    if (h>0) return `${h}h ${m%60}m`;
    if (m>0) return `${m}m ${s%60}s`;
    return `${s}s`;
}

function esc(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function readCustomReplies() {
    try { return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8")); } catch(_){ return []; }
}
function writeCustomReplies(arr) {
    fs.writeFileSync(CUSTOM_REPLIES_FILE, JSON.stringify(arr, null, 2), "utf8");
}
function readBotConfig() {
    try { return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE,"utf8")); }
    catch(_) { return { loopReact:"😆", loopDelay:5, imageProbability:20 }; }
}
function writeBotConfig(cfg) {
    fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

const IC = {
    bot:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2.5"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/></svg>`,
    messages: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    users:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    clock:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    zap:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    chat:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    check:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    x:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warn:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    err:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    reply:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`,
    mute:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    plus:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    trash:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
    word:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="13" y2="14"/></svg>`,
};

function icon(name, size=16) {
    return `<span class="ic" style="width:${size}px;height:${size}px">${IC[name]||""}</span>`;
}

function buildHTML() {
    const threads    = Object.keys(state.autoReplyEnabled);
    const activeCount= threads.filter(t=>state.autoReplyEnabled[t]).length;
    const offCount   = threads.length - activeCount;
    const mutedCount = Object.values(state.mutedThreads||{}).filter(Boolean).length;
    const isOnline   = state.loggedIn;
    const isRecon    = state.reconnecting;
    const statusText = isOnline ? "Online" : (isRecon ? "Reconnecting..." : "Offline");
    const statusColor= isOnline ? "#22c55e" : (isRecon ? "#f59e0b" : "#ef4444");

    const customReplies = readCustomReplies();
    const botConfig     = readBotConfig();

    const botBadges = state.bots.length === 0
        ? `<span class="bot-pill bot-pill-off"><div class="dot"></div>No bots loaded</span>`
        : state.bots.map(b => {
            const bc = b.loggedIn ? "#22c55e" : (b.reconnecting ? "#f59e0b" : "#ef4444");
            const bt = b.loggedIn ? "Online" : (b.reconnecting ? `Reconnecting ${b.nextReconnectIn}s` : "Offline");
            const pulse = b.loggedIn
                ? `box-shadow:0 0 8px ${bc}cc,0 0 16px ${bc}66;animation:pulse 2.4s ease-in-out infinite;`
                : (b.reconnecting ? `animation:pulse 0.9s ease-in-out infinite;` : "");
            return `<span class="bot-pill" style="color:${bc}">` +
                `<div class="dot" style="background:${bc};${pulse}"></div>` +
                `<span class="pill-name">${esc(b.label)}</span>` +
                `<span class="pill-sub">${bt}</span></span>`;
        }).join("");

    const threadRows = threads.length === 0
        ? `<tr><td colspan="3" class="empty-row">No threads yet — send <code>!on</code> in Messenger</td></tr>`
        : threads.map(tid => {
            const on  = state.autoReplyEnabled[tid];
            const muted = state.mutedThreads&&state.mutedThreads[tid];
            const label = on ? (muted ? "muted" : "active") : "idle";
            const cls   = on ? (muted ? "badge-muted" : "badge-on") : "badge-off";
            const dot   = on ? (muted ? "#f59e0b" : "#10b981") : "#f43f5e";
            return `<tr><td class="td-icon">${icon("chat",13)}</td>` +
                `<td class="tid mono">${esc(tid)}</td>` +
                `<td><span class="badge ${cls}"><div class="dot" style="background:${dot}"></div>${label}</span></td></tr>`;
        }).join("");

    const LOG_LABELS = {error:"ERR ",warn:"WARN",reply:"SEND",info:"INFO"};
    const logRows = logs.length === 0
        ? `<div class="log-entry info"><span class="log-ts">--:--:--</span><span class="log-level" style="color:var(--muted)">IDLE</span><span class="log-msg">Waiting for events…</span></div>`
        : logs.map(l => {
            const lv = LOG_LABELS[l.type]||"INFO";
            return `<div class="log-entry ${l.type}"><span class="log-ts">${esc(l.time)}</span><span class="log-level">${lv}</span><span class="log-msg">${esc(l.message)}</span></div>`;
        }).join("");

    const customWordRows = customReplies.length === 0
        ? `<div class="empty-state">Queue is empty — push the first message above.</div>`
        : customReplies.map((w,i) =>
            `<div class="word-item">
                <span class="word-idx">${String(i+1).padStart(2,'0')}</span>
                <span class="word-val">${esc(w)}</span>
                <form method="POST" action="/api/replies/remove" style="display:inline">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-del" type="submit">${icon("trash",12)} remove</button>
                </form>
            </div>`
        ).join("");

    const COMMANDS = [
        ["!on / !off",            "Toggle auto-reply — works sa groups at PMs"],
        ["!mute / !unmute",       "I-pause o i-resume ang auto-reply"],
        ["!say &lt;text&gt;",     "Bot mag-send ng text sa chat"],
        ["!vm &lt;text&gt;",      "Bot mag-send ng voice message (TTS)"],
        ["!nn &lt;name&gt;",      "I-set ang nickname ng lahat ng members"],
        ["!cg &lt;name&gt;",      "I-palitan ang pangalan ng group"],
        ["!banner [url]",         "I-set ang group photo + protection"],
        ["!kick &lt;uid&gt;",     "I-kick ang member sa group"],
        ["!add &lt;uid&gt;",      "Mag-add ng member sa group"],
        ["!emoji &lt;emoji&gt;",  "Palitan ang group emoji"],
        ["!color &lt;name&gt;",   "Palitan ang chat color"],
        ["!seen",                 "I-mark lahat ng messages bilang read"],
        ["!spam &lt;n&gt; &lt;msg&gt;", "Mag-send ng message ng n beses (max 20)"],
        ["!info",                 "Show group info — name, members, admins, ID"],
        ["!lock",                 "Tingnan ang lahat ng active protections"],
        ["!freeze / !unfreeze",   "I-freeze ang group — sino mang mag-chat, ma-kick"],
        ["!perms &lt;uid&gt; &lt;time&gt;","Bigyan ng temp access e.g. 5min, 1h"],
        ["!revoke [uid]",         "I-alis ang temp permissions"],
        ["!gp &lt;url&gt;",       "Guard profile pic — auto-restore every 5 min"],
        ["!gp off",               "I-off ang profile guard"],
        ["!antirestrict",         "Alert sa dev kapag na-kick ang bot sa group"],
        ["!antichat",             "Auto-retry kapag nabigo ang send"],
        ["!count",                "Mag-count ng 1 hanggang 20 sa chat"],
        ["!id",                   "I-kuha ang Facebook ID ng in-reply"],
        ["!test",                 "Ping ang bot"],
        ["!status",               "Makita ang auto-reply + freeze status"],
        ["!myid",                 "Ipakita ang sariling Facebook ID"],
        ["!help",                 "Ipakita ang listahan ng commands sa Messenger"],
    ];

    const cmdRows = COMMANDS.map(([cmd,desc])=>
        `<tr><td class="cmd-cell mono">${cmd}</td><td class="desc-cell">${desc}</td></tr>`
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CZB // Control Panel</title>
<meta http-equiv="refresh" content="8"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080b10;--s0:#0c1018;--s1:#0f1319;--s2:#141920;--s3:#1a2030;
  --border:#1e2530;--border2:#253040;--border3:#2e3d50;
  --text:#c8d8e8;--muted:#3a4d60;--muted2:#5a7a95;--muted3:#7a9ab5;
  --accent:#0ea5e9;--accent2:#38bdf8;--accentG:linear-gradient(135deg,#0369a1,#0ea5e9,#38bdf8);
  --green:#10b981;--green2:#34d399;--red:#f43f5e;--yellow:#f59e0b;
  --cyan:#06b6d4;--violet:#818cf8;--orange:#f97316;
  --mono:'JetBrains Mono',monospace;--sans:'Inter',system-ui,sans-serif;
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);
  font-family:var(--mono);
  font-size:13px;line-height:1.65;min-height:100vh;
  padding:0;margin:0;
  background-image:
    radial-gradient(ellipse 60% 30% at 80% 0%,#0ea5e91a,transparent),
    radial-gradient(ellipse 40% 20% at 10% 100%,#818cf80a,transparent);
}
.layout{max-width:1100px;margin:0 auto;padding:28px 20px 60px}

/* TOPBAR */
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 20px;background:var(--s0);
  border-bottom:1px solid var(--border);
  font-size:11.5px;color:var(--muted2);
  font-family:var(--mono);
  position:sticky;top:0;z-index:99;
  backdrop-filter:blur(12px);
}
.topbar-left{display:flex;align-items:center;gap:16px}
.topbar-logo{
  font-size:13px;font-weight:700;letter-spacing:.08em;
  color:var(--accent2);
  display:flex;align-items:center;gap:8px;
}
.topbar-logo .lb{color:var(--muted3);font-weight:400}
.topbar-tag{
  font-size:10px;font-weight:600;letter-spacing:.12em;
  padding:2px 8px;border-radius:4px;text-transform:uppercase;
  background:#0ea5e912;border:1px solid #0ea5e930;color:var(--accent2);
}
.topbar-right{display:flex;align-items:center;gap:14px}
.topbar-devid{color:var(--muted3);font-size:11px}
.topbar-devid span{color:var(--accent);font-weight:600}
.sync-indicator{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--muted2)}
.sync-dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:blink 2s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}

/* HEADER BLOCK */
.page-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:28px;flex-wrap:wrap;gap:14px;
  padding-top:8px;
}
.ph-left{display:flex;align-items:center;gap:14px}
.ph-icon{
  width:44px;height:44px;border-radius:10px;flex-shrink:0;
  background:linear-gradient(135deg,#0369a1,#0ea5e9);
  display:flex;align-items:center;justify-content:center;color:#fff;
  box-shadow:0 0 20px #0ea5e940;
}
.ph-icon .ic{width:22px;height:22px}
.ph-title{font-size:18px;font-weight:700;letter-spacing:-.01em;color:#e2f0ff;line-height:1.1}
.ph-sub{font-size:11px;color:var(--muted3);margin-top:3px;font-family:var(--mono)}
.bot-badges{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bot-pill{
  display:inline-flex;align-items:center;gap:7px;
  background:var(--s2);border:1px solid var(--border2);
  border-radius:6px;padding:6px 14px;
  font-size:11.5px;font-weight:500;font-family:var(--mono);
}
.bot-pill-off{color:var(--muted2)}
.pill-name{color:var(--text);font-weight:600;font-size:12px}
.pill-sub{opacity:0.55;font-size:10.5px}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.2;transform:scale(0.75)}}

/* DIVIDER */
.divider{height:1px;background:var(--border);margin-bottom:24px}

/* STAT CARDS */
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}}
.card{
  background:var(--s1);border:1px solid var(--border);
  border-radius:10px;padding:18px 16px 14px;
  position:relative;overflow:hidden;
  transition:border-color .2s;
}
.card:hover{border-color:var(--border3)}
.card-stripe{position:absolute;top:0;left:0;right:0;height:2px;border-radius:10px 10px 0 0}
.s-blue{background:linear-gradient(90deg,#0369a1,#38bdf8)}
.s-green{background:linear-gradient(90deg,#059669,#34d399)}
.s-violet{background:linear-gradient(90deg,#6366f1,#818cf8)}
.s-orange{background:linear-gradient(90deg,#c2410c,#f97316)}
.card-label{font-size:9px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:.14em;margin-bottom:10px}
.card-val{font-size:28px;font-weight:700;line-height:1;color:#e2f0ff;font-family:var(--mono)}
.card-val.blue{color:var(--accent2)}
.card-val.green{color:var(--green2)}
.card-val.violet{color:var(--violet)}
.card-val.orange{color:var(--orange)}
.card-sub{font-size:10.5px;color:var(--muted2);margin-top:6px}

/* SECTION HEADING */
.sec-head{
  display:flex;align-items:center;gap:8px;
  font-size:9.5px;font-weight:700;color:var(--muted2);
  text-transform:uppercase;letter-spacing:.16em;margin-bottom:10px;
}
.sec-head::after{content:'';flex:1;height:1px;background:var(--border)}
.sec-head .ic{width:13px;height:13px;opacity:.5}

/* PANEL */
.panel{
  background:var(--s1);border:1px solid var(--border);
  border-radius:10px;overflow:hidden;
  margin-bottom:20px;
}
.panel-head{
  background:var(--s2);border-bottom:1px solid var(--border);
  padding:10px 16px;display:flex;align-items:center;justify-content:space-between;
  font-size:11px;font-weight:600;color:var(--muted3);letter-spacing:.06em;
}
.panel-head-left{display:flex;align-items:center;gap:8px}
.panel-tag{
  font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  padding:2px 8px;border-radius:4px;
  background:#0ea5e912;border:1px solid #0ea5e925;color:var(--accent);
}

/* TABLE */
table{width:100%;border-collapse:collapse}
th{
  padding:9px 14px;text-align:left;
  font-size:9px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.12em;
  background:var(--s2);border-bottom:1px solid var(--border);
}
td{padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;vertical-align:middle;color:var(--text)}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff02}
.td-icon{width:32px;padding-right:0;opacity:.25}
.tid{font-family:var(--mono);font-size:11.5px;color:var(--muted3)}
.mono{font-family:var(--mono)}
.empty-row{color:var(--muted2);text-align:center;padding:24px 14px;font-size:12px}
.empty-row code{
  background:var(--s3);border:1px solid var(--border2);
  border-radius:4px;padding:1px 6px;
  font-family:var(--mono);font-size:11.5px;color:var(--accent2);
}

/* STATUS BADGES */
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:600;font-family:var(--mono)}
.badge-on{background:#10b98115;color:var(--green2);border:1px solid #10b98130}
.badge-off{background:#f43f5e15;color:#fb7185;border:1px solid #f43f5e30}
.badge-muted{background:#f59e0b15;color:#fbbf24;border:1px solid #f59e0b30}
.badge .dot{width:5px;height:5px}

/* TERMINAL / LOGS */
.log-wrap{
  max-height:300px;overflow-y:auto;
  background:var(--bg);padding:4px 0;
  font-family:var(--mono);font-size:12px;
  scroll-behavior:smooth;
}
.log-wrap::-webkit-scrollbar{width:3px}
.log-wrap::-webkit-scrollbar-thumb{background:var(--border3);border-radius:99px}
.log-entry{display:flex;align-items:flex-start;gap:12px;padding:4px 16px;line-height:1.5;transition:background .1s}
.log-entry:hover{background:#ffffff02}
.log-ts{color:var(--muted);font-size:10.5px;flex-shrink:0;min-width:68px;padding-top:1px}
.log-level{font-size:10px;font-weight:700;flex-shrink:0;min-width:36px;padding-top:2px;text-transform:uppercase;letter-spacing:.06em}
.log-msg{color:var(--muted3);word-break:break-word;flex:1}
.log-entry.error .log-level{color:#f43f5e}.log-entry.error .log-msg{color:#fda4af}
.log-entry.warn  .log-level{color:#f59e0b}.log-entry.warn  .log-msg{color:#fcd34d}
.log-entry.reply .log-level{color:var(--green2)}.log-entry.reply .log-msg{color:#6ee7b7}
.log-entry.info  .log-level{color:var(--accent)}.log-entry.info  .log-msg{color:var(--muted3)}

/* COMMANDS */
.cmd-cell{font-family:var(--mono);font-size:11.5px;color:var(--accent2);white-space:nowrap;width:1%;padding-right:4px}
.desc-cell{color:var(--muted3);font-size:12px}

/* WORDS MANAGER */
.input-row{display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.text-input{
  flex:1;min-width:180px;
  background:var(--s0);border:1px solid var(--border2);
  border-radius:6px;padding:8px 12px;
  color:var(--text);font-size:12.5px;outline:none;
  transition:border-color .2s;font-family:var(--mono);
}
.text-input:focus{border-color:var(--accent)}
.text-input::placeholder{color:var(--muted)}
.btn-primary{
  background:var(--accentG);color:#fff;border:none;
  border-radius:6px;padding:8px 18px;font-size:12px;font-weight:600;
  cursor:pointer;display:flex;align-items:center;gap:6px;
  transition:opacity .15s;font-family:var(--mono);white-space:nowrap;
  letter-spacing:.04em;
}
.btn-primary:hover{opacity:.85}
.word-list{padding:4px 0;max-height:320px;overflow-y:auto}
.word-list::-webkit-scrollbar{width:3px}
.word-list::-webkit-scrollbar-thumb{background:var(--border3);border-radius:99px}
.word-item{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:7px 16px;border-bottom:1px solid var(--border);transition:background .1s;
}
.word-item:last-child{border-bottom:none}
.word-item:hover{background:#ffffff02}
.word-idx{font-size:10px;color:var(--muted);min-width:28px;flex-shrink:0;font-family:var(--mono)}
.word-val{color:var(--text);font-size:12.5px;word-break:break-word;flex:1;font-family:var(--mono)}
.btn-del{
  background:#f43f5e10;color:#fb7185;border:1px solid #f43f5e25;
  border-radius:5px;padding:3px 10px;font-size:11px;font-weight:600;
  cursor:pointer;display:flex;align-items:center;gap:4px;
  transition:background .15s;white-space:nowrap;flex-shrink:0;font-family:var(--mono);
}
.btn-del:hover{background:#f43f5e20}
.empty-state{color:var(--muted2);text-align:center;padding:24px 14px;font-size:12px}

/* SETTINGS */
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;padding:16px;border-bottom:1px solid var(--border)}
.cfg-field{display:flex;flex-direction:column;gap:5px}
.cfg-label{font-size:9.5px;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:.13em}
.cfg-input{
  background:var(--s0);border:1px solid var(--border2);
  border-radius:6px;padding:8px 12px;color:var(--text);
  font-size:12.5px;outline:none;transition:border-color .2s;
  font-family:var(--mono);width:100%;
}
.cfg-input:focus{border-color:var(--accent)}
.cfg-hint{font-size:10.5px;color:var(--muted);line-height:1.4}
.cfg-footer{padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.cfg-note{font-size:11px;color:var(--muted2)}
.cfg-note b{color:var(--muted3)}
.btn-save{
  background:linear-gradient(135deg,#0369a1,#0ea5e9);color:#fff;border:none;
  border-radius:6px;padding:8px 20px;font-size:12px;font-weight:600;
  cursor:pointer;transition:opacity .15s;font-family:var(--mono);letter-spacing:.04em;
}
.btn-save:hover{opacity:.85}

/* TWO COL */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
@media(max-width:680px){
  .two-col{grid-template-columns:1fr}
  .cards{grid-template-columns:1fr 1fr}
  .layout{padding:20px 14px 48px}
  .topbar{display:none}
}

/* FOOTER */
.page-footer{
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
  border-top:1px solid var(--border);padding-top:16px;margin-top:8px;
  font-size:11px;color:var(--muted);font-family:var(--mono);
}
.pfr{display:flex;align-items:center;gap:6px}

/* IC */
.ic{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.ic svg{width:100%;height:100%}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-left">
    <div class="topbar-logo">CZB<span class="lb">::</span>panel<span class="lb">.js</span></div>
    <span class="topbar-tag">v1.0</span>
    <span style="color:var(--muted);font-size:10.5px">Messenger Automation Runtime</span>
  </div>
  <div class="topbar-right">
    <div class="topbar-devid">dev_id: <span>${esc(state.developerID||"—")}</span></div>
    <div class="sync-indicator"><div class="sync-dot"></div>auto-sync 8s</div>
  </div>
</div>

<div class="layout">

<div class="page-header">
  <div class="ph-left">
    <div class="ph-icon">${icon("bot",22)}</div>
    <div>
      <div class="ph-title">Control Panel</div>
      <div class="ph-sub">cozy-bot // loop engine // tts module</div>
    </div>
  </div>
  <div class="bot-badges">${botBadges}</div>
</div>

<div class="divider"></div>

<div class="cards">
  <div class="card">
    <div class="card-stripe s-blue"></div>
    <div class="card-label">Messages Sent</div>
    <div class="card-val blue">${state.totalRepliesSent}</div>
    <div class="card-sub">total loop dispatches</div>
  </div>
  <div class="card">
    <div class="card-stripe s-green"></div>
    <div class="card-label">Active Loops</div>
    <div class="card-val green">${activeCount}</div>
    <div class="card-sub">threads running</div>
  </div>
  <div class="card">
    <div class="card-stripe s-violet"></div>
    <div class="card-label">Total Threads</div>
    <div class="card-val violet">${threads.length}</div>
    <div class="card-sub">${offCount} idle · ${mutedCount} muted</div>
  </div>
  <div class="card">
    <div class="card-stripe s-orange"></div>
    <div class="card-label">Uptime</div>
    <div class="card-val orange" style="font-size:${getUptime().length>6?'18':'26'}px;padding-top:4px">${getUptime()}</div>
    <div class="card-sub">since last boot</div>
  </div>
</div>

<div class="two-col">
  <div>
    <div class="sec-head">${icon("chat",13)} Thread Registry</div>
    <div class="panel">
      <div class="panel-head">
        <div class="panel-head-left"><span class="panel-tag">LIVE</span> active threads</div>
        <span style="color:var(--muted);font-size:10.5px">${threads.length} total</span>
      </div>
      <table>
        <thead><tr><th style="width:30px"></th><th>Thread ID</th><th>State</th></tr></thead>
        <tbody>${threadRows}</tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="sec-head">${icon("activity",13)} System Log</div>
    <div class="panel">
      <div class="panel-head">
        <div class="panel-head-left"><span class="panel-tag">STREAM</span> event output</div>
        <span style="color:var(--muted);font-size:10.5px">${logs.length} entries</span>
      </div>
      <div class="log-wrap">${logRows}</div>
    </div>
  </div>
</div>

<!-- WORDS MANAGER -->
<div class="sec-head">${icon("word",13)} Loop Message Queue</div>
<div class="panel">
  <div class="panel-head">
    <div class="panel-head-left"><span class="panel-tag">QUEUE</span> custom reply pool</div>
    <span style="color:var(--accent);font-size:10.5px;font-weight:600">${customReplies.length} custom · ${customReplies.length + 102} total</span>
  </div>
  <form class="input-row" method="POST" action="/api/replies/add">
    <input class="text-input" type="text" name="word" placeholder="Add new message to queue..." autocomplete="off" required/>
    <button class="btn-primary" type="submit">${icon("plus",13)} Push to Queue</button>
  </form>
  <div class="word-list">${customWordRows}</div>
</div>

<!-- BOT SETTINGS -->
<div class="sec-head">${icon("zap",13)} Runtime Configuration</div>
<div class="panel">
  <div class="panel-head">
    <div class="panel-head-left"><span class="panel-tag">CONFIG</span> loop engine params</div>
    <span style="color:var(--muted);font-size:10.5px">writes to /data/bot_config.json</span>
  </div>
  <form method="POST" action="/api/config/save">
    <div class="cfg-grid">
      <div class="cfg-field">
        <label class="cfg-label">loop.react_emoji</label>
        <input class="cfg-input" type="text" name="loopReact" value="${esc(botConfig.loopReact||'😆')}" placeholder="😆" maxlength="8"/>
        <span class="cfg-hint">Reaction attached to each sent message</span>
      </div>
      <div class="cfg-field">
        <label class="cfg-label">loop.delay_seconds</label>
        <input class="cfg-input" type="number" name="loopDelay" value="${botConfig.loopDelay||5}" min="1" max="60" placeholder="5"/>
        <span class="cfg-hint">Interval between each dispatch (1–60s)</span>
      </div>
      <div class="cfg-field">
        <label class="cfg-label">loop.image_chance_%</label>
        <input class="cfg-input" type="number" name="imageProbability" value="${botConfig.imageProbability||20}" min="0" max="100" placeholder="20"/>
        <span class="cfg-hint">Probability of sending an image (0–100)</span>
      </div>
    </div>
    <div class="cfg-footer">
      <span class="cfg-note">Trigger: send <b>.</b> in chat to toggle loop on/off</span>
      <button class="btn-save" type="submit">▶ Apply Config</button>
    </div>
  </form>
</div>

<!-- COMMANDS -->
<div class="sec-head">${icon("terminal",13)} Command Reference</div>
<div class="panel">
  <div class="panel-head">
    <div class="panel-head-left"><span class="panel-tag">DOCS</span> available commands</div>
    <span style="color:var(--muted);font-size:10.5px">prefix: <span style="color:var(--accent2)">!</span></span>
  </div>
  <table>
    <thead><tr><th>Command</th><th>Description</th></tr></thead>
    <tbody>${cmdRows}</tbody>
  </table>
</div>

<div class="page-footer">
  <span>czb::panel &nbsp;// &nbsp;node.js runtime &nbsp;// &nbsp;prefix <span style="color:var(--accent2)">!</span></span>
  <div class="pfr"><div class="sync-dot"></div><span>auto-refresh 8s</span></div>
</div>

</div>
</body>
</html>`;
}

function parseBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", chunk => { body += chunk.toString(); });
        req.on("end", () => {
            const params = {};
            body.split("&").forEach(pair => {
                const [k, v] = pair.split("=");
                if (k) params[decodeURIComponent(k.replace(/\+/g," "))] = decodeURIComponent((v||"").replace(/\+/g," "));
            });
            resolve(params);
        });
    });
}

function startDashboard(port = 5000) {
    const server = http.createServer(async (req, res) => {
        try {
            // API — state JSON
            if (req.url === "/api/state" && req.method === "GET") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ logs, state }));
                return;
            }

            // API — add custom reply
            if (req.url === "/api/replies/add" && req.method === "POST") {
                const params = await parseBody(req);
                const word = (params.word || "").trim();
                if (word) {
                    const arr = readCustomReplies();
                    arr.push(word);
                    writeCustomReplies(arr);
                }
                res.writeHead(302, { Location: "/" });
                res.end();
                return;
            }

            // API — save bot config
            if (req.url === "/api/config/save" && req.method === "POST") {
                const params = await parseBody(req);
                const cfg = readBotConfig();
                if (params.loopReact)       cfg.loopReact        = params.loopReact.trim();
                if (params.loopDelay)       cfg.loopDelay        = Math.max(1, parseInt(params.loopDelay) || 5);
                if (params.imageProbability !== undefined) cfg.imageProbability = Math.min(100, Math.max(0, parseInt(params.imageProbability) || 20));
                writeBotConfig(cfg);
                res.writeHead(302, { Location: "/" });
                res.end();
                return;
            }

            // API — remove custom reply
            if (req.url === "/api/replies/remove" && req.method === "POST") {
                const params = await parseBody(req);
                const idx = parseInt(params.index);
                if (!isNaN(idx)) {
                    const arr = readCustomReplies();
                    if (idx >= 0 && idx < arr.length) {
                        arr.splice(idx, 1);
                        writeCustomReplies(arr);
                    }
                }
                res.writeHead(302, { Location: "/" });
                res.end();
                return;
            }

            // Main dashboard
            let html;
            try { html = buildHTML(); }
            catch (e) {
                html = `<!DOCTYPE html><html><body style="background:#0d0a1a;color:#ef4444;font-family:monospace;padding:40px">
                    <h2>Render error</h2><pre>${String(e)}</pre>
                    <meta http-equiv="refresh" content="5"/></body></html>`;
            }
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
        } catch (e) {
            try { res.writeHead(500); res.end("Server error"); } catch(_) {}
        }
    });

    server.on("error", err => console.error("[cozy-bot] Dashboard error:", err));
    server.listen(port, "0.0.0.0", () => console.log(`[cozy-bot] Dashboard running on port ${port}`));
}

module.exports = { startDashboard, addLog, state };
