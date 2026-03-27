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
        ? `<tr><td colspan="3" class="empty-row">No chats yet — type <code>!on</code> in Messenger</td></tr>`
        : threads.map(tid => {
            const on  = state.autoReplyEnabled[tid];
            const muted = state.mutedThreads&&state.mutedThreads[tid];
            const label = on ? (muted ? "Muted" : "Active") : "Off";
            const cls   = on ? (muted ? "muted" : "active") : "off";
            return `<tr><td class="td-icon">${icon("chat",14)}</td>` +
                `<td class="tid mono">${esc(tid)}</td>` +
                `<td><span class="pill pill-${cls}">${icon(muted?"mute":(on?"check":"x"),11)} ${label}</span></td></tr>`;
        }).join("");

    const logRows = logs.length === 0
        ? `<div class="log-row info">${icon("info",13)}<span class="lt">--:--</span><span class="lm">Waiting for events…</span></div>`
        : logs.map(l => {
            const ic = l.type==="error"?"err":l.type==="warn"?"warn":l.type==="reply"?"reply":"info";
            return `<div class="log-row ${l.type}">${icon(ic,13)}<span class="lt mono">${esc(l.time)}</span><span class="lm">${esc(l.message)}</span></div>`;
        }).join("");

    const customWordRows = customReplies.length === 0
        ? `<div class="empty-words">Wala pang custom reply. Mag-add na!</div>`
        : customReplies.map((w,i) =>
            `<div class="word-row">
                <span class="word-text">${esc(w)}</span>
                <form method="POST" action="/api/replies/remove" style="display:inline">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-del" type="submit">${icon("trash",13)} Delete</button>
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
  --bg:#0d0a1a;--s1:#120e24;--s2:#1a1430;--s3:#201a3a;
  --border:#2a2050;--border2:#352860;
  --text:#ece8ff;--muted:#5a4e80;--muted2:#8b7ab8;
  --accent:#9333ea;--accent2:#a855f7;--accentG:linear-gradient(135deg,#7c3aed,#a855f7,#d946ef);
  --green:#22c55e;--red:#ef4444;--yellow:#f59e0b;
  --blue:#60a5fa;--cyan:#06b6d4;--pink:#ec4899;--fuchsia:#d946ef;
  --mono:'JetBrains Mono',monospace;
}
body{
  background:var(--bg);color:var(--text);
  font-family:'Inter',system-ui,sans-serif;
  font-size:13.5px;line-height:1.6;min-height:100vh;
  padding:36px 20px 64px;max-width:1080px;margin:0 auto;
  background-image:
    radial-gradient(ellipse 70% 40% at 50% -8%,#7c3aed1a,transparent),
    radial-gradient(ellipse 40% 30% at 90% 5%,#d946ef0e,transparent),
    radial-gradient(ellipse 30% 20% at 5% 80%,#06b6d40a,transparent);
}

/* HEADER */
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:36px;flex-wrap:wrap;gap:14px}
.header-left{display:flex;align-items:center;gap:14px}
.avatar{
  width:52px;height:52px;border-radius:14px;flex-shrink:0;
  background:var(--accentG);
  display:flex;align-items:center;justify-content:center;color:#fff;
  box-shadow:0 0 28px #9333ea55,0 4px 16px #0009;
}
.avatar .ic{width:28px;height:28px}
.bot-name{
  font-size:22px;font-weight:800;line-height:1.1;letter-spacing:-0.02em;
  background:linear-gradient(90deg,#ece8ff 0%,#c084fc 50%,#f0abfc 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.bot-sub{font-size:11.5px;color:var(--muted2);margin-top:4px}
.bot-badges{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bot-pill{
  display:inline-flex;align-items:center;gap:8px;
  background:var(--s3);border:1px solid var(--border2);
  border-radius:999px;padding:7px 16px;
  font-size:12px;font-weight:600;
  box-shadow:0 2px 12px #0007;
}
.bot-pill-off{color:var(--muted2)}
.pill-name{color:var(--text);font-weight:700;font-size:12.5px;margin-right:1px}
.pill-sub{opacity:0.6;font-size:11px}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.3;transform:scale(0.8)}}

/* SEP */
.sep{height:1px;background:linear-gradient(90deg,transparent,var(--border2) 25%,var(--border2) 75%,transparent);margin-bottom:28px}

/* STAT CARDS */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin-bottom:28px}
.card{
  background:var(--s2);border:1px solid var(--border);
  border-radius:16px;padding:20px 18px 16px;
  position:relative;overflow:hidden;
}
.card::after{content:'';position:absolute;top:0;left:0;right:0;height:2.5px;border-radius:16px 16px 0 0}
.card.cp::after{background:linear-gradient(90deg,#7c3aed,#d946ef)}
.card.cg::after{background:linear-gradient(90deg,#22c55e,#06b6d4)}
.card.cc::after{background:linear-gradient(90deg,#06b6d4,#6366f1)}
.card.cy::after{background:linear-gradient(90deg,#f59e0b,#ec4899)}
.card-ic{width:20px;height:20px;margin-bottom:14px;opacity:0.5}
.card-label{font-size:9.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.13em;margin-bottom:6px}
.card-val{font-size:30px;font-weight:800;line-height:1;font-family:var(--mono)}
.card-val.cp{background:linear-gradient(135deg,#a855f7,#d946ef);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.card-val.cg{color:var(--green)}
.card-val.cc{color:var(--cyan)}
.card-val.cy{color:var(--yellow)}
.card-sub{font-size:11px;color:var(--muted);margin-top:5px}

/* SECTION LABEL */
.sec-label{
  display:flex;align-items:center;gap:9px;
  font-size:10px;font-weight:700;color:var(--muted2);
  text-transform:uppercase;letter-spacing:.14em;margin-bottom:11px;
}
.sec-label .ic{width:15px;height:15px;opacity:0.6}
.sec-label::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--border2),transparent)}

/* PANEL */
.panel{
  background:var(--s1);border:1px solid var(--border);
  border-radius:16px;overflow:hidden;
  box-shadow:0 4px 32px #00000040;margin-bottom:24px;
}

/* TABLE */
table{width:100%;border-collapse:collapse}
th{
  padding:11px 16px;text-align:left;
  font-size:10px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.1em;
  background:var(--s2);border-bottom:1px solid var(--border);
}
td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff03}
.td-icon{width:36px;padding-right:0;opacity:0.3}
.td-icon .ic{width:14px;height:14px}
.tid{font-family:var(--mono);font-size:12px;color:var(--muted2)}
.mono{font-family:var(--mono)}
.empty-row{color:var(--muted);text-align:center;padding:28px 16px;font-size:13px}
.empty-row code{
  background:var(--s3);border:1px solid var(--border2);
  border-radius:5px;padding:1px 7px;
  font-family:var(--mono);font-size:12px;color:var(--accent2);
}

/* PILLS */
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:600}
.pill .ic{width:11px;height:11px}
.pill-active{background:#16a34a22;color:var(--green);border:1px solid #16a34a44}
.pill-off{background:#ef444422;color:var(--red);border:1px solid #ef444444}
.pill-muted{background:#eab30822;color:var(--yellow);border:1px solid #eab30844}

/* LOGS */
.log-wrap{max-height:320px;overflow-y:auto;padding:6px 0;scroll-behavior:smooth}
.log-wrap::-webkit-scrollbar{width:4px}
.log-wrap::-webkit-scrollbar-track{background:transparent}
.log-wrap::-webkit-scrollbar-thumb{background:var(--border2);border-radius:99px}
.log-row{display:flex;align-items:flex-start;gap:10px;padding:5px 16px;font-size:12.5px;transition:background 0.1s}
.log-row:hover{background:#ffffff03}
.log-row .ic{width:13px;height:13px;flex-shrink:0;margin-top:3px;opacity:.8}
.lt{color:var(--muted);font-family:var(--mono);font-size:11px;flex-shrink:0;margin-top:1px;min-width:72px}
.lm{color:var(--text);word-break:break-word;opacity:.88}
.log-row.error .ic,.log-row.error .lm{color:var(--red)}
.log-row.warn  .ic,.log-row.warn  .lm{color:var(--yellow)}
.log-row.reply .ic,.log-row.reply .lm{color:var(--fuchsia)}
.log-row.info  .ic{color:var(--cyan)}

/* COMMANDS */
.cmd-cell{font-family:var(--mono);font-size:12px;color:var(--accent2);white-space:nowrap;width:1%;padding-right:6px}
.desc-cell{color:var(--muted2);font-size:12.5px}

/* WORDS MANAGER */
.words-panel{background:var(--s1);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:24px;box-shadow:0 4px 32px #00000040}
.words-header{
  background:var(--s2);border-bottom:1px solid var(--border);
  padding:14px 18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;
}
.words-title{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px}
.words-count{
  background:linear-gradient(135deg,#7c3aed22,#d946ef22);
  border:1px solid #9333ea44;
  color:var(--accent2);font-size:11px;font-weight:700;
  padding:3px 12px;border-radius:999px;
}
.add-form{display:flex;gap:8px;padding:16px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.add-input{
  flex:1;min-width:180px;
  background:var(--s3);border:1.5px solid var(--border2);
  border-radius:10px;padding:9px 14px;
  color:var(--text);font-size:13px;outline:none;
  transition:border-color .2s;font-family:inherit;
}
.add-input:focus{border-color:var(--accent)}
.add-input::placeholder{color:var(--muted)}
.btn-add{
  background:var(--accentG);color:#fff;border:none;
  border-radius:10px;padding:9px 18px;font-size:13px;font-weight:700;
  cursor:pointer;display:flex;align-items:center;gap:6px;
  transition:opacity .15s;box-shadow:0 2px 12px #9333ea44;white-space:nowrap;
}
.btn-add:hover{opacity:.85}
.btn-add .ic{width:14px;height:14px}
.words-list{padding:8px 0;max-height:340px;overflow-y:auto}
.words-list::-webkit-scrollbar{width:4px}
.words-list::-webkit-scrollbar-thumb{background:var(--border2);border-radius:99px}
.word-row{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:8px 18px;border-bottom:1px solid var(--border);transition:background .1s;
}
.word-row:last-child{border-bottom:none}
.word-row:hover{background:#ffffff03}
.word-text{color:var(--text);font-size:13px;word-break:break-word;flex:1}
.btn-del{
  background:#ef444418;color:var(--red);border:1px solid #ef444433;
  border-radius:8px;padding:4px 10px;font-size:11.5px;font-weight:600;
  cursor:pointer;display:flex;align-items:center;gap:5px;
  transition:background .15s;white-space:nowrap;flex-shrink:0;
}
.btn-del:hover{background:#ef444430}
.btn-del .ic{width:13px;height:13px}
.empty-words{color:var(--muted);text-align:center;padding:28px 16px;font-size:13px}

/* SETTINGS */
.settings-panel{background:var(--s1);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:24px;box-shadow:0 4px 32px #00000040}
.settings-header{background:var(--s2);border-bottom:1px solid var(--border);padding:14px 18px;font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px}
.settings-body{padding:18px}
.settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:16px}
.setting-item{display:flex;flex-direction:column;gap:6px}
.setting-label{font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.12em}
.setting-input{background:var(--s3);border:1.5px solid var(--border2);border-radius:10px;padding:9px 14px;color:var(--text);font-size:13px;outline:none;transition:border-color .2s;font-family:inherit;width:100%}
.setting-input:focus{border-color:var(--accent)}
.setting-hint{font-size:11px;color:var(--muted);margin-top:2px}
.btn-save{background:var(--accentG);color:#fff;border:none;border-radius:10px;padding:9px 22px;font-size:13px;font-weight:700;cursor:pointer;transition:opacity .15s;box-shadow:0 2px 12px #9333ea44}
.btn-save:hover{opacity:.85}

/* LAYOUT */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
@media(max-width:640px){
  .two-col{grid-template-columns:1fr}
  body{padding:20px 14px 48px}
  .header{flex-direction:column;align-items:flex-start}
  .cards{grid-template-columns:1fr 1fr}
  .add-form{flex-direction:column}
}

/* FOOTER */
.footer{
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
  border-top:1px solid var(--border);padding-top:18px;margin-top:8px;
  font-size:11.5px;color:var(--muted);
}
.refresh-dot{width:6px;height:6px;border-radius:50%;background:var(--accent2);animation:pulse 2s ease-in-out infinite;flex-shrink:0}
.refresh-row{display:flex;align-items:center;gap:6px}

/* IC */
.ic{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.ic svg{width:100%;height:100%}
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <div class="avatar">${icon("bot",28)}</div>
    <div>
      <div class="bot-name">✦ COZY BOT PANEL</div>
      <div class="bot-sub">Messenger Automation &nbsp;·&nbsp; Dev ID: <span class="mono" style="color:var(--accent2)">${esc(state.developerID||"—")}</span></div>
    </div>
  </div>
  <div class="bot-badges">${botBadges}</div>
</header>

<div class="sep"></div>

<div class="cards">
  <div class="card cp">
    ${icon("zap",20)}
    <div class="card-label">Total Replies</div>
    <div class="card-val cp">${state.totalRepliesSent}</div>
    <div class="card-sub">messages auto-sent</div>
  </div>
  <div class="card cg">
    ${icon("messages",20)}
    <div class="card-label">Active Chats</div>
    <div class="card-val cg">${activeCount}</div>
    <div class="card-sub">auto-reply ON</div>
  </div>
  <div class="card cc">
    ${icon("users",20)}
    <div class="card-label">Total Threads</div>
    <div class="card-val cc">${threads.length}</div>
    <div class="card-sub">${offCount} off · ${mutedCount} muted</div>
  </div>
  <div class="card cy">
    ${icon("clock",20)}
    <div class="card-label">Uptime</div>
    <div class="card-val cy" style="font-size:22px;padding-top:4px">${getUptime()}</div>
    <div class="card-sub">since last restart</div>
  </div>
</div>

<div class="two-col">
  <div>
    <div class="sec-label">${icon("chat",15)} Active Threads</div>
    <div class="panel">
      <table>
        <thead><tr><th style="width:36px"></th><th>Thread ID</th><th>Status</th></tr></thead>
        <tbody>${threadRows}</tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="sec-label">${icon("activity",15)} Live Logs</div>
    <div class="panel">
      <div class="log-wrap">${logRows}</div>
    </div>
  </div>
</div>

<!-- WORDS MANAGER -->
<div class="sec-label">${icon("word",15)} Manage Auto-Reply Words</div>
<div class="words-panel">
  <div class="words-header">
    <div class="words-title">${icon("word",16)} Custom Replies</div>
    <span class="words-count">${customReplies.length} custom · ${customReplies.length + 102} total</span>
  </div>
  <form class="add-form" method="POST" action="/api/replies/add">
    <input class="add-input" type="text" name="word" placeholder="I-type ang bagong auto-reply na gusto mo..." autocomplete="off" required/>
    <button class="btn-add" type="submit">${icon("plus",14)} Add Word</button>
  </form>
  <div class="words-list">${customWordRows}</div>
</div>

<!-- BOT SETTINGS -->
<div class="sec-label">${icon("zap",15)} Bot Settings</div>
<div class="settings-panel">
  <div class="settings-header">${icon("zap",15)} Loop &amp; Reply Configuration</div>
  <div class="settings-body">
    <form method="POST" action="/api/config/save">
      <div class="settings-grid">
        <div class="setting-item">
          <label class="setting-label">Loop React Emoji</label>
          <input class="setting-input" type="text" name="loopReact" value="${esc(botConfig.loopReact||'😆')}" placeholder="e.g. 😂" maxlength="8"/>
          <span class="setting-hint">Emoji na i-re-react sa bawat mensahe</span>
        </div>
        <div class="setting-item">
          <label class="setting-label">Loop Delay (seconds)</label>
          <input class="setting-input" type="number" name="loopDelay" value="${botConfig.loopDelay||5}" min="1" max="60" placeholder="5"/>
          <span class="setting-hint">Oras sa pagitan ng bawat mensahe</span>
        </div>
        <div class="setting-item">
          <label class="setting-label">Image Chance (%)</label>
          <input class="setting-input" type="number" name="imageProbability" value="${botConfig.imageProbability||20}" min="0" max="100" placeholder="20"/>
          <span class="setting-hint">Porsyento na may picture ang isesend</span>
        </div>
      </div>
      <button class="btn-save" type="submit">💾 Save Settings</button>
    </form>
  </div>
</div>

<!-- COMMANDS -->
<div class="sec-label">${icon("terminal",15)} Command Reference</div>
<div class="panel">
  <table>
    <thead><tr><th>Command</th><th>Description</th></tr></thead>
    <tbody>${cmdRows}</tbody>
  </table>
</div>

<div class="footer">
  <span>COZY BOT PANEL &nbsp;·&nbsp; Prefix: <span class="mono">!</span></span>
  <span class="refresh-row"><div class="refresh-dot"></div> auto-refresh every 8s</span>
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
