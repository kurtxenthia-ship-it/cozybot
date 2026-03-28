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
    const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
    if(d>0)return`${d}d ${h%24}h`;
    if(h>0)return`${h}h ${m%60}m`;
    if(m>0)return`${m}m ${s%60}s`;
    return`${s}s`;
}

function esc(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function readCustomReplies() { try{return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8"));}catch(_){return[];} }
function writeCustomReplies(a){ fs.writeFileSync(CUSTOM_REPLIES_FILE,JSON.stringify(a,null,2),"utf8"); }
function readImageReplies() { try{return JSON.parse(fs.readFileSync(IMAGE_REPLIES_FILE,"utf8"));}catch(_){return[];} }
function writeImageReplies(a){ fs.writeFileSync(IMAGE_REPLIES_FILE,JSON.stringify(a,null,2),"utf8"); }
function readBotConfig() {
    try{return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE,"utf8"));}
    catch(_){return{loopReact:"😆",loopDelay:5,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false};}
}
function writeBotConfig(c){ fs.writeFileSync(BOT_CONFIG_FILE,JSON.stringify(c,null,2),"utf8"); }

function buildHTML() {
    const threads      = Object.keys({...state.loopEnabled,...state.autoRespondEnabled});
    const uniqueThreads= [...new Set(threads)];
    const loopCount    = Object.values(state.loopEnabled||{}).filter(Boolean).length;
    const arCount      = Object.values(state.autoRespondEnabled||{}).filter(Boolean).length;
    const mutedCount   = Object.values(state.mutedThreads||{}).filter(Boolean).length;
    const isOnline     = state.loggedIn;
    const isRecon      = state.reconnecting;
    const statusColor  = isOnline?"#22c55e":(isRecon?"#f59e0b":"#ef4444");
    const statusText   = isOnline?"Online":(isRecon?"Reconnecting…":"Offline");

    const cfg          = readBotConfig();
    const customReplies= readCustomReplies();
    const imageReplies = readImageReplies();

    // Bot pills
    const botBadges = state.bots.length===0
        ? `<div class="bot-pill bot-off"><span class="bdot"></span><span>No bots loaded</span></div>`
        : state.bots.map(b=>{
            const cls=b.loggedIn?"bot-on":(b.reconnecting?"bot-warn":"bot-off");
            const lbl=b.loggedIn?"Online":(b.reconnecting?`Reconnecting ${b.nextReconnectIn}s`:"Offline");
            return `<div class="bot-pill ${cls}"><span class="bdot"></span><b>${esc(b.label)}</b><span class="bsub">${lbl}</span></div>`;
        }).join("");

    // Thread rows
    const threadRows = uniqueThreads.length===0
        ? `<tr><td colspan="4" class="td-empty">No threads yet — send <code>.</code> (dot) in Messenger to start the loop</td></tr>`
        : uniqueThreads.map(tid=>{
            const loop = state.loopEnabled&&state.loopEnabled[tid];
            const ar   = state.autoRespondEnabled&&state.autoRespondEnabled[tid];
            const muted= state.mutedThreads&&state.mutedThreads[tid];
            return `<tr>
              <td class="td-mono">${esc(tid)}</td>
              <td>${loop?`<span class="badge bg">🔄 Loop ON</span>`:`<span class="badge br">Loop OFF</span>`}</td>
              <td>${ar?`<span class="badge bg">💬 Respond ON</span>`:`<span class="badge br">Respond OFF</span>`} ${muted?`<span class="badge by">🔇</span>`:""}</td>
            </tr>`;
        }).join("");

    // Logs
    const logRows = logs.length===0
        ? `<div class="lrow lidle"><span class="ltime">--:--</span><span class="llvl">IDLE</span><span class="lmsg">Waiting for events…</span></div>`
        : logs.slice(0,80).map(l=>{
            const lv={error:"ERR",warn:"WARN",reply:"SEND",info:"INFO"}[l.type]||"INFO";
            return `<div class="lrow l${l.type}"><span class="ltime">${esc(l.time)}</span><span class="llvl">${lv}</span><span class="lmsg">${esc(l.message)}</span></div>`;
        }).join("");

    // Custom text replies list
    const textQueueRows = customReplies.length===0
        ? `<div class="empty-q">Queue empty — add your first message above</div>`
        : customReplies.map((w,i)=>
            `<div class="qi">
                <span class="qi-n">${String(i+1).padStart(2,"0")}</span>
                <span class="qi-v">${esc(w)}</span>
                <form method="POST" action="/api/replies/remove" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    // Image URL list
    const imgRows = imageReplies.length===0
        ? `<div class="empty-q">No custom image URLs — add one above</div>`
        : imageReplies.map((u,i)=>
            `<div class="qi">
                <span class="qi-n">${String(i+1).padStart(2,"0")}</span>
                <span class="qi-v" style="color:var(--blue2);font-size:11px">${esc(u)}</span>
                <form method="POST" action="/api/images/remove" style="margin:0">
                    <input type="hidden" name="index" value="${i}"/>
                    <button class="btn-rm" type="submit">✕</button>
                </form>
            </div>`).join("");

    const CMDS = [
        [". (dot)","Toggle loop ON/OFF — works in both groups AND PMs"],
        ["!on","Enable auto-respond (groups only) — replies to every message"],
        ["!off","Disable auto-respond (groups only)"],
        ["!mute / !unmute","Pause / resume auto-respond"],
        ["!nn &lt;name&gt;","Set nickname for all members + lock it"],
        ["!cg &lt;name&gt;","Change group name + lock it"],
        ["!banner [url]","Set group photo + protect it"],
        ["!kick &lt;uid&gt;","Kick a member"],
        ["!add &lt;uid&gt;","Add a member"],
        ["!emoji &lt;emoji&gt;","Change group emoji"],
        ["!color &lt;name&gt;","Change chat color"],
        ["!seen","Mark all messages as read"],
        ["!spam &lt;n&gt; &lt;msg&gt;","Send message n times (max 20)"],
        ["!broadcast &lt;text&gt;","Send to all auto-respond threads"],
        ["!say &lt;text&gt;","Bot sends a message"],
        ["!vm &lt;text&gt;","Voice message (TTS)"],
        ["!info","Group info — name, members, admins, IDs"],
        ["!lock","Show active protections"],
        ["!freeze / !unfreeze","Freeze group — chatters get kicked"],
        ["!perms &lt;uid&gt; &lt;t&gt;","Temp permissions (e.g. 5min, 1h)"],
        ["!revoke [uid]","Remove temp permissions"],
        ["!gp &lt;url&gt; / !gp off","Profile pic guard — restores every 5min"],
        ["!antirestrict","Alert when bot is kicked"],
        ["!antichat","Auto-retry failed sends"],
        ["!count","Count 1 to 20 in chat"],
        ["!id","Get Facebook ID of replied user"],
        ["!status","Show loop + auto-respond status"],
        ["!test","Ping bot"],
        ["!myid","Your Facebook ID"],
        ["!help","Show full command list in Messenger"],
    ];

    const cmdRows = CMDS.map(([c,d])=>`<tr><td class="tc">${c}</td><td class="td2">${d}</td></tr>`).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CZB Panel</title>
<meta http-equiv="refresh" content="10"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080a12;--s0:#0d1020;--s1:#111526;--s2:#161b2e;--s3:#1d2238;
  --b0:#1e2440;--b1:#2a3158;--b2:#3d4870;
  --tx:#dde3f5;--tx2:#8b95c0;--tx3:#555e85;--muted:#3a4260;
  --ac:#5b6ef5;--ac2:#7b8ff7;--acg:linear-gradient(135deg,#4a5be0,#5b6ef5,#7b8ff7);
  --gn:#10b981;--gn2:#34d399;
  --rd:#ef4444;--rd2:#f87171;
  --yw:#f59e0b;--yw2:#fbbf24;
  --pu:#a855f7;--pu2:#c084fc;
  --bu:#3b82f6;--bu2:#60a5fa;
  --mono:'JetBrains Mono',monospace;
  --sans:'Inter',sans-serif;
}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--tx);font-family:var(--sans);font-size:13.5px;line-height:1.6;min-height:100vh;
  background-image:radial-gradient(ellipse 55% 35% at 80% -5%,#5b6ef512,transparent),radial-gradient(ellipse 40% 25% at 5% 105%,#a855f709,transparent);}

/* TOPBAR */
.topbar{
  position:sticky;top:0;z-index:200;height:48px;
  background:rgba(8,10,18,.9);backdrop-filter:blur(18px);
  border-bottom:1px solid var(--b0);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 22px;gap:16px;
}
.tb-l{display:flex;align-items:center;gap:14px}
.logo{
  display:flex;align-items:center;gap:9px;
  font-family:var(--mono);font-size:13px;font-weight:700;color:var(--ac2);
}
.logo-sq{
  width:26px;height:26px;border-radius:7px;
  background:var(--acg);
  display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:800;color:#fff;
  box-shadow:0 0 14px #5b6ef140;
}
.tag{
  font-family:var(--mono);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;
  padding:2px 8px;border-radius:4px;background:#5b6ef514;border:1px solid #5b6ef528;color:var(--ac2);
}
.tb-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--tx3);font-family:var(--mono)}
.tb-r{display:flex;align-items:center;gap:14px;font-family:var(--mono);font-size:11px;color:var(--tx3)}
.tb-r b{color:var(--ac2)}
.sync{display:flex;align-items:center;gap:5px}
.sdot{width:5px;height:5px;border-radius:50%;background:var(--gn);animation:blink 2.4s ease-in-out infinite;box-shadow:0 0 6px var(--gn)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}

/* PAGE SHELL */
.shell{display:flex;min-height:calc(100vh - 48px)}

/* SIDEBAR */
.sidebar{
  width:340px;flex-shrink:0;
  background:var(--s0);border-right:1px solid var(--b0);
  display:flex;flex-direction:column;
  position:sticky;top:48px;height:calc(100vh - 48px);overflow-y:auto;
}
.sidebar::-webkit-scrollbar{width:3px}
.sidebar::-webkit-scrollbar-thumb{background:var(--b1);border-radius:99px}

/* MAIN */
.main{flex:1;padding:24px 24px 60px;min-width:0}

/* HERO */
.hero{
  background:var(--s1);border:1px solid var(--b0);border-radius:14px;
  padding:22px 24px;margin-bottom:20px;
  position:relative;overflow:hidden;
}
.hero::after{
  content:'';position:absolute;top:-40px;right:-40px;
  width:160px;height:160px;border-radius:50%;
  background:radial-gradient(circle,#5b6ef514,transparent 70%);pointer-events:none;
}
.hero-top{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.hero-icon{
  width:48px;height:48px;border-radius:12px;
  background:var(--acg);display:flex;align-items:center;justify-content:center;
  font-size:22px;box-shadow:0 0 24px #5b6ef145,0 6px 18px #0006;flex-shrink:0;
}
.hero-title{font-size:20px;font-weight:800;color:var(--tx);letter-spacing:-.02em}
.hero-sub{font-size:11.5px;color:var(--tx3);font-family:var(--mono);margin-top:2px}
.bot-pills{display:flex;flex-wrap:wrap;gap:7px}
.bot-pill{
  display:inline-flex;align-items:center;gap:7px;
  padding:5px 12px;border-radius:7px;border:1px solid var(--b1);
  background:var(--s2);font-size:11px;font-family:var(--mono);
}
.bot-on{border-color:#10b98130;color:var(--gn2)}
.bot-warn{border-color:#f59e0b30;color:var(--yw2)}
.bot-off{color:var(--tx3)}
.bdot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;animation:bdp 2.4s ease-in-out infinite}
.bot-off .bdot{animation:none;opacity:.3}
@keyframes bdp{0%,100%{opacity:1}50%{opacity:.2}}
.bsub{opacity:.55;font-size:10px}

/* STAT CARDS */
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}
.card{
  background:var(--s1);border:1px solid var(--b0);border-radius:11px;
  padding:16px 16px 13px;position:relative;overflow:hidden;
  transition:border-color .2s;cursor:default;
}
.card:hover{border-color:var(--b1)}
.ct{position:absolute;top:0;left:0;right:0;height:2.5px;border-radius:11px 11px 0 0}
.ct-i{background:linear-gradient(90deg,#4338ca,#7b8ff7)}
.ct-g{background:linear-gradient(90deg,#059669,#34d399)}
.ct-p{background:linear-gradient(90deg,#7c3aed,#c084fc)}
.ct-a{background:linear-gradient(90deg,#d97706,#fbbf24)}
.clabel{font-size:9px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.15em;margin-bottom:8px}
.cval{font-size:28px;font-weight:800;line-height:1;font-family:var(--mono)}
.ci{color:var(--ac2)}.cg{color:var(--gn2)}.cp{color:var(--pu2)}.ca{color:var(--yw2)}
.csub{font-size:10px;color:var(--tx3);margin-top:5px}

/* PANEL */
.panel{background:var(--s1);border:1px solid var(--b0);border-radius:11px;overflow:hidden;margin-bottom:18px}
.ph{
  background:var(--s2);border-bottom:1px solid var(--b0);
  padding:10px 16px;display:flex;align-items:center;justify-content:space-between;
}
.ph-l{display:flex;align-items:center;gap:9px}
.pbadge{
  font-size:8.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  padding:2px 8px;border-radius:4px;background:#5b6ef514;border:1px solid #5b6ef525;color:var(--ac2);
}
.pbadge-g{background:#10b98113;border-color:#10b98125;color:var(--gn2)}
.pbadge-p{background:#a855f713;border-color:#a855f725;color:var(--pu2)}
.ph-title{font-size:11.5px;font-weight:600;color:var(--tx2)}
.ph-meta{font-size:10.5px;color:var(--tx3);font-family:var(--mono)}

/* TABLE */
table{width:100%;border-collapse:collapse}
th{padding:9px 15px;text-align:left;font-size:8.5px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.13em;background:var(--s2);border-bottom:1px solid var(--b0)}
td{padding:9px 15px;border-bottom:1px solid var(--b0);font-size:12.5px;vertical-align:middle;color:var(--tx2)}
tr:last-child td{border-bottom:none}
tr:hover td{background:#ffffff02}
.td-mono{font-family:var(--mono);font-size:11px;color:var(--tx3)}
.td-empty{text-align:center;color:var(--tx3);padding:26px;font-size:12.5px}
.td-empty code{background:var(--s2);border:1px solid var(--b1);border-radius:4px;padding:1px 6px;font-family:var(--mono);color:var(--ac2);font-size:11.5px}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;font-family:var(--mono);white-space:nowrap}
.bg{background:#10b98116;color:var(--gn2);border:1px solid #10b98126}
.br{background:#ef444416;color:var(--rd2);border:1px solid #ef444426}
.by{background:#f59e0b16;color:var(--yw2);border:1px solid #f59e0b26}
.bp{background:#a855f716;color:var(--pu2);border:1px solid #a855f726}

/* INPUT ROW */
.irow{display:flex;gap:8px;padding:12px 15px;border-bottom:1px solid var(--b0);flex-wrap:wrap;align-items:center}
.ifield{
  flex:1;min-width:160px;background:var(--bg);border:1px solid var(--b1);
  border-radius:7px;padding:8px 12px;color:var(--tx);font-size:12.5px;outline:none;
  transition:border-color .2s,box-shadow .2s;font-family:var(--mono);
}
.ifield:focus{border-color:var(--ac);box-shadow:0 0 0 3px #5b6ef514}
.ifield::placeholder{color:var(--muted)}
.btn-add{
  background:var(--acg);color:#fff;border:none;border-radius:7px;padding:8px 16px;
  font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;
  transition:opacity .15s;font-family:var(--sans);
}
.btn-add:hover{opacity:.85}
.btn-rm{
  background:#ef444412;color:var(--rd2);border:1px solid #ef444428;
  border-radius:5px;padding:3px 9px;font-size:11px;font-weight:600;cursor:pointer;
  transition:background .15s;white-space:nowrap;
}
.btn-rm:hover{background:#ef444425}

/* QUEUE LIST */
.ql{padding:3px 0;max-height:260px;overflow-y:auto}
.ql::-webkit-scrollbar{width:3px}
.ql::-webkit-scrollbar-thumb{background:var(--b1);border-radius:99px}
.qi{display:flex;align-items:center;gap:10px;padding:7px 15px;border-bottom:1px solid var(--b0);transition:background .1s}
.qi:last-child{border-bottom:none}
.qi:hover{background:#ffffff02}
.qi-n{font-size:10px;color:var(--muted);min-width:24px;font-family:var(--mono)}
.qi-v{color:var(--tx2);font-size:12px;word-break:break-all;flex:1;font-family:var(--mono)}
.empty-q{color:var(--tx3);text-align:center;padding:22px;font-size:12px}

/* COMMAND TABLE */
.tc{font-family:var(--mono);font-size:11.5px;color:var(--ac2);white-space:nowrap;width:1%;padding-right:4px}
.td2{color:var(--tx3);font-size:12px}

/* ─── SIDEBAR SECTIONS ──────────────────────────── */
.sb-section{border-bottom:1px solid var(--b0)}
.sb-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:11px 16px;cursor:pointer;
  font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:.14em;
  user-select:none;
}
.sb-head:hover{background:#ffffff03}
.sb-head span{font-size:11px;color:var(--tx3)}
.sb-body{padding:0}

/* LOGS IN SIDEBAR */
.log-wrap{
  max-height:320px;overflow-y:auto;
  background:var(--bg);padding:4px 0;font-family:var(--mono);font-size:11px;
}
.log-wrap::-webkit-scrollbar{width:3px}
.log-wrap::-webkit-scrollbar-thumb{background:var(--b1);border-radius:99px}
.lrow{display:flex;gap:10px;padding:3px 14px;line-height:1.5;transition:background .1s}
.lrow:hover{background:#ffffff02}
.ltime{color:var(--muted);font-size:9.5px;flex-shrink:0;min-width:64px;padding-top:1px}
.llvl{font-size:9px;font-weight:700;flex-shrink:0;min-width:34px;padding-top:2px;text-transform:uppercase}
.lmsg{color:var(--tx3);word-break:break-word;flex:1;font-size:10.5px}
.lerror .llvl{color:var(--rd2)}.lerror .lmsg{color:#fca5a5}
.lwarn  .llvl{color:var(--yw2)}.lwarn  .lmsg{color:#fde68a}
.lreply .llvl{color:var(--gn2)}.lreply .lmsg{color:#6ee7b7}
.linfo  .llvl{color:var(--ac2)}.linfo  .lmsg{color:var(--tx3)}
.lidle  .llvl{color:var(--muted)}.lidle  .lmsg{color:var(--muted)}

/* CONFIG FORM IN SIDEBAR */
.cfg-form{padding:14px 16px}
.cfg-group-title{
  font-size:9.5px;font-weight:700;color:var(--ac2);text-transform:uppercase;letter-spacing:.14em;
  margin-bottom:12px;margin-top:6px;padding-bottom:6px;border-bottom:1px solid var(--b0);
}
.cfg-field{margin-bottom:12px}
.cfg-label{display:block;font-size:9px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.12em;margin-bottom:4px}
.cfg-input,.cfg-select{
  width:100%;background:var(--bg);border:1px solid var(--b1);
  border-radius:6px;padding:7px 11px;color:var(--tx);font-size:12px;outline:none;
  transition:border-color .2s;font-family:var(--mono);
}
.cfg-select{
  appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23555e85' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;
  cursor:pointer;
}
.cfg-input:focus,.cfg-select:focus{border-color:var(--ac)}
.cfg-hint{font-size:9.5px;color:var(--muted);margin-top:3px;line-height:1.4}
.cfg-check-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cfg-check{
  width:32px;height:18px;border-radius:9px;cursor:pointer;
  background:var(--b1);border:none;outline:none;position:relative;appearance:none;transition:background .2s;flex-shrink:0;
}
.cfg-check:checked{background:var(--ac)}
.cfg-check::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .2s}
.cfg-check:checked::after{transform:translateX(14px)}
.cfg-check-label{font-size:11.5px;color:var(--tx2);cursor:pointer}
.btn-save{
  width:100%;background:var(--acg);color:#fff;border:none;border-radius:7px;
  padding:9px;font-size:12.5px;font-weight:600;cursor:pointer;
  transition:opacity .15s;font-family:var(--sans);margin-top:4px;
}
.btn-save:hover{opacity:.85}

/* COOKIE SECTION */
.cookie-area{
  width:100%;background:var(--bg);border:1px solid var(--b1);
  border-radius:6px;padding:8px 10px;color:var(--tx);font-size:10px;
  font-family:var(--mono);outline:none;resize:vertical;min-height:90px;
  transition:border-color .2s;line-height:1.5;
}
.cookie-area:focus{border-color:var(--ac)}
.cookie-area::placeholder{color:var(--muted)}
.btn-cookie{
  width:100%;background:linear-gradient(135deg,#059669,#10b981);color:#fff;
  border:none;border-radius:7px;padding:8px;font-size:12px;font-weight:600;
  cursor:pointer;transition:opacity .15s;font-family:var(--sans);margin-top:6px;
}
.btn-cookie:hover{opacity:.85}
.cookie-hint{font-size:9.5px;color:var(--muted);margin-top:5px;line-height:1.4}

/* SECTION LABEL (main area) */
.slabel{
  display:flex;align-items:center;gap:8px;
  font-size:9.5px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.17em;margin-bottom:11px;
}
.slabel::after{content:'';flex:1;height:1px;background:var(--b0)}

/* FOOTER */
.footer{
  border-top:1px solid var(--b0);padding-top:16px;margin-top:8px;
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
  font-size:11px;color:var(--muted);font-family:var(--mono);
}
.footer-r{display:flex;align-items:center;gap:6px}

@media(max-width:900px){
  .shell{flex-direction:column}
  .sidebar{width:100%;position:relative;height:auto;border-right:none;border-bottom:1px solid var(--b0)}
  .cards{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>

<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-l">
    <div class="logo">
      <div class="logo-sq">C</div>
      CZB<span style="opacity:.3;margin:0 2px">::</span>panel
    </div>
    <span class="tag">v2.1</span>
    <div class="tb-status">
      <span style="width:7px;height:7px;border-radius:50%;background:${statusColor};display:inline-block;box-shadow:0 0 8px ${statusColor}80"></span>
      ${statusText}
    </div>
  </div>
  <div class="tb-r">
    <span>dev <b>${esc(state.developerID||"—")}</b></span>
    <div class="sync"><div class="sdot"></div>live · 10s</div>
  </div>
</div>

<div class="shell">

<!-- ══ SIDEBAR ══════════════════════════════════════════════════════════ -->
<aside class="sidebar">

  <!-- LIVE LOGS -->
  <div class="sb-section">
    <div class="sb-head">📡 Live Logs <span>${logs.length} entries</span></div>
    <div class="sb-body">
      <div class="log-wrap">${logRows}</div>
    </div>
  </div>

  <!-- LOOP CONFIG -->
  <div class="sb-section">
    <div class="sb-head">⚙️ Loop Settings</div>
    <div class="sb-body">
      <form method="POST" action="/api/config/save" class="cfg-form">
        <div class="cfg-group-title">Loop Engine (dot trigger)</div>

        <div class="cfg-field">
          <label class="cfg-label">Reaction Emoji</label>
          <input class="cfg-input" type="text" name="loopReact" value="${esc(cfg.loopReact||'😆')}" maxlength="8"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Delay (seconds)</label>
          <input class="cfg-input" type="number" name="loopDelay" value="${cfg.loopDelay||5}" min="1" max="300"/>
          <div class="cfg-hint">Interval between each message</div>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Image Chance (%)</label>
          <input class="cfg-input" type="number" name="imageProbability" value="${cfg.imageProbability||20}" min="0" max="100"/>
          <div class="cfg-hint">Probability of sending an image URL</div>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Loop Mode</label>
          <select class="cfg-select" name="loopMode">
            <option value="sequential" ${cfg.loopMode==="sequential"?"selected":""}>Sequential</option>
            <option value="shuffle" ${cfg.loopMode==="shuffle"?"selected":""}>Shuffle</option>
          </select>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Max Messages (0 = unlimited)</label>
          <input class="cfg-input" type="number" name="maxLoopCount" value="${cfg.maxLoopCount||0}" min="0"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Auto-Stop After (minutes, 0 = off)</label>
          <input class="cfg-input" type="number" name="autoStopMinutes" value="${cfg.autoStopMinutes||0}" min="0"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Start Message</label>
          <input class="cfg-input" type="text" name="loopStartMsg" value="${esc(cfg.loopStartMsg||'')}" placeholder="Sent when loop starts"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Stop Message</label>
          <input class="cfg-input" type="text" name="loopStopMsg" value="${esc(cfg.loopStopMsg||'')}" placeholder="Sent when loop stops"/>
        </div>
        <div class="cfg-check-row">
          <input class="cfg-check" type="checkbox" id="reactOnly" name="reactOnlyMode" value="1" ${cfg.reactOnlyMode?"checked":""}>
          <label class="cfg-check-label" for="reactOnly">React-only (no image sending)</label>
        </div>

        <div class="cfg-group-title" style="margin-top:14px">General</div>

        <div class="cfg-field">
          <label class="cfg-label">TTS Language</label>
          <select class="cfg-select" name="ttsLang">
            ${[["tl","Tagalog"],["en","English"],["ja","Japanese"],["ko","Korean"],["zh","Chinese"],["es","Spanish"],["fr","French"],["de","German"]].map(([v,n])=>`<option value="${v}" ${cfg.ttsLang===v?"selected":""}>${n}</option>`).join("")}
          </select>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Welcome Message</label>
          <input class="cfg-input" type="text" name="greetMsg" value="${esc(cfg.greetMsg||'Welcome! 👋')}" placeholder="For new members"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Anti-Spam Max Msgs</label>
          <input class="cfg-input" type="number" name="antiSpamMaxMsg" value="${cfg.antiSpamMaxMsg||5}" min="2"/>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Anti-Spam Window (s)</label>
          <input class="cfg-input" type="number" name="antiSpamWindowSec" value="${cfg.antiSpamWindowSec||10}" min="3"/>
        </div>
        <div class="cfg-check-row">
          <input class="cfg-check" type="checkbox" id="greetNew" name="greetNewMembers" value="1" ${cfg.greetNewMembers?"checked":""}>
          <label class="cfg-check-label" for="greetNew">Greet new members</label>
        </div>
        <div class="cfg-check-row">
          <input class="cfg-check" type="checkbox" id="antiSpam" name="antiSpamEnabled" value="1" ${cfg.antiSpamEnabled?"checked":""}>
          <label class="cfg-check-label" for="antiSpam">Anti-spam auto-kick</label>
        </div>
        <div class="cfg-check-row">
          <input class="cfg-check" type="checkbox" id="autoSeen" name="autoSeenEnabled" value="1" ${cfg.autoSeenEnabled?"checked":""}>
          <label class="cfg-check-label" for="autoSeen">Auto mark seen</label>
        </div>
        <div class="cfg-check-row">
          <input class="cfg-check" type="checkbox" id="typing" name="typingSimulate" value="1" ${cfg.typingSimulate?"checked":""}>
          <label class="cfg-check-label" for="typing">Simulate typing</label>
        </div>

        <button class="btn-save" type="submit">▶ Save Configuration</button>
      </form>
    </div>
  </div>

  <!-- SESSION / COOKIE -->
  <div class="sb-section">
    <div class="sb-head">🔑 Update Session Cookie</div>
    <div class="sb-body">
      <form method="POST" action="/api/fbstate/update" class="cfg-form">
        <textarea class="cookie-area" name="fbstate" placeholder='Paste your new fbstate JSON here…&#10;[{"key":"c_user","value":"..."},...]' required></textarea>
        <div class="cookie-hint">Paste the full fbstate JSON array from your session exporter. Bot will restart automatically after saving.</div>
        <button class="btn-cookie" type="submit">💾 Save &amp; Restart Bot</button>
      </form>
    </div>
  </div>

</aside>

<!-- ══ MAIN CONTENT ══════════════════════════════════════════════════════ -->
<main class="main">

  <!-- HERO -->
  <div class="hero">
    <div class="hero-top">
      <div class="hero-icon">🤖</div>
      <div>
        <div class="hero-title">Messenger Bot Control Panel</div>
        <div class="hero-sub">loop (dot) · auto-respond (!on/!off) · group protection · tts · image loop</div>
      </div>
    </div>
    <div class="bot-pills">${botBadges}</div>
  </div>

  <!-- STATS -->
  <div class="cards">
    <div class="card">
      <div class="ct ct-i"></div>
      <div class="clabel">Messages Sent</div>
      <div class="cval ci">${state.totalRepliesSent}</div>
      <div class="csub">total dispatches</div>
    </div>
    <div class="card">
      <div class="ct ct-g"></div>
      <div class="clabel">Active Loops</div>
      <div class="cval cg">${loopCount}</div>
      <div class="csub">dot-triggered</div>
    </div>
    <div class="card">
      <div class="ct ct-p"></div>
      <div class="clabel">Auto-Respond</div>
      <div class="cval cp">${arCount}</div>
      <div class="csub">${mutedCount} muted · groups only</div>
    </div>
    <div class="card">
      <div class="ct ct-a"></div>
      <div class="clabel">Uptime</div>
      <div class="cval ca" style="font-size:${getUptime().length>6?'18':'26'}px;padding-top:4px">${getUptime()}</div>
      <div class="csub">since boot</div>
    </div>
  </div>

  <!-- THREAD REGISTRY -->
  <div class="slabel">📡 Thread Registry</div>
  <div class="panel">
    <div class="ph">
      <div class="ph-l"><span class="pbadge pbadge-g">LIVE</span><span class="ph-title">Active Threads</span></div>
      <span class="ph-meta">${uniqueThreads.length} total</span>
    </div>
    <table>
      <thead><tr><th>Thread ID</th><th>Loop State</th><th>Auto-Respond</th></tr></thead>
      <tbody>${threadRows}</tbody>
    </table>
  </div>

  <!-- MESSAGE QUEUE -->
  <div class="slabel">💬 Loop Message Queue</div>
  <div class="panel">
    <div class="ph">
      <div class="ph-l"><span class="pbadge">QUEUE</span><span class="ph-title">Custom Text Replies</span></div>
      <span class="ph-meta" style="color:var(--ac2);font-weight:600">${customReplies.length} custom · ${customReplies.length+102} total</span>
    </div>
    <form class="irow" method="POST" action="/api/replies/add">
      <input class="ifield" type="text" name="word" placeholder="Add new message to the loop pool…" autocomplete="off" required/>
      <button class="btn-add" type="submit">＋ Add</button>
    </form>
    <div class="ql">${textQueueRows}</div>
  </div>

  <!-- IMAGE URL MANAGER -->
  <div class="slabel">🖼 Image URL Pool</div>
  <div class="panel">
    <div class="ph">
      <div class="ph-l"><span class="pbadge pbadge-p">IMAGES</span><span class="ph-title">Custom Image URLs for Loop</span></div>
      <span class="ph-meta" style="color:var(--pu2);font-weight:600">${imageReplies.length} custom URLs</span>
    </div>
    <form class="irow" method="POST" action="/api/images/add">
      <input class="ifield" type="url" name="url" placeholder="https://example.com/image.jpg" autocomplete="off" required/>
      <button class="btn-add" type="submit">＋ Add</button>
    </form>
    <div class="ql">${imgRows}</div>
  </div>

  <!-- COMMAND REFERENCE -->
  <div class="slabel">📟 Command Reference</div>
  <div class="panel">
    <div class="ph">
      <div class="ph-l"><span class="pbadge pbadge-p">DOCS</span><span class="ph-title">Available Commands</span></div>
      <span class="ph-meta">prefix: <b style="color:var(--ac2)">!</b> &nbsp;|&nbsp; loop trigger: <b style="color:var(--gn2)">. (dot)</b></span>
    </div>
    <table>
      <thead><tr><th style="width:200px">Command</th><th>Description</th></tr></thead>
      <tbody>${cmdRows}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>czb::panel v2.1 &nbsp;·&nbsp; node.js &nbsp;·&nbsp; ws3-fca</span>
    <div class="footer-r"><div class="sdot"></div><span>auto-refresh every 10s</span></div>
  </div>

</main>
</div>
</body>
</html>`;
}

function parseBody(req) {
    return new Promise(resolve=>{
        let body="";
        req.on("data",c=>{body+=c.toString()});
        req.on("end",()=>{
            const p={};
            body.split("&").forEach(pair=>{
                const [k,v]=pair.split("=");
                if(k) p[decodeURIComponent(k.replace(/\+/g," "))]=decodeURIComponent((v||"").replace(/\+/g," "));
            });
            resolve(p);
        });
    });
}

function startDashboard(port=5000) {
    const server = http.createServer(async(req,res)=>{
        try {
            // State JSON
            if (req.url==="/api/state"&&req.method==="GET") {
                res.writeHead(200,{"Content-Type":"application/json"});
                res.end(JSON.stringify({logs,state})); return;
            }

            // Add text reply
            if (req.url==="/api/replies/add"&&req.method==="POST") {
                const p=await parseBody(req);
                const w=(p.word||"").trim();
                if(w){ const a=readCustomReplies(); a.push(w); writeCustomReplies(a); }
                res.writeHead(302,{Location:"/"}); res.end(); return;
            }

            // Remove text reply
            if (req.url==="/api/replies/remove"&&req.method==="POST") {
                const p=await parseBody(req);
                const idx=parseInt(p.index);
                if(!isNaN(idx)){ const a=readCustomReplies(); if(idx>=0&&idx<a.length)a.splice(idx,1); writeCustomReplies(a); }
                res.writeHead(302,{Location:"/"}); res.end(); return;
            }

            // Add image URL
            if (req.url==="/api/images/add"&&req.method==="POST") {
                const p=await parseBody(req);
                const u=(p.url||"").trim();
                if(u&&u.startsWith("http")){ const a=readImageReplies(); a.push(u); writeImageReplies(a); }
                res.writeHead(302,{Location:"/"}); res.end(); return;
            }

            // Remove image URL
            if (req.url==="/api/images/remove"&&req.method==="POST") {
                const p=await parseBody(req);
                const idx=parseInt(p.index);
                if(!isNaN(idx)){ const a=readImageReplies(); if(idx>=0&&idx<a.length)a.splice(idx,1); writeImageReplies(a); }
                res.writeHead(302,{Location:"/"}); res.end(); return;
            }

            // Save bot config
            if (req.url==="/api/config/save"&&req.method==="POST") {
                const p=await parseBody(req);
                const cfg=readBotConfig();
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
                writeBotConfig(cfg);
                res.writeHead(302,{Location:"/"}); res.end(); return;
            }

            // Update fbstate (cookie)
            if (req.url==="/api/fbstate/update"&&req.method==="POST") {
                const p=await parseBody(req);
                const raw=(p.fbstate||"").trim();
                let parsed;
                try { parsed=JSON.parse(raw); }
                catch(e) {
                    res.writeHead(200,{"Content-Type":"text/html"});
                    res.end(`<!DOCTYPE html><html><body style="background:#080a12;color:#ef4444;font-family:monospace;padding:40px"><h3>❌ Invalid JSON</h3><p>${String(e)}</p><br><a href="/" style="color:#7b8ff7">← Go back</a></body></html>`);
                    return;
                }
                if (!Array.isArray(parsed)) {
                    res.writeHead(200,{"Content-Type":"text/html"});
                    res.end(`<!DOCTYPE html><html><body style="background:#080a12;color:#ef4444;font-family:monospace;padding:40px"><h3>❌ fbstate must be a JSON array</h3><br><a href="/" style="color:#7b8ff7">← Go back</a></body></html>`);
                    return;
                }
                fs.writeFileSync(FBSTATE_FILE,JSON.stringify(parsed,null,2),"utf8");
                addLog("info","fbstate updated from dashboard — bot will reconnect shortly.");
                res.writeHead(302,{Location:"/"}); res.end(); return;
            }

            // Main page
            let html;
            try { html=buildHTML(); }
            catch(e) {
                html=`<!DOCTYPE html><html><body style="background:#080a12;color:#ef4444;font-family:monospace;padding:40px"><h2>Render error</h2><pre>${String(e)}</pre><meta http-equiv="refresh" content="5"/></body></html>`;
            }
            res.writeHead(200,{"Content-Type":"text/html"});
            res.end(html);
        } catch(e) {
            try{res.writeHead(500);res.end("Server error");}catch(_){}
        }
    });

    server.on("error",err=>console.error("[cozy-bot] Dashboard error:",err));
    server.listen(port,"0.0.0.0",()=>console.log(`[cozy-bot] Dashboard running on port ${port}`));
}

module.exports = { startDashboard, addLog, state };
