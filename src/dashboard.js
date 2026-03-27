"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const CUSTOM_REPLIES_FILE = path.join(__dirname, "../data/custom_replies.json");
const BOT_CONFIG_FILE     = path.join(__dirname, "../data/bot_config.json");
const MAX_LOGS = 200;
const logs = [];
const state = {
    bots: [],
    developerID: "",
    autoReplyEnabled: {},
    mutedThreads: {},
    pmLoopActive: {},
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

function buildHTML() {
    const threads     = Object.keys(state.autoReplyEnabled);
    const activeCount = threads.filter(t=>state.autoReplyEnabled[t]).length;
    const offCount    = threads.length - activeCount;
    const mutedCount  = Object.values(state.mutedThreads||{}).filter(Boolean).length;
    const pmLoopCount = Object.values(state.pmLoopActive||{}).filter(Boolean).length;
    const isOnline    = state.loggedIn;
    const isRecon     = state.reconnecting;
    const statusText  = isOnline ? "Online" : (isRecon ? "Reconnecting…" : "Offline");
    const statusColor = isOnline ? "#22c55e" : (isRecon ? "#f59e0b" : "#ef4444");

    const customReplies = readCustomReplies();
    const botConfig     = readBotConfig();

    const botBadges = state.bots.length === 0
        ? `<div class="bot-pill bot-offline"><span class="pill-dot"></span><span class="pill-name">No bots loaded</span></div>`
        : state.bots.map(b => {
            const bc = b.loggedIn ? "#22c55e" : (b.reconnecting ? "#f59e0b" : "#ef4444");
            const bt = b.loggedIn ? "Online" : (b.reconnecting ? `Reconnecting ${b.nextReconnectIn}s` : "Offline");
            const cls = b.loggedIn ? "bot-online" : (b.reconnecting ? "bot-warn" : "bot-offline");
            return `<div class="bot-pill ${cls}"><span class="pill-dot"></span><span class="pill-name">${esc(b.label)}</span><span class="pill-status">${bt}</span></div>`;
        }).join("");

    const threadRows = threads.length === 0
        ? `<tr><td colspan="4" class="empty-cell">No threads yet — send <code>!on</code> in Messenger</td></tr>`
        : threads.map(tid => {
            const on    = state.autoReplyEnabled[tid];
            const muted = state.mutedThreads&&state.mutedThreads[tid];
            const pmL   = state.pmLoopActive&&state.pmLoopActive[tid];
            const label = on ? (muted ? "muted" : "active") : "idle";
            const cls   = on ? (muted ? "badge-warn" : "badge-green") : "badge-red";
            const pmBadge = pmL ? `<span class="badge badge-purple">pm-loop</span>` : "";
            return `<tr>
              <td class="td-mono">${esc(tid)}</td>
              <td><span class="badge ${cls}">${label}</span> ${pmBadge}</td>
              <td class="td-center">${on?"<span class='dot-green'></span>":"<span class='dot-red'></span>"}</td>
              <td class="td-center">${muted?"<span class='dot-yellow'></span>":"—"}</td>
            </tr>`;
        }).join("");

    const logRows = logs.length === 0
        ? `<div class="log-row log-idle"><span class="log-time">--:--:--</span><span class="log-lvl">IDLE</span><span class="log-msg">Waiting for events…</span></div>`
        : logs.map(l => {
            const lv = {error:"ERR",warn:"WARN",reply:"SEND",info:"INFO"}[l.type]||"INFO";
            return `<div class="log-row log-${l.type}"><span class="log-time">${esc(l.time)}</span><span class="log-lvl">${lv}</span><span class="log-msg">${esc(l.message)}</span></div>`;
        }).join("");

    const customWordRows = customReplies.length === 0
        ? `<div class="empty-queue">Queue is empty — add your first message above</div>`
        : customReplies.map((w,i) =>
            `<div class="queue-item">
                <span class="queue-num">${String(i+1).padStart(2,"0")}</span>
                <span class="queue-text">${esc(w)}</span>
                <form method="POST" action="/api/replies/remove" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-danger-sm" type="submit">✕ remove</button>
                </form>
            </div>`
        ).join("");

    const COMMANDS = [
        ["!on / !off",                "Toggle group auto-reply loop"],
        ["!pmloop / !pmstop",         "Start / stop PM loop with deep search quotes"],
        ["!pmstatus",                 "Check PM loop status for this chat"],
        ["!quote [source]",           "Fetch a quote (sources: quotes, wisdom, love, life, motivational, success, bible, tagalog)"],
        ["!mute / !unmute",           "Pause or resume auto-reply"],
        ["!say &lt;text&gt;",         "Bot sends a text message"],
        ["!vm &lt;text&gt;",          "Bot sends a voice message (TTS)"],
        ["!broadcast &lt;text&gt;",   "Send to all active threads"],
        ["!nn &lt;name&gt;",          "Set nickname for all members + lock"],
        ["!cg &lt;name&gt;",          "Change group name + lock it"],
        ["!banner [url]",             "Set group photo + protect it"],
        ["!kick &lt;uid&gt;",         "Kick a member from the group"],
        ["!add &lt;uid&gt;",          "Add a member to the group"],
        ["!emoji &lt;emoji&gt;",      "Change group emoji"],
        ["!color &lt;name&gt;",       "Change chat color theme"],
        ["!seen",                     "Mark all messages as read"],
        ["!spam &lt;n&gt; &lt;msg&gt;","Spam a message n times (max 20)"],
        ["!info",                     "Show group info, members, admins, ID"],
        ["!lock",                     "Show all active protections"],
        ["!freeze / !unfreeze",       "Freeze group — anyone who chats gets kicked"],
        ["!perms &lt;uid&gt; &lt;t&gt;","Grant temp permissions (5min, 1h)"],
        ["!revoke [uid]",             "Revoke temporary permissions"],
        ["!gp &lt;url&gt;",           "Guard profile pic — auto-restore every 5min"],
        ["!gp off",                   "Disable profile guard"],
        ["!antirestrict",             "Alert dev when bot is kicked"],
        ["!antichat",                 "Auto-retry failed sends"],
        ["!count",                    "Count 1 to 20 in chat"],
        ["!id",                       "Get FB ID of replied-to user"],
        ["!test",                     "Ping the bot"],
        ["!status",                   "Show auto-reply + PM loop + freeze status"],
        ["!myid",                     "Show your own Facebook ID"],
        ["!help",                     "Show full command list in Messenger"],
    ];

    const cmdRows = COMMANDS.map(([cmd,desc])=>
        `<tr><td class="cmd-name">${cmd}</td><td class="cmd-desc">${desc}</td></tr>`
    ).join("");

    const QUOTE_SOURCES = ["quotes","wisdom","love","life","motivational","success","friendship","humor","philosophy","books","bible","tagalog"];

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CZB // Control Panel</title>
<meta http-equiv="refresh" content="10"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07080d;
  --bg2:#0c0e16;
  --surface:#111420;
  --surface2:#161927;
  --surface3:#1c2133;
  --border:#232840;
  --border2:#2d3454;
  --border3:#3d4668;
  --text:#e8eaf6;
  --text2:#a8b0d8;
  --text3:#6b74a8;
  --muted:#404870;
  --accent:#6366f1;
  --accent2:#818cf8;
  --accentG:linear-gradient(135deg,#4f46e5,#6366f1,#818cf8);
  --green:#10b981;--green2:#34d399;
  --red:#ef4444;--red2:#f87171;
  --yellow:#f59e0b;--yellow2:#fbbf24;
  --purple:#a855f7;--purple2:#c084fc;
  --blue:#3b82f6;--blue2:#60a5fa;
  --pink:#ec4899;
  --mono:'JetBrains Mono',monospace;
  --sans:'Inter',sans-serif;
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);
  font-family:var(--sans);font-size:13.5px;line-height:1.6;
  min-height:100vh;
  background-image:
    radial-gradient(ellipse 50% 40% at 90% 0%,#6366f10f,transparent),
    radial-gradient(ellipse 40% 30% at 0% 100%,#a855f708,transparent),
    radial-gradient(ellipse 30% 20% at 50% 50%,#3b82f605,transparent);
}

/* ── TOPBAR ─────────────────────────────────── */
.topbar{
  position:sticky;top:0;z-index:100;
  background:rgba(7,8,13,.85);
  backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);
  padding:0 28px;height:52px;
  display:flex;align-items:center;justify-content:space-between;
  gap:16px;
}
.tb-left{display:flex;align-items:center;gap:20px}
.tb-logo{
  display:flex;align-items:center;gap:10px;
  font-family:var(--mono);font-size:14px;font-weight:700;
  letter-spacing:.06em;color:var(--accent2);
}
.tb-logo-dot{
  width:28px;height:28px;border-radius:8px;
  background:var(--accentG);
  display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:800;color:#fff;
  box-shadow:0 0 16px #6366f140;
}
.tb-tag{
  font-family:var(--mono);font-size:9.5px;font-weight:700;
  text-transform:uppercase;letter-spacing:.14em;
  padding:3px 9px;border-radius:5px;
  background:#6366f115;border:1px solid #6366f130;
  color:var(--accent2);
}
.tb-status{
  display:flex;align-items:center;gap:7px;
  font-size:11.5px;color:var(--text3);font-family:var(--mono);
}
.tb-right{display:flex;align-items:center;gap:16px}
.tb-devid{font-family:var(--mono);font-size:11px;color:var(--text3)}
.tb-devid b{color:var(--accent2)}
.sync-wrap{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3);font-family:var(--mono)}
.sync-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 2.4s ease-in-out infinite;box-shadow:0 0 8px var(--green)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.15}}

/* ── LAYOUT ─────────────────────────────────── */
.page{max-width:1280px;margin:0 auto;padding:32px 24px 80px}

/* ── HERO HEADER ─────────────────────────────── */
.hero{
  display:flex;align-items:flex-start;justify-content:space-between;
  gap:20px;flex-wrap:wrap;margin-bottom:36px;
  padding:28px 32px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:16px;
  position:relative;overflow:hidden;
}
.hero::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(135deg,#6366f108 0%,transparent 60%);
  pointer-events:none;
}
.hero::after{
  content:'';position:absolute;top:-60px;right:-60px;
  width:200px;height:200px;border-radius:50%;
  background:radial-gradient(circle,#6366f118,transparent 70%);
  pointer-events:none;
}
.hero-left{display:flex;align-items:center;gap:18px}
.hero-icon{
  width:56px;height:56px;border-radius:14px;
  background:var(--accentG);
  display:flex;align-items:center;justify-content:center;
  font-size:24px;
  box-shadow:0 0 32px #6366f150,0 8px 24px #0006;
  flex-shrink:0;
}
.hero-title{font-size:22px;font-weight:800;color:var(--text);letter-spacing:-.02em;line-height:1.1}
.hero-sub{font-size:12px;color:var(--text3);margin-top:4px;font-family:var(--mono)}
.hero-bots{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.bot-pill{
  display:inline-flex;align-items:center;gap:8px;
  padding:6px 14px;border-radius:8px;
  font-size:11.5px;font-family:var(--mono);font-weight:500;
  border:1px solid var(--border2);background:var(--surface2);
}
.bot-online{border-color:#10b98130;color:var(--green2)}
.bot-warn{border-color:#f59e0b30;color:var(--yellow2)}
.bot-offline{border-color:var(--border2);color:var(--text3)}
.pill-dot{
  width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0;
  animation:pillPulse 2.4s ease-in-out infinite;
}
.bot-offline .pill-dot{animation:none;opacity:.4}
@keyframes pillPulse{0%,100%{opacity:1}50%{opacity:.3}}
.pill-name{font-weight:600;color:var(--text)}
.pill-status{opacity:.6;font-size:10.5px}

/* ── STAT CARDS ─────────────────────────────── */
.stats{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:12px;margin-bottom:28px;
}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:560px){.stats{grid-template-columns:1fr 1fr}}
.stat-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:12px;padding:18px 18px 14px;
  position:relative;overflow:hidden;
  transition:border-color .2s,transform .2s;cursor:default;
}
.stat-card:hover{border-color:var(--border3);transform:translateY(-1px)}
.stat-top{position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
.s-indigo{background:linear-gradient(90deg,#4338ca,#818cf8)}
.s-emerald{background:linear-gradient(90deg,#059669,#34d399)}
.s-purple{background:linear-gradient(90deg,#7c3aed,#c084fc)}
.s-amber{background:linear-gradient(90deg,#d97706,#fbbf24)}
.s-rose{background:linear-gradient(90deg,#be123c,#fb7185)}
.stat-label{font-size:9.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.14em;margin-bottom:10px}
.stat-val{font-size:30px;font-weight:800;line-height:1;font-family:var(--mono)}
.c-indigo{color:var(--accent2)}
.c-emerald{color:var(--green2)}
.c-purple{color:var(--purple2)}
.c-amber{color:var(--yellow2)}
.c-rose{color:var(--red2)}
.stat-sub{font-size:10.5px;color:var(--text3);margin-top:6px}

/* ── SECTION LABEL ──────────────────────────── */
.sec-label{
  display:flex;align-items:center;gap:10px;
  font-size:10px;font-weight:700;color:var(--text3);
  text-transform:uppercase;letter-spacing:.18em;
  margin-bottom:12px;
}
.sec-label::after{content:'';flex:1;height:1px;background:var(--border)}
.sec-icon{font-size:12px;opacity:.6}

/* ── PANEL ──────────────────────────────────── */
.panel{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:12px;overflow:hidden;margin-bottom:20px;
}
.panel-head{
  background:var(--surface2);
  border-bottom:1px solid var(--border);
  padding:12px 18px;
  display:flex;align-items:center;justify-content:space-between;
  gap:10px;
}
.ph-left{display:flex;align-items:center;gap:10px}
.ph-badge{
  font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  padding:3px 9px;border-radius:5px;
  background:#6366f115;border:1px solid #6366f128;color:var(--accent2);
}
.ph-badge-green{background:#10b98115;border-color:#10b98128;color:var(--green2)}
.ph-badge-purple{background:#a855f715;border-color:#a855f728;color:var(--purple2)}
.ph-title{font-size:11.5px;font-weight:600;color:var(--text2)}
.ph-meta{font-size:10.5px;color:var(--text3);font-family:var(--mono)}

/* ── TABLE ──────────────────────────────────── */
table{width:100%;border-collapse:collapse}
th{
  padding:10px 16px;text-align:left;
  font-size:9px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.13em;
  background:var(--surface2);border-bottom:1px solid var(--border);
}
td{padding:10px 16px;border-bottom:1px solid var(--border);font-size:12.5px;vertical-align:middle;color:var(--text2)}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff03}
.td-mono{font-family:var(--mono);font-size:11.5px;color:var(--text3)}
.td-center{text-align:center}
.empty-cell{text-align:center;color:var(--text3);padding:28px;font-size:12.5px}
.empty-cell code{background:var(--surface2);border:1px solid var(--border2);border-radius:5px;padding:1px 7px;font-family:var(--mono);color:var(--accent2);font-size:11.5px}

/* ── BADGES ─────────────────────────────────── */
.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:5px;font-size:10.5px;font-weight:600;font-family:var(--mono);white-space:nowrap}
.badge-green{background:#10b98118;color:var(--green2);border:1px solid #10b98128}
.badge-red{background:#ef444418;color:var(--red2);border:1px solid #ef444428}
.badge-warn{background:#f59e0b18;color:var(--yellow2);border:1px solid #f59e0b28}
.badge-purple{background:#a855f718;color:var(--purple2);border:1px solid #a855f728}
.badge-blue{background:#3b82f618;color:var(--blue2);border:1px solid #3b82f628}
.dot-green,.dot-red,.dot-yellow{display:inline-block;width:8px;height:8px;border-radius:50%}
.dot-green{background:var(--green);box-shadow:0 0 6px var(--green)}
.dot-red{background:var(--red);opacity:.7}
.dot-yellow{background:var(--yellow)}

/* ── LOG TERMINAL ────────────────────────────── */
.log-wrap{
  max-height:340px;overflow-y:auto;
  background:var(--bg);padding:4px 0;
  font-family:var(--mono);font-size:11.5px;
  scroll-behavior:smooth;
}
.log-wrap::-webkit-scrollbar{width:3px}
.log-wrap::-webkit-scrollbar-thumb{background:var(--border3);border-radius:99px}
.log-row{display:flex;align-items:flex-start;gap:14px;padding:4px 18px;line-height:1.55;transition:background .1s}
.log-row:hover{background:#ffffff02}
.log-time{color:var(--muted);font-size:10px;flex-shrink:0;min-width:68px;padding-top:1px}
.log-lvl{font-size:9.5px;font-weight:700;flex-shrink:0;min-width:38px;padding-top:2px;text-transform:uppercase;letter-spacing:.06em}
.log-msg{color:var(--text3);word-break:break-word;flex:1}
.log-error .log-lvl{color:var(--red2)}.log-error .log-msg{color:#fca5a5}
.log-warn  .log-lvl{color:var(--yellow2)}.log-warn  .log-msg{color:#fde68a}
.log-reply .log-lvl{color:var(--green2)}.log-reply .log-msg{color:#6ee7b7}
.log-info  .log-lvl{color:var(--accent2)}.log-info  .log-msg{color:var(--text3)}
.log-idle  .log-lvl{color:var(--muted)}.log-idle  .log-msg{color:var(--muted)}

/* ── TWO COL ─────────────────────────────────── */
.two-col{display:grid;grid-template-columns:1.1fr 1fr;gap:18px;margin-bottom:20px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;margin-bottom:20px}
@media(max-width:900px){.two-col,.three-col{grid-template-columns:1fr}}
@media(max-width:680px){.page{padding:20px 14px 60px}}

/* ── INPUT + FORMS ───────────────────────────── */
.input-row{display:flex;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center}
.input-field{
  flex:1;min-width:200px;
  background:var(--bg2);border:1px solid var(--border2);
  border-radius:8px;padding:9px 14px;
  color:var(--text);font-size:13px;outline:none;
  transition:border-color .2s,box-shadow .2s;
  font-family:var(--mono);
}
.input-field:focus{border-color:var(--accent);box-shadow:0 0 0 3px #6366f115}
.input-field::placeholder{color:var(--muted)}
.btn-primary{
  background:var(--accentG);color:#fff;border:none;
  border-radius:8px;padding:9px 20px;font-size:12px;font-weight:600;
  cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  transition:opacity .15s,transform .15s;font-family:var(--sans);
  white-space:nowrap;letter-spacing:.02em;
}
.btn-primary:hover{opacity:.88;transform:translateY(-1px)}
.btn-save{
  background:linear-gradient(135deg,#2563eb,#3b82f6);color:#fff;border:none;
  border-radius:8px;padding:9px 22px;font-size:12px;font-weight:600;
  cursor:pointer;transition:opacity .15s;font-family:var(--sans);
  letter-spacing:.02em;
}
.btn-save:hover{opacity:.88}
.btn-danger-sm{
  background:#ef444415;color:var(--red2);border:1px solid #ef444428;
  border-radius:6px;padding:4px 11px;font-size:11px;font-weight:600;
  cursor:pointer;transition:background .15s;white-space:nowrap;font-family:var(--sans);
}
.btn-danger-sm:hover{background:#ef444425}

/* ── QUEUE LIST ──────────────────────────────── */
.queue-list{padding:4px 0;max-height:340px;overflow-y:auto}
.queue-list::-webkit-scrollbar{width:3px}
.queue-list::-webkit-scrollbar-thumb{background:var(--border3);border-radius:99px}
.queue-item{
  display:flex;align-items:center;gap:12px;
  padding:8px 18px;border-bottom:1px solid var(--border);
  transition:background .1s;
}
.queue-item:last-child{border-bottom:none}
.queue-item:hover{background:#ffffff02}
.queue-num{font-size:10px;color:var(--muted);min-width:26px;font-family:var(--mono)}
.queue-text{color:var(--text2);font-size:12.5px;word-break:break-word;flex:1;font-family:var(--mono)}
.empty-queue{color:var(--text3);text-align:center;padding:28px;font-size:12.5px}

/* ── CONFIG GRID ─────────────────────────────── */
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;padding:18px;border-bottom:1px solid var(--border)}
.cfg-grid-2{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.cfg-group{
  padding:18px;border-bottom:1px solid var(--border);
}
.cfg-group-title{
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;
  color:var(--accent2);margin-bottom:14px;display:flex;align-items:center;gap:8px;
}
.cfg-group-title::after{content:'';flex:1;height:1px;background:var(--border)}
.cfg-field{display:flex;flex-direction:column;gap:6px}
.cfg-label{font-size:9.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.12em}
.cfg-input{
  background:var(--bg2);border:1px solid var(--border2);
  border-radius:7px;padding:8px 13px;color:var(--text);
  font-size:12.5px;outline:none;transition:border-color .2s,box-shadow .2s;
  font-family:var(--mono);width:100%;
}
.cfg-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px #6366f115}
.cfg-select{
  background:var(--bg2);border:1px solid var(--border2);
  border-radius:7px;padding:8px 13px;color:var(--text);
  font-size:12.5px;outline:none;transition:border-color .2s;
  font-family:var(--mono);width:100%;cursor:pointer;
  appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b74a8' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;
  padding-right:34px;
}
.cfg-select:focus{border-color:var(--accent)}
.cfg-hint{font-size:10.5px;color:var(--muted);line-height:1.4;margin-top:2px}
.cfg-checkbox-row{display:flex;align-items:center;gap:10px;padding:4px 0}
.cfg-checkbox{
  width:36px;height:20px;border-radius:10px;cursor:pointer;
  background:var(--border2);border:none;outline:none;
  position:relative;appearance:none;transition:background .2s;flex-shrink:0;
}
.cfg-checkbox:checked{background:var(--accent)}
.cfg-checkbox::after{
  content:'';position:absolute;top:3px;left:3px;
  width:14px;height:14px;border-radius:50%;
  background:#fff;transition:transform .2s;
}
.cfg-checkbox:checked::after{transform:translateX(16px)}
.cfg-check-label{font-size:12px;color:var(--text2);cursor:pointer}
.cfg-footer{
  padding:14px 18px;
  display:flex;align-items:center;justify-content:space-between;
  flex-wrap:wrap;gap:10px;
}
.cfg-note{font-size:11px;color:var(--text3)}
.cfg-note b{color:var(--text2)}

/* ── COMMANDS ─────────────────────────────────── */
.cmd-name{font-family:var(--mono);font-size:11.5px;color:var(--accent2);white-space:nowrap;width:1%}
.cmd-desc{color:var(--text3);font-size:12.5px}

/* ── FOOTER ──────────────────────────────────── */
.page-footer{
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
  border-top:1px solid var(--border);padding-top:18px;margin-top:12px;
  font-size:11px;color:var(--muted);font-family:var(--mono);
}
.footer-r{display:flex;align-items:center;gap:7px}
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <div class="tb-left">
    <div class="tb-logo">
      <div class="tb-logo-dot">C</div>
      CZB<span style="opacity:.4">::</span>panel
    </div>
    <span class="tb-tag">v2.0</span>
    <div class="tb-status">
      <span style="width:7px;height:7px;border-radius:50%;background:${statusColor};display:inline-block;box-shadow:0 0 8px ${statusColor}"></span>
      ${statusText}
    </div>
  </div>
  <div class="tb-right">
    <div class="tb-devid">dev <b>${esc(state.developerID||"—")}</b></div>
    <div class="sync-wrap"><div class="sync-dot"></div>live · 10s</div>
  </div>
</div>

<div class="page">

<!-- HERO -->
<div class="hero">
  <div>
    <div class="hero-left">
      <div class="hero-icon">🤖</div>
      <div>
        <div class="hero-title">Messenger Bot Control Panel</div>
        <div class="hero-sub">loop engine · pm-loop · deep search · group protection · tts module</div>
      </div>
    </div>
    <div class="hero-bots">${botBadges}</div>
  </div>
  <div style="text-align:right;font-family:var(--mono);font-size:11px;color:var(--text3);line-height:2">
    <div>replies sent <span style="color:var(--accent2);font-weight:700;font-size:16px">${state.totalRepliesSent}</span></div>
    <div>uptime <span style="color:var(--green2);font-weight:700">${getUptime()}</span></div>
  </div>
</div>

<!-- STATS -->
<div class="stats">
  <div class="stat-card">
    <div class="stat-top s-indigo"></div>
    <div class="stat-label">Messages Sent</div>
    <div class="stat-val c-indigo">${state.totalRepliesSent}</div>
    <div class="stat-sub">total dispatches</div>
  </div>
  <div class="stat-card">
    <div class="stat-top s-emerald"></div>
    <div class="stat-label">Active Loops</div>
    <div class="stat-val c-emerald">${activeCount}</div>
    <div class="stat-sub">threads running</div>
  </div>
  <div class="stat-card">
    <div class="stat-top s-purple"></div>
    <div class="stat-label">PM Loops</div>
    <div class="stat-val c-purple">${pmLoopCount}</div>
    <div class="stat-sub">deep search active</div>
  </div>
  <div class="stat-card">
    <div class="stat-top s-amber"></div>
    <div class="stat-label">Total Threads</div>
    <div class="stat-val c-amber">${threads.length}</div>
    <div class="stat-sub">${offCount} idle · ${mutedCount} muted</div>
  </div>
  <div class="stat-card">
    <div class="stat-top s-rose"></div>
    <div class="stat-label">Uptime</div>
    <div class="stat-val c-rose" style="font-size:${getUptime().length>6?'18':'28'}px;padding-top:4px">${getUptime()}</div>
    <div class="stat-sub">since boot</div>
  </div>
</div>

<!-- THREADS + LOGS -->
<div class="two-col">
  <div>
    <div class="sec-label"><span class="sec-icon">📡</span> Thread Registry</div>
    <div class="panel">
      <div class="panel-head">
        <div class="ph-left"><span class="ph-badge ph-badge-green">LIVE</span><span class="ph-title">Active Threads</span></div>
        <span class="ph-meta">${threads.length} total</span>
      </div>
      <table>
        <thead><tr><th>Thread ID</th><th>State</th><th style="text-align:center">Active</th><th style="text-align:center">Muted</th></tr></thead>
        <tbody>${threadRows}</tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="sec-label"><span class="sec-icon">🖥</span> System Log</div>
    <div class="panel">
      <div class="panel-head">
        <div class="ph-left"><span class="ph-badge">STREAM</span><span class="ph-title">Event Output</span></div>
        <span class="ph-meta">${logs.length} entries</span>
      </div>
      <div class="log-wrap">${logRows}</div>
    </div>
  </div>
</div>

<!-- MESSAGE QUEUE -->
<div class="sec-label"><span class="sec-icon">💬</span> Loop Message Queue</div>
<div class="panel">
  <div class="panel-head">
    <div class="ph-left"><span class="ph-badge">QUEUE</span><span class="ph-title">Custom Reply Pool</span></div>
    <span class="ph-meta" style="color:var(--accent2);font-weight:600">${customReplies.length} custom · ${customReplies.length + 102} total</span>
  </div>
  <form class="input-row" method="POST" action="/api/replies/add">
    <input class="input-field" type="text" name="word" placeholder="Add new message to the loop queue…" autocomplete="off" required/>
    <button class="btn-primary" type="submit">＋ Push to Queue</button>
  </form>
  <div class="queue-list">${customWordRows}</div>
</div>

<!-- LOOP SETTINGS -->
<div class="sec-label"><span class="sec-icon">⚙️</span> Runtime Configuration</div>
<div class="panel">
  <div class="panel-head">
    <div class="ph-left"><span class="ph-badge">CONFIG</span><span class="ph-title">Loop Engine</span></div>
    <span class="ph-meta">writes to /data/bot_config.json</span>
  </div>
  <form method="POST" action="/api/config/save">

    <div class="cfg-group">
      <div class="cfg-group-title">Group Loop Settings</div>
      <div class="cfg-grid">
        <div class="cfg-field">
          <label class="cfg-label">Loop Reaction</label>
          <input class="cfg-input" type="text" name="loopReact" value="${esc(botConfig.loopReact||'😆')}" maxlength="8"/>
          <span class="cfg-hint">Emoji reacted to each sent message</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Loop Delay (seconds)</label>
          <input class="cfg-input" type="number" name="loopDelay" value="${botConfig.loopDelay||5}" min="1" max="300"/>
          <span class="cfg-hint">Interval between each dispatch</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Image Chance (%)</label>
          <input class="cfg-input" type="number" name="imageProbability" value="${botConfig.imageProbability||20}" min="0" max="100"/>
          <span class="cfg-hint">Probability of sending an image</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Loop Mode</label>
          <select class="cfg-select" name="loopMode">
            <option value="sequential" ${botConfig.loopMode==="sequential"?"selected":""}>Sequential</option>
            <option value="shuffle" ${botConfig.loopMode==="shuffle"?"selected":""}>Shuffle</option>
          </select>
          <span class="cfg-hint">Message selection order</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Max Loop Count</label>
          <input class="cfg-input" type="number" name="maxLoopCount" value="${botConfig.maxLoopCount||0}" min="0"/>
          <span class="cfg-hint">0 = unlimited</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Auto-Stop (minutes)</label>
          <input class="cfg-input" type="number" name="autoStopMinutes" value="${botConfig.autoStopMinutes||0}" min="0"/>
          <span class="cfg-hint">Auto-stop loop after N minutes (0 = disabled)</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Start Message</label>
          <input class="cfg-input" type="text" name="loopStartMsg" value="${esc(botConfig.loopStartMsg||'')}" placeholder="Message sent when loop starts"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Stop Message</label>
          <input class="cfg-input" type="text" name="loopStopMsg" value="${esc(botConfig.loopStopMsg||'')}" placeholder="Message sent when loop stops"/>
        </div>
      </div>
      <div style="padding:8px 18px 16px;display:flex;gap:20px;flex-wrap:wrap">
        <div class="cfg-checkbox-row">
          <input class="cfg-checkbox" type="checkbox" id="reactOnly" name="reactOnlyMode" value="1" ${botConfig.reactOnlyMode?"checked":""}>
          <label class="cfg-check-label" for="reactOnly">React-only mode (no images)</label>
        </div>
      </div>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title">PM Loop + Deep Search</div>
      <div class="cfg-grid cfg-grid-2">
        <div class="cfg-field">
          <label class="cfg-label">PM Loop Reaction</label>
          <input class="cfg-input" type="text" name="pmLoopReact" value="${esc(botConfig.pmLoopReact||'❤️')}" maxlength="8"/>
          <span class="cfg-hint">Emoji reacted to each PM loop message</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">PM Loop Delay (seconds)</label>
          <input class="cfg-input" type="number" name="pmLoopDelay" value="${botConfig.pmLoopDelay||10}" min="3" max="300"/>
          <span class="cfg-hint">Interval between PM loop messages</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">PM Loop Mode</label>
          <select class="cfg-select" name="pmLoopMode">
            <option value="shuffle" ${botConfig.pmLoopMode==="shuffle"?"selected":""}>Shuffle</option>
            <option value="sequential" ${botConfig.pmLoopMode==="sequential"?"selected":""}>Sequential</option>
          </select>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Search Source</label>
          <select class="cfg-select" name="pmSearchSource">
            ${QUOTE_SOURCES.map(s=>`<option value="${s}" ${botConfig.pmSearchSource===s?"selected":""}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join("")}
          </select>
          <span class="cfg-hint">Where to fetch deep search quotes</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Search Category</label>
          <select class="cfg-select" name="pmSearchCategory">
            ${["inspirational","wisdom","love","life","motivational","success","friendship","humor","philosophy","literature"].map(c=>`<option value="${c}" ${botConfig.pmSearchCategory===c?"selected":""}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`).join("")}
          </select>
          <span class="cfg-hint">Topic/category for the quote API</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Message Prefix</label>
          <input class="cfg-input" type="text" name="pmSearchPrefix" value="${esc(botConfig.pmSearchPrefix||'')}" placeholder="e.g. 💌 Good morning!"/>
          <span class="cfg-hint">Text added before each quote</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Message Suffix</label>
          <input class="cfg-input" type="text" name="pmSearchSuffix" value="${esc(botConfig.pmSearchSuffix||'')}" placeholder="e.g. — have a great day! 🌸"/>
          <span class="cfg-hint">Text added after each quote</span>
        </div>
      </div>
      <div style="padding:8px 18px 16px;display:flex;gap:24px;flex-wrap:wrap">
        <div class="cfg-checkbox-row">
          <input class="cfg-checkbox" type="checkbox" id="searchEnabled" name="pmSearchEnabled" value="1" ${botConfig.pmSearchEnabled?"checked":""}>
          <label class="cfg-check-label" for="searchEnabled">Enable deep search quotes for PM loop</label>
        </div>
        <div class="cfg-checkbox-row">
          <input class="cfg-checkbox" type="checkbox" id="typingSimulate" name="typingSimulate" value="1" ${botConfig.typingSimulate?"checked":""}>
          <label class="cfg-check-label" for="typingSimulate">Simulate typing before sending</label>
        </div>
      </div>
    </div>

    <div class="cfg-group">
      <div class="cfg-group-title">General Settings</div>
      <div class="cfg-grid">
        <div class="cfg-field">
          <label class="cfg-label">TTS Language</label>
          <select class="cfg-select" name="ttsLang">
            ${[["tl","Tagalog"],["en","English"],["ja","Japanese"],["ko","Korean"],["zh","Chinese"],["es","Spanish"],["fr","French"],["de","German"]].map(([v,n])=>`<option value="${v}" ${botConfig.ttsLang===v?"selected":""}>${n} (${v})</option>`).join("")}
          </select>
          <span class="cfg-hint">Language for !vm voice messages</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Welcome Message</label>
          <input class="cfg-input" type="text" name="greetMsg" value="${esc(botConfig.greetMsg||'Welcome! 👋')}" placeholder="Welcome message for new members"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Anti-Spam Max Msgs</label>
          <input class="cfg-input" type="number" name="antiSpamMaxMsg" value="${botConfig.antiSpamMaxMsg||5}" min="2" max="50"/>
          <span class="cfg-hint">Messages before kick</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Anti-Spam Window (s)</label>
          <input class="cfg-input" type="number" name="antiSpamWindowSec" value="${botConfig.antiSpamWindowSec||10}" min="3" max="120"/>
          <span class="cfg-hint">Time window for spam detection</span>
        </div>
      </div>
      <div style="padding:8px 18px 16px;display:flex;gap:24px;flex-wrap:wrap">
        <div class="cfg-checkbox-row">
          <input class="cfg-checkbox" type="checkbox" id="greetNew" name="greetNewMembers" value="1" ${botConfig.greetNewMembers?"checked":""}>
          <label class="cfg-check-label" for="greetNew">Greet new group members</label>
        </div>
        <div class="cfg-checkbox-row">
          <input class="cfg-checkbox" type="checkbox" id="antiSpam" name="antiSpamEnabled" value="1" ${botConfig.antiSpamEnabled?"checked":""}>
          <label class="cfg-check-label" for="antiSpam">Enable anti-spam (auto-kick spammers)</label>
        </div>
        <div class="cfg-checkbox-row">
          <input class="cfg-checkbox" type="checkbox" id="autoSeen" name="autoSeenEnabled" value="1" ${botConfig.autoSeenEnabled?"checked":""}>
          <label class="cfg-check-label" for="autoSeen">Auto mark messages as seen</label>
        </div>
      </div>
    </div>

    <div class="cfg-footer">
      <span class="cfg-note">Trigger: <b>.</b> to toggle loop · <b>!pmloop</b> for PM loop · <b>!quote</b> for on-demand search</span>
      <button class="btn-save" type="submit">▶ Apply Configuration</button>
    </div>
  </form>
</div>

<!-- COMMAND REFERENCE -->
<div class="sec-label"><span class="sec-icon">📟</span> Command Reference</div>
<div class="panel">
  <div class="panel-head">
    <div class="ph-left"><span class="ph-badge ph-badge-purple">DOCS</span><span class="ph-title">Available Commands</span></div>
    <span class="ph-meta">prefix: <span style="color:var(--accent2);font-weight:700">!</span></span>
  </div>
  <table>
    <thead><tr><th style="width:220px">Command</th><th>Description</th></tr></thead>
    <tbody>${cmdRows}</tbody>
  </table>
</div>

<!-- FOOTER -->
<div class="page-footer">
  <span>czb::panel v2.0 &nbsp;·&nbsp; node.js &nbsp;·&nbsp; ws3-fca &nbsp;·&nbsp; prefix <span style="color:var(--accent2)">!</span></span>
  <div class="footer-r"><div class="sync-dot"></div><span>auto-refresh every 10s</span></div>
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
            if (req.url === "/api/state" && req.method === "GET") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ logs, state }));
                return;
            }

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

            if (req.url === "/api/config/save" && req.method === "POST") {
                const params = await parseBody(req);
                const cfg = readBotConfig();
                if (params.loopReact !== undefined)        cfg.loopReact          = params.loopReact.trim() || "😆";
                if (params.loopDelay !== undefined)        cfg.loopDelay          = Math.max(1, parseInt(params.loopDelay) || 5);
                if (params.imageProbability !== undefined) cfg.imageProbability   = Math.min(100, Math.max(0, parseInt(params.imageProbability) || 20));
                if (params.loopMode !== undefined)         cfg.loopMode           = ["sequential","shuffle"].includes(params.loopMode) ? params.loopMode : "sequential";
                if (params.loopStartMsg !== undefined)     cfg.loopStartMsg       = params.loopStartMsg.trim();
                if (params.loopStopMsg !== undefined)      cfg.loopStopMsg        = params.loopStopMsg.trim();
                if (params.maxLoopCount !== undefined)     cfg.maxLoopCount       = Math.max(0, parseInt(params.maxLoopCount) || 0);
                if (params.autoStopMinutes !== undefined)  cfg.autoStopMinutes    = Math.max(0, parseInt(params.autoStopMinutes) || 0);
                if (params.ttsLang !== undefined)          cfg.ttsLang            = params.ttsLang.trim() || "tl";
                cfg.reactOnlyMode  = params.reactOnlyMode === "1";

                // PM loop
                if (params.pmLoopReact !== undefined)      cfg.pmLoopReact        = params.pmLoopReact.trim() || "❤️";
                if (params.pmLoopDelay !== undefined)      cfg.pmLoopDelay        = Math.max(3, parseInt(params.pmLoopDelay) || 10);
                if (params.pmLoopMode !== undefined)       cfg.pmLoopMode         = ["sequential","shuffle"].includes(params.pmLoopMode) ? params.pmLoopMode : "shuffle";
                cfg.pmSearchEnabled = params.pmSearchEnabled === "1";
                if (params.pmSearchSource !== undefined)   cfg.pmSearchSource     = params.pmSearchSource.trim() || "quotes";
                if (params.pmSearchCategory !== undefined) cfg.pmSearchCategory   = params.pmSearchCategory.trim() || "inspirational";
                if (params.pmSearchPrefix !== undefined)   cfg.pmSearchPrefix     = params.pmSearchPrefix.trim();
                if (params.pmSearchSuffix !== undefined)   cfg.pmSearchSuffix     = params.pmSearchSuffix.trim();
                cfg.typingSimulate = params.typingSimulate === "1";

                // General
                cfg.greetNewMembers  = params.greetNewMembers === "1";
                if (params.greetMsg !== undefined)         cfg.greetMsg           = params.greetMsg.trim() || "Welcome! 👋";
                cfg.antiSpamEnabled  = params.antiSpamEnabled === "1";
                if (params.antiSpamMaxMsg !== undefined)   cfg.antiSpamMaxMsg     = Math.max(2, parseInt(params.antiSpamMaxMsg) || 5);
                if (params.antiSpamWindowSec !== undefined) cfg.antiSpamWindowSec = Math.max(3, parseInt(params.antiSpamWindowSec) || 10);
                cfg.autoSeenEnabled  = params.autoSeenEnabled === "1";

                writeBotConfig(cfg);
                res.writeHead(302, { Location: "/" });
                res.end();
                return;
            }

            if (req.url === "/api/replies/remove" && req.method === "POST") {
                const params = await parseBody(req);
                const idx = parseInt(params.index);
                if (!isNaN(idx)) {
                    const arr = readCustomReplies();
                    if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
                    writeCustomReplies(arr);
                }
                res.writeHead(302, { Location: "/" });
                res.end();
                return;
            }

            let html;
            try { html = buildHTML(); }
            catch (e) {
                html = `<!DOCTYPE html><html><body style="background:#07080d;color:#ef4444;font-family:monospace;padding:40px">
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
