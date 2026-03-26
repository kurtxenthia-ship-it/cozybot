const http = require("http");

const MAX_LOGS = 150;
const logs = [];
const state = {
    bots: [],           // [{ label, loggedIn, reconnecting, nextReconnectIn }]
    developerID: "",
    autoReplyEnabled: {},
    mutedThreads: {},
    totalRepliesSent: 0,
    nicknameMap: {},
    startedAt: new Date(),
    antiRestrict: false,
    antiChat: {},
    get loggedIn() { return this.bots.some(b => b.loggedIn); },
    get reconnecting() { return !this.loggedIn && this.bots.some(b => b.reconnecting); },
};

function addLog(type, message) {
    const entry = { time: new Date().toLocaleTimeString(), type, message };
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.pop();
}

function getUptime() {
    const ms = Date.now() - state.startedAt.getTime();
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ── SVG ICON LIBRARY ──────────────────────────────────────────────────────────
const IC = {
    bot:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2.5"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/></svg>`,
    messages: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    users:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    clock:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    zap:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    shield:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    chat:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    check:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    x:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warn:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    err:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    reply:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`,
    mute:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    wifi:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`,
};

function icon(name, size = 16) {
    return `<span class="ic" style="width:${size}px;height:${size}px">${IC[name] || ""}</span>`;
}

function buildHTML() {
    const threads = Object.keys(state.autoReplyEnabled);
    const activeCount = threads.filter(t => state.autoReplyEnabled[t]).length;
    const offCount    = threads.length - activeCount;
    const mutedCount  = Object.values(state.mutedThreads || {}).filter(Boolean).length;

    const isOnline      = state.loggedIn;
    const isReconnecting = state.reconnecting;
    const statusText    = isOnline ? "Online" : (isReconnecting ? "Reconnecting..." : "Offline");
    const statusColor   = isOnline ? "#22c55e" : (isReconnecting ? "#f59e0b" : "#ef4444");
    const statusClass   = isOnline ? "online" : (isReconnecting ? "reconnecting" : "offline");

    // Per-bot status badges
    const botStatusBadges = state.bots.length === 0
        ? `<div class="bot-status-row"><span class="bot-pill bot-pill-offline"><div class="dot"></div>No bots loaded</span></div>`
        : state.bots.map(b => {
            const bc = b.loggedIn ? "#22c55e" : (b.reconnecting ? "#f59e0b" : "#ef4444");
            const btext = b.loggedIn ? "Online" : (b.reconnecting ? `Reconnecting ${b.nextReconnectIn}s` : "Offline");
            const pulse = b.loggedIn ? `box-shadow:0 0 8px ${bc}cc,0 0 16px ${bc}66;animation:pulse 2.4s ease-in-out infinite;` : (b.reconnecting ? `animation:pulse 0.9s ease-in-out infinite;` : "");
            return `<div class="bot-pill-wrap"><span class="bot-pill" style="color:${bc}">` +
                `<div class="dot" style="background:${bc};${pulse}"></div>` +
                `<span class="bot-pill-label">${escapeHtml(b.label)}</span>` +
                `<span style="opacity:0.6;font-size:11px">${btext}</span>` +
                `</span></div>`;
        }).join("");

    // Thread rows
    const threadRows = threads.length === 0
        ? `<tr><td colspan="3" class="empty-row">No chats yet — type <code>!on</code> in Messenger</td></tr>`
        : threads.map(tid => {
            const on    = state.autoReplyEnabled[tid];
            const muted = state.mutedThreads && state.mutedThreads[tid];
            const label = on ? (muted ? "Muted" : "Active") : "Off";
            const cls   = on ? (muted ? "muted" : "active") : "off";
            return `<tr>
                <td class="td-icon">${icon("chat", 14)}</td>
                <td class="tid mono">${escapeHtml(tid)}</td>
                <td><span class="pill pill-${cls}">${icon(muted ? "mute" : (on ? "check" : "x"), 11)} ${label}</span></td>
            </tr>`;
        }).join("");

    // Log rows
    const logRows = logs.length === 0
        ? `<div class="log-row info">${icon("info", 13)}<span class="lt">--:--</span><span class="lm">Waiting for events…</span></div>`
        : logs.map(l => {
            const t = l.type;
            const icName = t === "error" ? "err" : t === "warn" ? "warn" : t === "reply" ? "reply" : "info";
            return `<div class="log-row ${t}">${icon(icName, 13)}<span class="lt mono">${escapeHtml(l.time)}</span><span class="lm">${escapeHtml(l.message)}</span></div>`;
        }).join("");

    // Commands table rows
    const COMMANDS = [
        ["!on / !off",            "Toggle auto-reply — works in groups and PMs"],
        ["!mute / !unmute",       "Pause or resume auto-reply without forgetting state"],
        ["!nn &lt;name&gt;",      "Set same nickname for all group members + protection"],
        ["!cg &lt;name&gt;",      "Change group name + restore if anyone changes it"],
        ["!banner [url]",         "Set group photo + protection (locks to that image)"],
        ["!kick &lt;uid&gt;",     "Remove a member from the group"],
        ["!add &lt;uid&gt;",      "Add a member to the group"],
        ["!emoji &lt;emoji&gt;",  "Change the group's reaction emoji"],
        ["!color &lt;name&gt;",   "Change chat color (blue, pink, purple, green…)"],
        ["!seen",                 "Mark all messages in the chat as read"],
        ["!spam &lt;n&gt; &lt;msg&gt;", "Send a message n times (max 20, 500ms apart)"],
        ["!info",                 "Show group name, members, admins, thread ID"],
        ["!lock",                 "Check all active protections for this chat"],
        ["!freeze / !unfreeze",   "Freeze group — anyone who chats gets kicked (dev only)"],
        ["!perms &lt;uid&gt; &lt;time&gt;", "Grant temp command access e.g. 30s, 5min, 1h"],
        ["!revoke [uid]",         "Remove temp permissions (dev only)"],
        ["!gp &lt;url&gt;",       "Guard profile — restores bot's profile pic every 5 min"],
        ["!gp off",               "Disable profile guard"],
        ["!antirestrict",         "Toggle — alert dev if bot gets kicked from a group"],
        ["!antichat",             "Toggle — auto-retry failed message sends (per chat)"],
        ["!count",                "Count 1 to 20 rapidly in the chat"],
        ["!id",                   "Get the Facebook ID of the person you replied to"],
        ["!test",                 "Ping the bot (replies instantly)"],
        ["!status",               "Show auto-reply + freeze status for this chat"],
        ["!myid",                 "Show your own Facebook ID"],
        ["!help",                 "Send full command list inside Messenger"],
    ];

    const cmdRows = COMMANDS.map(([cmd, desc]) =>
        `<tr><td class="cmd-cell mono">${cmd}</td><td class="desc-cell">${desc}</td></tr>`
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>COZY BOT PANEL</title>
<meta http-equiv="refresh" content="5"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:      #070b14;
  --s1:      #0c1220;
  --s2:      #101828;
  --s3:      #162032;
  --border:  #1c2a40;
  --border2: #243348;
  --text:    #e2e8f4;
  --muted:   #4a5878;
  --muted2:  #7a8fae;
  --accent:  #2563eb;
  --accent2: #3b82f6;
  --green:   #22c55e;
  --green2:  #16a34a;
  --red:     #ef4444;
  --yellow:  #f59e0b;
  --blue:    #60a5fa;
  --cyan:    #22d3ee;
  --indigo:  #6366f1;
  --violet:  #2563eb;
  --violet2: #3b82f6;
  --purple:  #6366f1;
  --teal:    #14b8a6;
  --mono:    'JetBrains Mono', monospace;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.6;
  min-height: 100vh;
  padding: 36px 20px 64px;
  max-width: 1060px;
  margin: 0 auto;
  background-image:
    radial-gradient(ellipse 60% 35% at 50% -5%, #1e3a6e18, transparent),
    radial-gradient(ellipse 30% 25% at 90% 5%,  #0a2a5a12, transparent);
}

/* ── HEADER ───────────────────────────────── */
.header {
  display: flex; align-items: center;
  justify-content: space-between;
  margin-bottom: 36px; flex-wrap: wrap; gap: 14px;
}
.header-left { display: flex; align-items: center; gap: 14px; }
.avatar {
  width: 48px; height: 48px; border-radius: 12px; flex-shrink: 0;
  background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 55%, #3b82f6 100%);
  display: flex; align-items: center; justify-content: center;
  color: #fff; box-shadow: 0 0 24px #2563eb44, 0 4px 14px #0009;
}
.avatar .ic { width: 26px; height: 26px; }
.bot-name {
  font-size: 20px; font-weight: 800; line-height: 1.1;
  letter-spacing: -0.01em;
  background: linear-gradient(90deg, #e2e8f4 0%, #93c5fd 60%, #60a5fa 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.bot-sub { font-size: 11.5px; color: var(--muted2); margin-top: 3px; letter-spacing: 0.01em; }

.status-badge {
  display: flex; align-items: center; gap: 9px;
  background: var(--s3); border: 1px solid var(--border2);
  border-radius: 999px; padding: 8px 18px;
  font-size: 12.5px; font-weight: 600; color: ${statusColor};
  box-shadow: 0 2px 14px #0007;
}
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: ${statusColor};
  ${isOnline      ? `box-shadow: 0 0 8px ${statusColor}cc, 0 0 16px ${statusColor}66; animation: pulse 2.4s ease-in-out infinite;` : ''}
  ${isReconnecting ? `animation: pulse 0.9s ease-in-out infinite;` : ''}
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.35; transform: scale(0.82); }
}

/* ── DIVIDER ──────────────────────────────── */
.sep {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border2) 25%, var(--border2) 75%, transparent);
  margin-bottom: 28px;
}

/* ── STAT CARDS ───────────────────────────── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px; margin-bottom: 28px;
}
.card {
  background: var(--s2); border: 1px solid var(--border);
  border-radius: 16px; padding: 20px 18px 16px;
  position: relative; overflow: hidden;
}
.card::after {
  content: ''; position: absolute;
  top: 0; left: 0; right: 0; height: 2px;
  border-radius: 16px 16px 0 0;
}
.card.cv::after { background: linear-gradient(90deg, #2563eb, #3b82f6); }
.card.cg::after { background: linear-gradient(90deg, #22c55e, #14b8a6); }
.card.cb::after { background: linear-gradient(90deg, #6366f1, #60a5fa); }
.card.cr::after { background: linear-gradient(90deg, #ef4444, #f97316); }
.card.cy::after { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.card-ic {
  width: 20px; height: 20px; margin-bottom: 14px;
  opacity: 0.55;
}
.card-label {
  font-size: 9.5px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.13em; margin-bottom: 6px;
}
.card-val {
  font-size: 30px; font-weight: 800; line-height: 1;
  font-family: var(--mono);
}
.card-val.cv { color: var(--violet2); }
.card-val.cg { color: var(--green); }
.card-val.cb { color: var(--blue); }
.card-val.cr { color: var(--red); }
.card-val.cy { color: var(--yellow); }
.card-sub { font-size: 11px; color: var(--muted); margin-top: 5px; }

/* ── SECTION LABEL ────────────────────────── */
.sec-label {
  display: flex; align-items: center; gap: 9px;
  font-size: 10px; font-weight: 700; color: var(--muted2);
  text-transform: uppercase; letter-spacing: 0.14em;
  margin-bottom: 11px;
}
.sec-label .ic { width: 15px; height: 15px; opacity: 0.6; }
.sec-label::after {
  content: ''; flex: 1; height: 1px;
  background: linear-gradient(90deg, var(--border2), transparent);
}

/* ── PANEL ────────────────────────────────── */
.panel {
  background: var(--s1); border: 1px solid var(--border);
  border-radius: 16px; overflow: hidden;
  box-shadow: 0 4px 32px #00000035;
  margin-bottom: 24px;
}

/* ── TABLE ────────────────────────────────── */
table { width: 100%; border-collapse: collapse; }
th {
  padding: 11px 16px; text-align: left;
  font-size: 10px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.1em;
  background: var(--s2); border-bottom: 1px solid var(--border);
}
td {
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  font-size: 13px; vertical-align: middle;
}
tr:last-child td { border-bottom: none; }
tr:hover td { background: #ffffff04; }

.td-icon { width: 36px; padding-right: 0; opacity: 0.35; }
.td-icon .ic { width: 14px; height: 14px; }
.tid { font-family: var(--mono); font-size: 12px; color: var(--muted2); }
.mono { font-family: var(--mono); }
.empty-row { color: var(--muted); text-align: center; padding: 28px 16px; font-size: 13px; }
.empty-row code {
  background: var(--s3); border: 1px solid var(--border2);
  border-radius: 5px; padding: 1px 7px; font-family: var(--mono);
  font-size: 12px; color: var(--violet2);
}

/* ── PILLS ────────────────────────────────── */
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600;
}
.pill .ic { width: 11px; height: 11px; }
.pill-active { background: #16a34a22; color: var(--green);   border: 1px solid #16a34a44; }
.pill-off    { background: #ef444422; color: var(--red);     border: 1px solid #ef444444; }
.pill-muted  { background: #eab30822; color: var(--yellow);  border: 1px solid #eab30844; }

/* ── LOGS ─────────────────────────────────── */
.log-wrap {
  max-height: 320px; overflow-y: auto;
  padding: 6px 0; scroll-behavior: smooth;
}
.log-wrap::-webkit-scrollbar { width: 5px; }
.log-wrap::-webkit-scrollbar-track { background: transparent; }
.log-wrap::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 99px; }
.log-row {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 5px 16px; font-size: 12.5px; transition: background 0.1s;
}
.log-row:hover { background: #ffffff04; }
.log-row .ic { width: 13px; height: 13px; flex-shrink: 0; margin-top: 3px; opacity: 0.8; }
.lt { color: var(--muted); font-family: var(--mono); font-size: 11px; flex-shrink: 0; margin-top: 1px; min-width: 72px; }
.lm { color: var(--text); word-break: break-word; opacity: 0.88; }
.log-row.error .ic, .log-row.error .lm { color: var(--red); }
.log-row.warn  .ic, .log-row.warn  .lm { color: var(--yellow); }
.log-row.reply .ic, .log-row.reply .lm { color: var(--violet2); }
.log-row.info  .ic                      { color: var(--blue); }

/* ── COMMANDS TABLE ───────────────────────── */
.cmd-cell  { font-family: var(--mono); font-size: 12px; color: var(--violet2); white-space: nowrap; width: 1%; padding-right: 6px; }
.desc-cell { color: var(--muted2); font-size: 12.5px; }

/* ── BOT STATUS PILLS ─────────────────────── */
.bots-status-wrap {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
}
.bot-pill-wrap { display: flex; }
.bot-pill {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--s3); border: 1px solid var(--border2);
  border-radius: 999px; padding: 7px 15px;
  font-size: 12px; font-weight: 600;
  box-shadow: 0 2px 10px #0006;
}
.bot-pill-label {
  color: var(--text); font-weight: 700; font-size: 12.5px; margin-right: 2px;
}

/* ── FOOTER ───────────────────────────────── */
.footer {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 8px;
  border-top: 1px solid var(--border); padding-top: 18px; margin-top: 8px;
  font-size: 11.5px; color: var(--muted);
}
.footer .mono { color: var(--muted2); font-size: 11px; }
.refresh-row { display: flex; align-items: center; gap: 6px; }
.refresh-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--blue); animation: pulse 2s ease-in-out infinite;
}

/* ── IC HELPER ────────────────────────────── */
.ic {
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.ic svg { width: 100%; height: 100%; }

/* ── LAYOUT GRID ──────────────────────────── */
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
@media (max-width: 620px) {
  .two-col { grid-template-columns: 1fr; }
  body { padding: 20px 14px 48px; }
  .header { flex-direction: column; align-items: flex-start; }
  .cards { grid-template-columns: 1fr 1fr; }
}
</style>
</head>
<body>

<!-- HEADER -->
<header class="header">
  <div class="header-left">
    <div class="avatar">${icon("bot", 26)}</div>
    <div>
      <div class="bot-name">COZY BOT PANEL</div>
      <div class="bot-sub">Messenger Automation System &nbsp;·&nbsp; Developer: <span class="mono">${escapeHtml(state.developerID || "—")}</span></div>
    </div>
  </div>
  <div class="bots-status-wrap">
    ${botStatusBadges}
  </div>
</header>

<div class="sep"></div>

<!-- STAT CARDS -->
<div class="cards">
  <div class="card cv">
    ${icon("zap", 20)}
    <div class="card-label">Total Replies</div>
    <div class="card-val cv">${state.totalRepliesSent}</div>
    <div class="card-sub">messages sent</div>
  </div>
  <div class="card cg">
    ${icon("messages", 20)}
    <div class="card-label">Active Chats</div>
    <div class="card-val cg">${activeCount}</div>
    <div class="card-sub">auto-reply on</div>
  </div>
  <div class="card cb">
    ${icon("users", 20)}
    <div class="card-label">Total Threads</div>
    <div class="card-val cb">${threads.length}</div>
    <div class="card-sub">${offCount} off, ${mutedCount} muted</div>
  </div>
  <div class="card cy">
    ${icon("clock", 20)}
    <div class="card-label">Uptime</div>
    <div class="card-val cy" style="font-size:22px;padding-top:4px">${getUptime()}</div>
    <div class="card-sub">since start</div>
  </div>
</div>

<!-- THREADS + LOGS -->
<div class="two-col">
  <div>
    <div class="sec-label">${icon("chat", 15)} Active Threads</div>
    <div class="panel">
      <table>
        <thead><tr>
          <th style="width:36px"></th>
          <th>Thread ID</th>
          <th>Status</th>
        </tr></thead>
        <tbody>${threadRows}</tbody>
      </table>
    </div>
  </div>

  <div>
    <div class="sec-label">${icon("activity", 15)} Live Logs</div>
    <div class="panel">
      <div class="log-wrap">${logRows}</div>
    </div>
  </div>
</div>

<!-- COMMANDS -->
<div class="sec-label">${icon("terminal", 15)} Command Reference</div>
<div class="panel">
  <table>
    <thead><tr>
      <th>Command</th>
      <th>Description</th>
    </tr></thead>
    <tbody>${cmdRows}</tbody>
  </table>
</div>

<!-- FOOTER -->
<div class="footer">
  <span>COZY BOT PANEL &nbsp;·&nbsp; Command prefix: <span class="mono">!</span></span>
  <span class="refresh-row"><div class="refresh-dot"></div> auto-refresh every 5s</span>
</div>

</body>
</html>`;
}

function startDashboard(port = 5000) {
    const server = http.createServer((req, res) => {
        try {
            if (req.url === "/api/state") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ logs, state }));
                return;
            }
            let html;
            try { html = buildHTML(); }
            catch (e) {
                html = `<!DOCTYPE html><html><body style="background:#09090f;color:#ef4444;font-family:monospace;padding:40px">
                    <h2>Dashboard render error</h2><pre>${String(e)}</pre>
                    <p style="color:#565670;margin-top:16px">Auto-refreshes in 5s</p>
                    <meta http-equiv="refresh" content="5"/></body></html>`;
            }
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(html);
        } catch (e) {
            try { res.writeHead(500); res.end("Server error"); } catch (_) {}
        }
    });

    server.on("error", (err) => {
        console.error("[cozy-bot] Dashboard server error:", err);
    });

    server.listen(port, "0.0.0.0", () => {
        console.log(`[cozy-bot] Dashboard running on port ${port}`);
    });
}

module.exports = { startDashboard, addLog, state };
