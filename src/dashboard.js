"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const auth = require("./auth");

const CUSTOM_REPLIES_FILE   = path.join(__dirname, "../data/custom_replies.json");
const IMAGE_REPLIES_FILE    = path.join(__dirname, "../data/image_replies.json");
const BOT_CONFIG_FILE       = path.join(__dirname, "../data/bot_config.json");
const FBSTATE_FILE          = path.join(__dirname, "../data/fbstate.json");
const CUSTOM_COMMANDS_FILE  = path.join(__dirname, "../data/custom_commands.json");
const WHITELIST_FILE        = path.join(__dirname, "../data/whitelist.json");
const THREAD_CONFIG_FILE    = path.join(__dirname, "../data/thread_config.json");
const DATA_DIR              = path.join(__dirname, "../data");
const MAX_LOGS = 200;
const logs   = [];
const alerts = [];

let accountInfo = {};

function setAccountInfoForUser(data) { Object.assign(accountInfo, data); }

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
function addLog(type, message) {
    const entry = { time: new Date().toLocaleTimeString(), type, message };
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.pop();
}
function getUptime() {
    const ms = Date.now() - state.startedAt.getTime();
    const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
    if(d>0)return`${d}d ${h%24}h`;if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;
}
function esc(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function readCustomReplies()  { try{return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8"));}catch(_){return[];} }
function writeCustomReplies(a){ fs.writeFileSync(CUSTOM_REPLIES_FILE,JSON.stringify(a,null,2),"utf8"); }
function readImageReplies()   { try{return JSON.parse(fs.readFileSync(IMAGE_REPLIES_FILE,"utf8"));}catch(_){return[];} }
function writeImageReplies(a) { fs.writeFileSync(IMAGE_REPLIES_FILE,JSON.stringify(a,null,2),"utf8"); }
function readBotConfig() {
    try{return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE,"utf8"));}
    catch(_){return{loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false,silentMode:false,loopSilentMode:false,autoReactEnabled:false,autoReactEmoji:"😆"};}
}
function writeBotConfig(c)    { fs.writeFileSync(BOT_CONFIG_FILE,JSON.stringify(c,null,2),"utf8"); }
function readCustomCommands() { try{return JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE,"utf8"));}catch(_){return[];} }
function writeCustomCommands(a){ fs.writeFileSync(CUSTOM_COMMANDS_FILE,JSON.stringify(a,null,2),"utf8"); }
function readWhitelist()      { try{return JSON.parse(fs.readFileSync(WHITELIST_FILE,"utf8"));}catch(_){return{enabled:false,uids:[]};} }
function writeWhitelist(w)    { fs.writeFileSync(WHITELIST_FILE,JSON.stringify(w,null,2),"utf8"); }
function readThreadConfig()   { try{return JSON.parse(fs.readFileSync(THREAD_CONFIG_FILE,"utf8"));}catch(_){return {};} }
function writeThreadConfig(c) { fs.writeFileSync(THREAD_CONFIG_FILE,JSON.stringify(c,null,2),"utf8"); }
function getFbstateFiles() {
    try { return fs.readdirSync(DATA_DIR).filter(f=>/^fbstate.*\.json$/i.test(f)).sort(); }
    catch(_){ return ["fbstate.json"]; }
}
function resetAll() {
    logs.splice(0,logs.length); state.totalRepliesSent=0; state.startedAt=new Date();
    state.loopEnabled={}; state.autoRespondEnabled={}; state.mutedThreads={};
    state.bots=[]; state.botName=""; state.loginInProgress=true;
}
function parseBody(req) {
    return new Promise(resolve => {
        let raw="";
        req.on("data",c=>{raw+=c.toString();});
        req.on("end",()=>{
            const p={};
            raw.split("&").forEach(pair=>{
                const eqIdx=pair.indexOf("="); if(eqIdx===-1)return;
                try{const k=decodeURIComponent(pair.slice(0,eqIdx).replace(/\+/g," "));const v=decodeURIComponent(pair.slice(eqIdx+1).replace(/\+/g," "));p[k]=v;}catch(_){}
            });
            resolve(p);
        });
    });
}
function readRawBody(req) {
    return new Promise(resolve=>{let raw="";req.on("data",c=>{raw+=c.toString();});req.on("end",()=>resolve(raw));});
}
function getSessionFromReq(req) {
    const raw = req.headers.cookie || "";
    const match = raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);
    return match ? auth.getSession(match[1]) : null;
}
function getTokenFromReq(req) {
    const raw = req.headers.cookie || "";
    const match = raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);
    return match ? match[1] : null;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
:root{--bg:#080808;--bg2:#0d0d0d;--sidebar:#0f0f0f;--card:#141414;--card2:#1a1a1a;--border:#1e1e1e;--border2:#2a2a2a;--red:#dc2626;--red2:#ef4444;--red3:#f87171;--red-dim:#b91c1c;--rg:rgba(220,38,38,0.12);--rg2:rgba(220,38,38,0.22);--rg3:rgba(220,38,38,0.38);--white:#fff;--off:#e5e5e5;--gray:#737373;--gray2:#525252;--muted:#404040;--ok:#22c55e;--warn:#f59e0b;--info:#3b82f6;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--white);min-height:100vh;display:flex;overflow-x:hidden;}
::-webkit-scrollbar{width:4px;height:4px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}::-webkit-scrollbar-thumb:hover{background:var(--red);}
a{text-decoration:none;color:inherit;}

/* SIDEBAR */
.sb{width:250px;min-height:100vh;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100;transition:width .3s cubic-bezier(.4,0,.2,1);overflow:hidden;}
.sb.col{width:64px;}
.sb-top{padding:18px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;min-height:70px;flex-shrink:0;}
.sb-logo{width:36px;height:36px;background:var(--red);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 24px var(--rg3);}
.sb-brand{overflow:hidden;white-space:nowrap;transition:opacity .2s,width .3s;}
.sb.col .sb-brand{opacity:0;width:0;}
.sb-name{font-size:13px;font-weight:800;letter-spacing:.08em;color:var(--white);}
.sb-sub{font-size:9.5px;color:var(--gray);letter-spacing:.06em;margin-top:1px;}
.sb-tog{background:none;border:1px solid var(--border2);color:var(--gray);cursor:pointer;padding:7px 10px;border-radius:7px;margin:10px 8px;width:calc(100% - 16px);display:flex;align-items:center;justify-content:center;gap:8px;font-size:11px;font-family:inherit;transition:all .15s;}
.sb-tog:hover{border-color:var(--red);color:var(--red);}
.tog-lbl{white-space:nowrap;overflow:hidden;transition:opacity .2s,width .3s;}
.sb.col .tog-lbl{opacity:0;width:0;}
.sb-nav{flex:1;padding:8px;display:flex;flex-direction:column;gap:2px;overflow:hidden;}
.ni{display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:8px;color:var(--gray);text-decoration:none;transition:all .15s;white-space:nowrap;overflow:hidden;border:1px solid transparent;cursor:pointer;}
.ni:hover{background:var(--rg);color:var(--off);}
.ni.act{background:var(--rg2);color:var(--white);border-color:rgba(220,38,38,.3);}
.ni .ico{flex-shrink:0;color:inherit;}
.ni.act .ico{color:var(--red2);}
.ni .lbl{font-size:12.5px;font-weight:500;letter-spacing:.04em;transition:opacity .2s;}
.sb.col .ni .lbl{opacity:0;}
.ni-sep{height:1px;background:var(--border);margin:6px 8px;}
.sb-foot{padding:12px 8px;border-top:1px solid var(--border);flex-shrink:0;}
.u-pill{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;background:var(--card);border:1px solid var(--border);overflow:hidden;margin-bottom:8px;white-space:nowrap;}
.u-av{width:30px;height:30px;border-radius:50%;background:var(--red);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;}
.u-info{overflow:hidden;}
.u-name{font-size:12px;font-weight:600;color:var(--white);}
.u-role{font-size:10px;color:var(--gray);}
.sb.col .u-info{opacity:0;width:0;}
.lo-btn{width:100%;padding:9px 12px;background:none;border:1px solid var(--border2);border-radius:8px;color:var(--gray);cursor:pointer;font-size:11.5px;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .15s;}
.lo-btn:hover{border-color:#ef4444;color:#ef4444;background:rgba(239,68,68,.08);}
.sb.col .lo-lbl{opacity:0;width:0;overflow:hidden;}

/* MAIN */
.mw{margin-left:250px;flex:1;min-height:100vh;display:flex;flex-direction:column;transition:margin-left .3s cubic-bezier(.4,0,.2,1);}
.mw.col{margin-left:64px;}
.topbar{height:54px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 24px;gap:14px;background:rgba(8,8,8,.85);backdrop-filter:blur(10px);position:sticky;top:0;z-index:50;}
.tb-title{font-size:13px;font-weight:600;color:var(--gray);letter-spacing:.05em;}
.tb-title span{color:var(--white);}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:12px;}
.st-badge{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:500;border:1px solid;}
.st-on{border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.08);color:#22c55e;}
.st-off{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.08);color:#ef4444;}
.st-warn{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08);color:#f59e0b;}
.st-dot{width:6px;height:6px;border-radius:50%;background:currentColor;}
.st-on .st-dot{animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.mc{padding:24px;flex:1;}

/* INNER TABS */
.itabs{display:flex;gap:3px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:4px;margin-bottom:20px;flex-wrap:wrap;}
.itab{padding:8px 14px;border-radius:7px;font-size:12px;font-weight:500;color:var(--gray);cursor:pointer;text-decoration:none;transition:all .15s;display:flex;align-items:center;gap:7px;white-space:nowrap;}
.itab:hover{color:var(--off);background:rgba(255,255,255,.04);}
.itab.act{background:var(--red);color:#fff;}

/* STAT GRID */
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;}
.sc{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;position:relative;overflow:hidden;transition:border-color .2s;}
.sc:hover{border-color:var(--border2);}
.sc-glow{position:absolute;top:-20px;right:-20px;width:80px;height:80px;border-radius:50%;filter:blur(28px);opacity:.45;}
.gc-r{background:#dc2626;}.gc-w{background:#fff;}.gc-g{background:#6b7280;}.gc-o{background:#f59e0b;}
.sc-ico{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;}
.ci-r{background:rgba(220,38,38,.15);color:#ef4444;}.ci-w{background:rgba(255,255,255,.08);color:#e5e5e5;}.ci-g{background:rgba(107,114,128,.15);color:#9ca3af;}.ci-o{background:rgba(245,158,11,.15);color:#f59e0b;}
.sc-val{font-size:26px;font-weight:700;margin-bottom:4px;line-height:1;}
.sc-lbl{font-size:11.5px;color:var(--gray);font-weight:500;}
.sc-sub{font-size:10px;color:var(--gray2);}

/* HERO */
.hero{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:20px;position:relative;}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--red),var(--red2),transparent);}
.hero-in{padding:22px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.hero-l{display:flex;align-items:center;gap:16px;}
.hero-ic{width:48px;height:48px;background:linear-gradient(135deg,var(--red),var(--red-dim));border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px var(--rg3);flex-shrink:0;}
.hero-title{font-size:20px;font-weight:800;letter-spacing:-.01em;}
.hero-ver{font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;background:rgba(220,38,38,.15);color:var(--red2);margin-left:8px;vertical-align:middle;}
.hero-desc{font-size:12px;color:var(--gray);margin-top:4px;}
.hero-pills{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;}
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:500;}
.p-on{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.22);}
.p-off{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.22);}
.p-warn{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.22);}
.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;}

/* BOX */
.box{background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:16px;overflow:hidden;}
.bh{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}
.bt{font-size:13px;font-weight:600;color:var(--white);}
.bm{font-size:11px;color:var(--gray);margin-left:auto;}
.chip{font-size:9px;font-weight:700;letter-spacing:.1em;padding:3px 7px;border-radius:4px;background:rgba(220,38,38,.15);color:var(--red2);border:1px solid rgba(220,38,38,.25);}
.chip-g{background:rgba(34,197,94,.1);color:#22c55e;border-color:rgba(34,197,94,.2);}
.chip-y{background:rgba(245,158,11,.1);color:#f59e0b;border-color:rgba(245,158,11,.2);}
.chip-b{background:rgba(59,130,246,.1);color:#60a5fa;border-color:rgba(59,130,246,.2);}
.chip-p{background:rgba(168,85,247,.1);color:#c084fc;border-color:rgba(168,85,247,.2);}
.shd{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--gray);text-transform:uppercase;margin:20px 0 10px;}
.shd svg{color:var(--red);flex-shrink:0;}

/* TABLE */
table{width:100%;border-collapse:collapse;}
th{text-align:left;padding:10px 18px;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--gray);text-transform:uppercase;border-bottom:1px solid var(--border);}
td{padding:11px 18px;font-size:13px;border-bottom:1px solid var(--border);}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(255,255,255,.015);}
.td-m{font-family:'Courier New',monospace;font-size:11.5px;color:var(--gray);}
.td-e{text-align:center;color:var(--gray2);font-size:12px;padding:24px;}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10.5px;font-weight:600;letter-spacing:.05em;}
.tag-r{background:rgba(220,38,38,.15);color:#ef4444;}
.tag-g{background:rgba(34,197,94,.12);color:#22c55e;}
.tag-d{background:rgba(255,255,255,.05);color:var(--gray2);}
.tag-y{background:rgba(245,158,11,.12);color:#f59e0b;}
.tag-b{background:rgba(59,130,246,.1);color:#60a5fa;}

/* LOG */
.la{max-height:280px;overflow-y:auto;font-family:'Courier New',monospace;font-size:11.5px;}
.lr{display:grid;grid-template-columns:70px 44px 1fr;gap:8px;align-items:center;padding:6px 16px;border-bottom:1px solid rgba(255,255,255,.03);}
.lr:hover{background:rgba(255,255,255,.02);}
.lt{color:var(--gray2);}
.ll{font-weight:700;font-size:10px;letter-spacing:.08em;}
.lr-error .ll{color:#ef4444;}.lr-warn .ll{color:#f59e0b;}.lr-reply .ll{color:#22c55e;}.lr-info .ll{color:#60a5fa;}.lr-idle .ll{color:var(--gray2);}
.lm{color:var(--off);}
.lr-error .lm{color:#fca5a5;}.lr-warn .lm{color:#fde68a;}

/* FORMS */
.fld{margin-bottom:16px;}
.flbl{display:block;font-size:11.5px;font-weight:500;color:var(--gray);margin-bottom:6px;letter-spacing:.04em;}
.fi,.fs{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:8px;padding:9px 12px;color:var(--white);font-size:13px;font-family:inherit;transition:border-color .15s;outline:none;}
.fi:focus,.fs:focus{border-color:var(--red);box-shadow:0 0 0 2px var(--rg2);}
.fhint{font-size:11px;color:var(--gray2);margin-top:4px;}
.fs{appearance:none;}
.tr-row{display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer;font-size:13px;color:var(--off);}
.tck{display:none;}
.ttr{width:36px;height:20px;border-radius:10px;background:var(--border2);position:relative;transition:background .2s;flex-shrink:0;}
.tth{width:14px;height:14px;background:var(--white);border-radius:50%;position:absolute;top:3px;left:3px;transition:transform .2s;}
.tck:checked+.ttr{background:var(--red);}
.tck:checked+.ttr .tth{transform:translateX(16px);}
.btn{padding:9px 18px;border-radius:8px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;transition:all .15s;border:1px solid transparent;display:inline-flex;align-items:center;gap:8px;}
.btn-r{background:var(--red);color:#fff;border:none;}
.btn-r:hover{background:var(--red2);}
.btn-o{background:transparent;border-color:var(--border2);color:var(--gray);}
.btn-o:hover{border-color:var(--red);color:var(--red);}
.btn-sm{padding:6px 12px;font-size:11.5px;}
.btn-xs{padding:4px 9px;font-size:11px;}
.btn-danger{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444;}
.btn-danger:hover{background:rgba(239,68,68,.22);}
.add-row{display:flex;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border);}
.ai{flex:1;background:var(--bg);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;color:var(--white);font-size:13px;font-family:inherit;outline:none;}
.ai:focus{border-color:var(--red);}
.btn-a{background:var(--red);border:none;color:#fff;padding:8px 16px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;}
.btn-a:hover{background:var(--red2);}
.btn-rm{background:none;border:1px solid var(--border2);color:var(--gray2);width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:12px;transition:all .15s;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.btn-rm:hover{border-color:#ef4444;color:#ef4444;background:rgba(239,68,68,.08);}
.ql{padding:8px 16px;display:flex;flex-direction:column;gap:4px;}
.qi{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:var(--bg2);border:1px solid var(--border);}
.qn{font-size:10.5px;font-weight:700;color:var(--red);width:22px;flex-shrink:0;}
.qt{flex:1;font-size:12.5px;color:var(--off);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qu{font-family:monospace;font-size:11px;color:var(--gray);}
.qe{text-align:center;color:var(--gray2);font-size:12px;padding:24px 0;}

/* GRAPH */
.rg{display:flex;align-items:flex-end;gap:3px;height:80px;padding:0 4px;}
.rc{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;}
.rbw{flex:1;display:flex;align-items:flex-end;width:100%;}
.rb{width:100%;min-height:2px;background:linear-gradient(180deg,var(--red2),var(--red-dim));border-radius:3px 3px 0 0;transition:height .3s;}
.rl{font-size:8px;color:var(--gray2);white-space:nowrap;}

/* TWO COL */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;}

/* CFG */
.cb{padding:16px 18px;}
.cfg-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px;}
.cfg-tab{padding:7px 14px;border-radius:7px;border:1px solid var(--border2);background:none;color:var(--gray);font-size:12px;font-family:inherit;cursor:pointer;transition:all .15s;}
.cfg-tab:hover{border-color:var(--red);color:var(--red);}
.cfg-tab.active{background:var(--red);border-color:var(--red);color:#fff;}
.cc{display:none;}.cc.act{display:block;}
.save-bar{display:flex;justify-content:flex-end;padding:16px 18px;border-top:1px solid var(--border);}

/* COOKIE */
.ck-wrap{max-width:620px;margin:0 auto;text-align:center;padding:32px 20px;}
.ck-title{font-size:26px;font-weight:800;margin-bottom:8px;}
.ck-title span{color:var(--red2);}
.ck-desc{color:var(--gray);font-size:13.5px;line-height:1.6;margin-bottom:28px;}
.steps-g{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px;}
.step{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:left;}
.snum{width:22px;height:22px;border-radius:6px;background:var(--red);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-bottom:8px;}
.stxt{font-size:12px;color:var(--off);line-height:1.5;}
.stxt b{color:var(--white);}
.ck-ta{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:10px;padding:12px;color:var(--gray);font-family:monospace;font-size:11.5px;line-height:1.6;min-height:110px;resize:vertical;outline:none;margin-bottom:14px;transition:border-color .15s;}
.ck-ta:focus{border-color:var(--red);color:var(--off);}
.ck-ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:8px;padding:10px 14px;font-size:12.5px;color:#22c55e;display:flex;align-items:center;gap:8px;margin-bottom:16px;text-align:left;}
.conn-btn{width:100%;padding:13px;background:linear-gradient(135deg,var(--red),var(--red-dim));border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;letter-spacing:.05em;cursor:pointer;font-family:inherit;transition:all .2s;box-shadow:0 4px 20px var(--rg3);display:flex;align-items:center;justify-content:center;gap:10px;}
.conn-btn:hover{transform:translateY(-1px);box-shadow:0 6px 28px var(--rg3);}
.skip-btn{background:none;border:1px solid var(--border2);color:var(--gray);padding:8px 18px;border-radius:8px;cursor:pointer;font-size:12.5px;font-family:inherit;margin-top:10px;transition:all .15s;}
.skip-btn:hover{border-color:var(--red);color:var(--red);}
.ck-note{font-size:11px;color:var(--gray2);margin-top:10px;}

/* ACCOUNT STATUS */
.acg{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
.ac{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;transition:border-color .2s;position:relative;overflow:hidden;}
.ac::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--red);border-radius:3px 0 0 3px;}
.ac:hover{border-color:var(--border2);}
.ac-lbl{font-size:10px;font-weight:700;letter-spacing:.1em;color:var(--gray);text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px;}
.ac-lbl svg{color:var(--red);}
.ac-val{font-size:20px;font-weight:700;color:var(--white);}
.ac-sub{font-size:11.5px;color:var(--gray);margin-top:3px;}
.ac-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.22);}
.ac-badge-r{background:rgba(220,38,38,.1);color:#ef4444;border-color:rgba(220,38,38,.22);}

/* ABOUT */
.ab-wrap{max-width:700px;}
.ab-hero{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:32px;margin-bottom:16px;position:relative;overflow:hidden;}
.ab-hero::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--red),var(--red2));}
.ab-name{font-size:22px;font-weight:800;margin-bottom:4px;}
.ab-role{font-size:13px;color:var(--red2);font-weight:600;margin-bottom:16px;}
.ab-txt{font-size:14px;color:#c4c4c4;line-height:1.8;}
.ab-contact{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;}
.ab-ct-title{font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--gray);text-transform:uppercase;margin-bottom:12px;}
.ct-item{display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;}
.ct-item:last-child{margin-bottom:0;}
.ct-ico{width:32px;height:32px;border-radius:8px;background:rgba(220,38,38,.12);display:flex;align-items:center;justify-content:center;color:var(--red2);flex-shrink:0;}
.ct-val{font-size:13px;color:var(--off);font-weight:500;}
.ct-hint{font-size:11px;color:var(--gray);}

/* ADMIN */
.adm-banner{background:linear-gradient(135deg,rgba(220,38,38,.14),rgba(185,28,28,.04));border:1px solid rgba(220,38,38,.28);border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:14px;margin-bottom:20px;}
.adm-ic{width:40px;height:40px;border-radius:10px;background:var(--red);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.adm-title{font-size:15px;font-weight:700;}
.adm-sub{font-size:12px;color:var(--gray);}

/* AUTH PAGES */
.auth-pg{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);background-image:radial-gradient(ellipse at 30% 20%,rgba(220,38,38,.07) 0%,transparent 60%),radial-gradient(ellipse at 70% 80%,rgba(220,38,38,.04) 0%,transparent 60%);}
.auth-card{width:420px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:40px;position:relative;overflow:hidden;}
.auth-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--red),var(--red2),transparent);}
.auth-logo{display:flex;align-items:center;gap:12px;margin-bottom:28px;}
.auth-li{width:42px;height:42px;background:linear-gradient(135deg,var(--red),var(--red-dim));border-radius:11px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px var(--rg3);}
.auth-lt{font-size:18px;font-weight:800;letter-spacing:.04em;}
.auth-ls{font-size:11px;color:var(--gray);margin-top:1px;}
.auth-h{font-size:18px;font-weight:700;margin-bottom:6px;}
.auth-s{font-size:13px;color:var(--gray);margin-bottom:24px;line-height:1.5;}
.af{margin-bottom:14px;}
.al{display:block;font-size:11.5px;font-weight:500;color:var(--gray);margin-bottom:6px;letter-spacing:.04em;}
.ain{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:10px;padding:11px 14px;color:var(--white);font-size:14px;font-family:inherit;outline:none;transition:all .15s;}
.ain:focus{border-color:var(--red);box-shadow:0 0 0 3px var(--rg);}
.ain::placeholder{color:var(--gray2);}
.asub{width:100%;padding:13px;background:linear-gradient(135deg,var(--red),var(--red-dim));border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;letter-spacing:.04em;cursor:pointer;font-family:inherit;margin-top:6px;transition:all .2s;box-shadow:0 4px 20px var(--rg2);}
.asub:hover{transform:translateY(-1px);box-shadow:0 6px 28px var(--rg3);}
.afoot{text-align:center;margin-top:18px;font-size:13px;color:var(--gray);}
.afoot a{color:var(--red2);font-weight:500;}
.afoot a:hover{color:var(--red3);}
.aerr{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:10px 14px;font-size:13px;color:#fca5a5;margin-bottom:16px;display:flex;align-items:center;gap:8px;}

@media(max-width:900px){.sg{grid-template-columns:1fr 1fr;}.two-col{grid-template-columns:1fr;}.acg{grid-template-columns:1fr;}}
@media(max-width:640px){.sb{width:64px;}.sb .sb-brand,.sb .ni .lbl,.sb .lo-lbl,.sb .u-info,.sb .tog-lbl{opacity:0;width:0;}.mw{margin-left:64px;}.sg{grid-template-columns:1fr;}.steps-g{grid-template-columns:1fr;}.auth-card{width:calc(100vw - 32px);padding:28px 20px;}}
`;

// ─── SVG ICONS ────────────────────────────────────────────────────────────────
const I = {
    dash:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`,
    user:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
    info:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>`,
    lock:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    loop:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
    chat:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    cog:     `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    cmd:     `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    logout:  `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
    shield:  `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    bell:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    heart:   `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    globe:   `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    id:      `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    friends: `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    msg:     `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    clock:   `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    bot:     `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/></svg>`,
    admin:   `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
function buildLoginPage(err) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DUMMYL BOT — Login</title><style>${CSS}</style></head><body>
<div class="auth-pg">
<div class="auth-card">
<div class="auth-logo">
  <div class="auth-li">${I.bot}</div>
  <div><div class="auth-lt">DUMMYL BOT</div><div class="auth-ls">Messenger Automation Platform</div></div>
</div>
<h1 class="auth-h">Welcome back</h1>
<p class="auth-s">Sign in to access your bot dashboard.</p>
${err?`<div class="aerr"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${esc(err)}</div>`:""}
<form method="POST" action="/api/auth/login">
  <div class="af"><label class="al">EMAIL ADDRESS</label><input class="ain" type="email" name="email" placeholder="you@example.com" required autocomplete="email"/></div>
  <div class="af"><label class="al">PASSWORD</label><input class="ain" type="password" name="password" placeholder="••••••••" required autocomplete="current-password"/></div>
  <button class="asub" type="submit">Sign In</button>
</form>
<div class="afoot">Don't have an account? <a href="/register">Create one</a></div>
</div>
</div>
</body></html>`;
}

// ─── REGISTER PAGE ────────────────────────────────────────────────────────────
function buildRegisterPage(err) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DUMMYL BOT — Register</title><style>${CSS}</style></head><body>
<div class="auth-pg">
<div class="auth-card">
<div class="auth-logo">
  <div class="auth-li">${I.bot}</div>
  <div><div class="auth-lt">DUMMYL BOT</div><div class="auth-ls">Messenger Automation Platform</div></div>
</div>
<h1 class="auth-h">Create account</h1>
<p class="auth-s">Join to manage your Facebook Messenger bot.</p>
${err?`<div class="aerr"><svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${esc(err)}</div>`:""}
<form method="POST" action="/api/auth/register">
  <div class="af"><label class="al">USERNAME</label><input class="ain" type="text" name="username" placeholder="Your name" required autocomplete="name"/></div>
  <div class="af"><label class="al">EMAIL ADDRESS</label><input class="ain" type="email" name="email" placeholder="you@example.com" required autocomplete="email"/></div>
  <div class="af"><label class="al">PASSWORD</label><input class="ain" type="password" name="password" placeholder="Min. 6 characters" required autocomplete="new-password"/></div>
  <div class="af"><label class="al">CONFIRM PASSWORD</label><input class="ain" type="password" name="confirm" placeholder="Repeat password" required autocomplete="new-password"/></div>
  <button class="asub" type="submit">Create Account</button>
</form>
<div class="afoot">Already have an account? <a href="/login">Sign in</a></div>
</div>
</div>
</body></html>`;
}

// ─── LAYOUT SHELL ─────────────────────────────────────────────────────────────
function buildLayout(session, mainTab, innerContent) {
    const isOn   = state.loggedIn;
    const isRecon= state.reconnecting;
    const stCls  = isOn?"st-on":(isRecon?"st-warn":"st-off");
    const stLbl  = isOn?"Online":(isRecon?"Reconnecting":"Offline");
    const nav = (id, icon, label) =>
        `<a class="ni${mainTab===id?" act":""}" href="/?tab=${id}">${icon}<span class="lbl">${label}</span></a>`;
    const initials = (session.username||"U").slice(0,2).toUpperCase();
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DUMMYL BOT</title><style>${CSS}</style></head><body>
<div class="sb" id="sb">
  <div class="sb-top">
    <div class="sb-logo"><svg width="20" height="20" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/></svg></div>
    <div class="sb-brand"><div class="sb-name">DUMMYL BOT</div><div class="sb-sub">v2.2 PLATFORM</div></div>
  </div>
  <button class="sb-tog" onclick="toggleSb()">
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    <span class="tog-lbl">Collapse</span>
  </button>
  <nav class="sb-nav">
    ${nav("dashboard", I.dash, "DASHBOARD")}
    ${nav("account",   I.user, "ACCOUNT STATUS")}
    ${nav("about",     I.info, "ABOUT")}
    ${session.isAdmin?`<div class="ni-sep"></div>${nav("admin", I.shield, "ADMIN PANEL")}`:""}
  </nav>
  <div class="sb-foot">
    <div class="u-pill">
      <div class="u-av">${esc(initials)}</div>
      <div class="u-info"><div class="u-name">${esc(session.username||"User")}</div><div class="u-role">${session.isAdmin?"Administrator":"Member"}</div></div>
    </div>
    <form method="POST" action="/api/auth/logout">
      <button class="lo-btn" type="submit">${I.logout}<span class="lo-lbl">Sign Out</span></button>
    </form>
  </div>
</div>
<div class="mw" id="mw">
  <div class="topbar">
    <svg width="14" height="14" fill="none" stroke="var(--gray)" stroke-width="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    <span class="tb-title">DUMMYL BOT &rsaquo; <span>${mainTab==="dashboard"?"Dashboard":mainTab==="account"?"Account Status":mainTab==="about"?"About":mainTab==="admin"?"Admin Panel":"Dashboard"}</span></span>
    <div class="tb-right">
      <div class="st-badge ${stCls}"><div class="st-dot"></div>${stLbl}${state.botName?` — ${esc(state.botName)}`:""}</div>
    </div>
  </div>
  <div class="mc">${innerContent}</div>
</div>
<script>
function toggleSb(){var s=document.getElementById('sb'),m=document.getElementById('mw');s.classList.toggle('col');m.classList.toggle('col');localStorage.setItem('sb_col',s.classList.contains('col')?'1':'0');}
(function(){if(localStorage.getItem('sb_col')==='1'){document.getElementById('sb').classList.add('col');document.getElementById('mw').classList.add('col');}})();
function showCfg(id,btn){document.querySelectorAll('.cc').forEach(e=>e.classList.remove('act'));document.querySelectorAll('.cfg-tab').forEach(e=>e.classList.remove('active'));document.getElementById('cc-'+id).classList.add('act');btn.classList.add('active');}
function showCat(id,btn){document.querySelectorAll('.cc').forEach(e=>e.classList.remove('act'));document.querySelectorAll('.cfg-tab').forEach(e=>e.classList.remove('active'));document.getElementById('cc-'+id).classList.add('act');btn.classList.add('active');}
</script>
</body></html>`;
}

// ─── DASHBOARD TAB ────────────────────────────────────────────────────────────
function buildDashboardContent(innerTab) {
    const itab = innerTab || "overview";
    const threads      = Object.keys({...state.loopEnabled,...state.autoRespondEnabled});
    const uniqueThreads= [...new Set(threads)];
    const loopCount    = Object.values(state.loopEnabled||{}).filter(Boolean).length;
    const arCount      = Object.values(state.autoRespondEnabled||{}).filter(Boolean).length;
    const mutedCount   = Object.values(state.mutedThreads||{}).filter(Boolean).length;
    const cfg          = readBotConfig();
    const customReplies= readCustomReplies();
    const imageReplies = readImageReplies();
    const customCmds   = readCustomCommands();
    const whitelist    = readWhitelist();
    const threadCfg    = readThreadConfig();
    const hasFbstate   = (()=>{try{const d=JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8"));return Array.isArray(d)&&d.length>0;}catch(_){return false;}})();

    const INNER_TABS = [
        {id:"overview",  label:"Overview",     icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`},
        {id:"loop",      label:"Loop Queue",   icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`},
        {id:"threads",   label:"Threads",      icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`},
        {id:"config",    label:"Config",       icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`},
        {id:"cookie",    label:"Cookie",       icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`},
        {id:"cmds",      label:"Custom Cmds",  icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`},
        {id:"commands",  label:"Commands",     icon: `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`},
    ];

    const tabBar = `<div class="itabs">${INNER_TABS.map(t=>`<a class="itab${itab===t.id?" act":""}" href="/?tab=dashboard&itab=${t.id}">${t.icon} ${t.label}</a>`).join("")}</div>`;

    const botPills = state.bots.length===0
        ? `<span class="pill p-off"><i></i>No bots loaded</span>`
        : state.bots.map(b=>{const cls=b.loggedIn?"p-on":(b.reconnecting?"p-warn":"p-off");const lbl=b.loggedIn?"Online":(b.reconnecting?`Reconnecting ${b.nextReconnectIn}s`:"Offline");return `<span class="pill ${cls}"><i></i>${esc(b.label)} — ${lbl}</span>`;}).join("");
    const logRows = logs.length===0
        ? `<div class="lr lr-idle"><span class="lt">--:--</span><span class="ll">IDLE</span><span class="lm">Waiting for events…</span></div>`
        : logs.slice(0,120).map(l=>`<div class="lr lr-${l.type}"><span class="lt">${esc(l.time)}</span><span class="ll">${{error:"ERR",warn:"WARN",reply:"OUT",info:"INFO"}[l.type]||"INFO"}</span><span class="lm">${esc(l.message)}</span></div>`).join("");

    // OVERVIEW
    const pageOverview = `
<div class="hero">
<div class="hero-in">
<div class="hero-l">
<div class="hero-ic">${I.bot}</div>
<div>
  <div class="hero-title">DUMMYL BOT <span class="hero-ver">v2.2</span></div>
  <div class="hero-desc">loop · auto-respond · lock · pm-loop · tts · song player · group tools</div>
  <div class="hero-pills">${botPills}</div>
</div>
</div>
</div>
</div>
<div class="sg">
<div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><div class="sc-val">${state.totalRepliesSent}</div><div class="sc-lbl">Messages Sent</div></div>
<div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div><div class="sc-val">${loopCount}</div><div class="sc-lbl">Active Loops</div></div>
<div class="sc"><div class="sc-glow gc-g"></div><div class="sc-ico ci-g"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg></div><div class="sc-val">${arCount}</div><div class="sc-lbl">Auto-Respond <span class="sc-sub">${mutedCount} muted</span></div></div>
<div class="sc"><div class="sc-glow gc-o"></div><div class="sc-ico ci-o"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="sc-val" style="font-size:20px">${getUptime()}</div><div class="sc-lbl">Uptime</div></div>
</div>
<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Message Rate (Last 24h)</div>
<div class="box" style="padding:14px 16px">
  <div class="bh" style="border:none;padding:0 0 10px"><span class="chip">GRAPH</span><span class="bt">Hourly Volume</span></div>
  <div class="rg">${(()=>{const b=getHourlyStats();const mx=Math.max(...b,1);return b.map((v,i)=>{const pct=Math.round((v/mx)*100);const hr=(new Date().getHours()-23+i+24)%24;const label=`${String(hr).padStart(2,"0")}:00`;return `<div class="rc"><div class="rbw"><div class="rb" style="height:${pct}%" title="${v} msgs at ${label}"></div></div><div class="rl">${hr%6===0?label:""}</div></div>`;}).join("")})()}</div>
</div>
<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Thread Registry</div>
<div class="box">
  <div class="bh"><span class="chip chip-g">LIVE</span><span class="bt">Active Threads</span><span class="bm">${uniqueThreads.length} registered</span></div>
  <table><thead><tr><th>Thread ID</th><th>Loop</th><th>Auto-Respond</th></tr></thead><tbody>${uniqueThreads.length===0?`<tr><td colspan="3" class="td-e">No threads yet — send <code>.</code> in Messenger to start a loop</td></tr>`:uniqueThreads.map(tid=>{const loop=state.loopEnabled&&state.loopEnabled[tid];const ar=state.autoRespondEnabled&&state.autoRespondEnabled[tid];const muted=state.mutedThreads&&state.mutedThreads[tid];return `<tr><td class="td-m">${esc(tid)}</td><td>${loop?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td><td>${ar?`<span class="tag tag-b">ON</span>`:`<span class="tag tag-d">OFF</span>`}${muted?` <span class="tag tag-y">MUTED</span>`:""}</td></tr>`;}).join("")}</tbody></table>
</div>
${alerts.length>0?`<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Notification Feed</div>
<div class="box" style="padding:0"><div class="bh"><span class="chip chip-y">ALERTS</span><span class="bt">Recent Events</span><span class="bm">${alerts.length}</span></div><div class="la">${alerts.map(a=>`<div class="lr lr-${a.type==="error"?"error":a.type==="warn"?"warn":"info"}"><span class="lt">${esc(a.time)}</span><span class="ll">${a.type.toUpperCase()}</span><span class="lm">${esc(a.message)}</span></div>`).join("")}</div></div>`:""}
<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Live Console</div>
<div class="box" style="padding:0"><div class="bh"><span class="chip">LOG</span><span class="bt">Real-time Events</span><span class="bm">${logs.length} entries</span></div><div class="la">${logRows}</div></div>`;

    // LOOP QUEUE
    const textRows = customReplies.length===0?`<div class="qe">Queue empty — add a message above</div>`:customReplies.map((w,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt">${esc(w)}</span><form method="POST" action="/api/replies/remove?tab=dashboard&itab=loop" style="margin:0"><input type="hidden" name="index" value="${i}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("");
    const imgRows  = imageReplies.length===0?`<div class="qe">No image URLs yet</div>`:imageReplies.map((u,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt qu">${esc(u)}</span><form method="POST" action="/api/images/remove?tab=dashboard&itab=loop" style="margin:0"><input type="hidden" name="index" value="${i}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("");
    const pageLoop = `<div class="two-col">
<div><div class="shd">${I.loop} Text Pool</div><div class="box"><div class="bh"><span class="chip">QUEUE</span><span class="bt">Loop Messages</span><span class="bm">${customReplies.length}</span></div><form class="add-row" method="POST" action="/api/replies/add?tab=dashboard&itab=loop"><input class="ai" type="text" name="word" placeholder="Add message to loop pool…" required/><button class="btn-a" type="submit">+ Add</button></form><div class="ql">${textRows}</div></div></div>
<div><div class="shd">${I.globe} Image Pool</div><div class="box"><div class="bh"><span class="chip chip-p">IMAGES</span><span class="bt">Image URLs</span><span class="bm">${imageReplies.length}</span></div><form class="add-row" method="POST" action="/api/images/add?tab=dashboard&itab=loop"><input class="ai" type="url" name="url" placeholder="https://example.com/image.jpg" required/><button class="btn-a" type="submit">+ Add</button></form><div class="ql">${imgRows}</div></div></div>
</div>`;

    // THREADS
    const allThreads = [...new Set(Object.keys({...state.loopEnabled,...state.autoRespondEnabled,...(readThreadConfig()||{})}))] ;
    const pageThreads = `
<div class="bh" style="padding:0 0 12px;background:none;border:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
  <form method="POST" action="/api/thread/stopall?tab=dashboard&itab=threads"><button class="btn btn-danger btn-sm" type="submit">Stop All Loops</button></form>
  <span style="font-size:12px;color:var(--gray)">${allThreads.length} known threads</span>
  ${whitelist.enabled?`<span class="tag tag-y">WHITELIST ON</span>`:`<span class="tag tag-d">WHITELIST OFF</span>`}
  <form method="POST" action="/api/whitelist/toggle?tab=dashboard&itab=threads" style="margin:0"><button class="btn btn-o btn-sm" type="submit">${whitelist.enabled?"Disable":"Enable"} Whitelist</button></form>
</div>
<div class="box"><div class="bh"><span class="chip">THREADS</span><span class="bt">Thread Manager</span></div>
<table><thead><tr><th>Thread ID</th><th>Loop</th><th>Auto-Respond</th><th>Actions</th></tr></thead><tbody>
${allThreads.length===0?`<tr><td colspan="4" class="td-e">No threads detected yet</td></tr>`:allThreads.map(tid=>{
    const loop=state.loopEnabled&&state.loopEnabled[tid];
    const ar=state.autoRespondEnabled&&state.autoRespondEnabled[tid];
    return `<tr><td class="td-m">${esc(tid)}</td><td>${loop?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td><td>${ar?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td><td style="display:flex;gap:6px;">
<form method="POST" action="/api/thread/${loop?"stoploop":"startloop"}?tab=dashboard&itab=threads" style="margin:0"><input type="hidden" name="threadID" value="${esc(tid)}"/><button class="btn btn-o btn-xs">${loop?"Stop":"Start"} Loop</button></form>
</td></tr>`;}).join("")}
</tbody></table></div>
<div class="shd">${I.shield} Whitelist UIDs</div>
<div class="box"><div class="bh"><span class="chip">${whitelist.enabled?"ACTIVE":"INACTIVE"}</span><span class="bt">Allowed UIDs</span><span class="bm">${(whitelist.uids||[]).length} UIDs</span></div>
<form class="add-row" method="POST" action="/api/whitelist/add?tab=dashboard&itab=threads"><input class="ai" type="text" name="uid" placeholder="Facebook UID to whitelist…" required/><button class="btn-a" type="submit">+ Add</button></form>
<div class="ql">${(whitelist.uids||[]).length===0?`<div class="qe">No UIDs whitelisted</div>`:(whitelist.uids||[]).map((uid,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt qu">${esc(uid)}</span><form method="POST" action="/api/whitelist/remove?tab=dashboard&itab=threads" style="margin:0"><input type="hidden" name="uid" value="${esc(uid)}"/><button class="btn-rm">✕</button></form></div>`).join("")}</div>
</div>`;

    // CONFIG
    const pageConfig = `
<div class="cfg-tabs" id="cfgTabs">
  <button class="cfg-tab active" onclick="showCat('loop',this)">Loop</button>
  <button class="cfg-tab" onclick="showCat('ar',this)">Auto-Respond</button>
  <button class="cfg-tab" onclick="showCat('react',this)">Auto-React</button>
  <button class="cfg-tab" onclick="showCat('silent',this)">Silent Mode</button>
  <button class="cfg-tab" onclick="showCat('sec',this)">Security</button>
  <button class="cfg-tab" onclick="showCat('voice',this)">Voice / TTS</button>
</div>
<form method="POST" action="/api/config/save?tab=dashboard&itab=config">
<div class="cc act" id="cc-loop"><div class="two-col">
<div><div class="shd">${I.loop} Loop Engine</div><div class="box"><div class="bh"><span class="chip">LOOP</span><span class="bt">Dot Trigger</span></div><div class="cb">
<div class="fld"><label class="flbl">Reaction Emoji</label><input class="fi" type="text" name="loopReact" value="${esc(cfg.loopReact||'😆')}" maxlength="8"/></div>
<div class="fld"><label class="flbl">Delay (seconds)</label><input class="fi" type="number" name="loopDelay" value="${cfg.loopDelay||1}" min="1" max="300"/></div>
<div class="fld"><label class="flbl">Image Chance (%)</label><input class="fi" type="number" name="imageProbability" value="${cfg.imageProbability||20}" min="0" max="100"/></div>
<div class="fld"><label class="flbl">Loop Mode</label><select class="fs" name="loopMode"><option value="sequential" ${cfg.loopMode==="sequential"?"selected":""}>Sequential</option><option value="shuffle" ${cfg.loopMode==="shuffle"?"selected":""}>Shuffle</option></select></div>
<div class="fld"><label class="flbl">Max Messages (0=unlimited)</label><input class="fi" type="number" name="maxLoopCount" value="${cfg.maxLoopCount||0}" min="0"/></div>
<div class="fld"><label class="flbl">Auto-Stop (min, 0=off)</label><input class="fi" type="number" name="autoStopMinutes" value="${cfg.autoStopMinutes||0}" min="0"/></div>
<div class="fld"><label class="flbl">Start Message</label><input class="fi" type="text" name="loopStartMsg" value="${esc(cfg.loopStartMsg||'')}" placeholder="Sent when loop starts"/></div>
<div class="fld"><label class="flbl">Stop Message</label><input class="fi" type="text" name="loopStopMsg" value="${esc(cfg.loopStopMsg||'')}" placeholder="Sent when loop stops"/></div>
<label class="tr-row"><input class="tck" type="checkbox" name="reactOnlyMode" value="1" ${cfg.reactOnlyMode?"checked":""}><span class="ttr"><span class="tth"></span></span>React-only mode</label>
</div></div></div>
<div><div class="shd">${I.bell} Greet Members</div><div class="box"><div class="bh"><span class="chip">GREET</span><span class="bt">Join Event</span></div><div class="cb">
<label class="tr-row"><input class="tck" type="checkbox" name="greetNewMembers" value="1" ${cfg.greetNewMembers?"checked":""}><span class="ttr"><span class="tth"></span></span>Greet new members</label>
<div class="fld" style="margin-top:12px"><label class="flbl">Greet Message</label><input class="fi" type="text" name="greetMsg" value="${esc(cfg.greetMsg||'Welcome!')}"/></div>
</div></div></div>
</div></div>
<div class="cc" id="cc-ar"><div class="shd">${I.chat} Auto-Respond</div><div class="box"><div class="bh"><span class="chip">AUTO</span><span class="bt">Auto-Respond Settings</span></div><div class="cb">
<label class="tr-row"><input class="tck" type="checkbox" name="autoSeenEnabled" value="1" ${cfg.autoSeenEnabled?"checked":""}><span class="ttr"><span class="tth"></span></span>Auto-mark as seen</label>
<label class="tr-row"><input class="tck" type="checkbox" name="typingSimulate" value="1" ${cfg.typingSimulate?"checked":""}><span class="ttr"><span class="tth"></span></span>Simulate typing</label>
</div></div></div>
<div class="cc" id="cc-react"><div class="shd">${I.heart} Auto-React</div><div class="box"><div class="bh"><span class="chip">REACT</span><span class="bt">Auto-React Settings</span></div><div class="cb">
<label class="tr-row"><input class="tck" type="checkbox" name="autoReactEnabled" value="1" ${cfg.autoReactEnabled?"checked":""}><span class="ttr"><span class="tth"></span></span>Enable auto-react</label>
<div class="fld" style="margin-top:12px"><label class="flbl">React Emoji</label><input class="fi" type="text" name="autoReactEmoji" value="${esc(cfg.autoReactEmoji||'😆')}" maxlength="8"/></div>
</div></div></div>
<div class="cc" id="cc-silent"><div class="shd">Silent Mode</div><div class="box"><div class="bh"><span class="chip">SILENT</span><span class="bt">Silent Options</span></div><div class="cb">
<label class="tr-row"><input class="tck" type="checkbox" name="silentMode" value="1" ${cfg.silentMode?"checked":""}><span class="ttr"><span class="tth"></span></span>Silent auto-respond</label>
<label class="tr-row"><input class="tck" type="checkbox" name="loopSilentMode" value="1" ${cfg.loopSilentMode?"checked":""}><span class="ttr"><span class="tth"></span></span>Silent loop messages</label>
</div></div></div>
<div class="cc" id="cc-sec"><div class="shd">${I.shield} Anti-Spam</div><div class="box"><div class="bh"><span class="chip">SECURITY</span><span class="bt">Anti-Spam Settings</span></div><div class="cb">
<label class="tr-row"><input class="tck" type="checkbox" name="antiSpamEnabled" value="1" ${cfg.antiSpamEnabled?"checked":""}><span class="ttr"><span class="tth"></span></span>Enable anti-spam</label>
<div class="fld" style="margin-top:12px"><label class="flbl">Max Messages</label><input class="fi" type="number" name="antiSpamMaxMsg" value="${cfg.antiSpamMaxMsg||5}" min="1" max="100"/></div>
<div class="fld"><label class="flbl">Time Window (sec)</label><input class="fi" type="number" name="antiSpamWindowSec" value="${cfg.antiSpamWindowSec||10}" min="1" max="300"/></div>
</div></div></div>
<div class="cc" id="cc-voice"><div class="shd">${I.msg} Voice / TTS</div><div class="box"><div class="bh"><span class="chip">TTS</span><span class="bt">Voice Settings</span></div><div class="cb">
<div class="fld"><label class="flbl">TTS Language</label><select class="fs" name="ttsLang"><option value="tl" ${cfg.ttsLang==="tl"?"selected":""}>Filipino (tl)</option><option value="en" ${cfg.ttsLang==="en"?"selected":""}>English (en)</option><option value="ja" ${cfg.ttsLang==="ja"?"selected":""}>Japanese (ja)</option><option value="ko" ${cfg.ttsLang==="ko"?"selected":""}>Korean (ko)</option></select></div>
</div></div></div>
<div class="save-bar"><button class="btn btn-r" type="submit">Save Configuration</button></div>
</form>`;

    // COOKIE
    const hasFb = hasFbstate;
    const fbFiles = getFbstateFiles();
    const pageCookie = `<div class="ck-wrap">
<div style="text-align:center;margin-bottom:32px">
  <div class="sc-ico ci-r" style="width:56px;height:56px;border-radius:14px;margin:0 auto 16px">${I.lock}</div>
  <h2 class="ck-title">Enter Your <span>Cookie</span></h2>
  <p class="ck-desc">Paste your Facebook fbstate JSON to connect the bot. Your cookie stays on this server.</p>
</div>
${hasFb?`<div class="ck-ok"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Cookie saved — bot is connecting. You can replace it below.</div>`:""}
<div class="steps-g">
  <div class="step"><div class="snum">1</div><div class="stxt">Install <b>Cookie Editor</b> on Chrome or Firefox</div></div>
  <div class="step"><div class="snum">2</div><div class="stxt">Log into Facebook as the <b>bot account</b></div></div>
  <div class="step"><div class="snum">3</div><div class="stxt">Open Cookie Editor → <b>Export All</b> → copy JSON</div></div>
  <div class="step"><div class="snum">4</div><div class="stxt">Paste below — system verifies <b>automatically</b></div></div>
</div>
<form method="POST" action="/api/cookie/slot?tab=dashboard&itab=cookie">
  <input type="hidden" name="slot" value="fbstate.json"/>
  <textarea class="ck-ta" name="cookie" placeholder='[{"key":"c_user","value":"100000..."},{"key":"xs","value":"..."},...]' rows="5"></textarea>
  <button class="conn-btn" type="submit"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>Connect Bot</button>
</form>
<p class="ck-note">Your cookie never leaves this server.</p>
</div>`;

    // CUSTOM CMDS
    const pageCmds = `
<div class="shd">${I.cmd} Custom Commands</div>
<div class="box"><div class="bh"><span class="chip">CMDS</span><span class="bt">Command Builder</span><span class="bm">${customCmds.length} commands</span></div>
<form class="add-row" method="POST" action="/api/cmds/add?tab=dashboard&itab=cmds" style="flex-wrap:wrap;gap:8px">
  <input class="ai" type="text" name="cmd" placeholder="!command" style="max-width:180px" required/>
  <input class="ai" type="text" name="reply" placeholder="Reply text (use {name} for sender)" required/>
  <button class="btn-a" type="submit">+ Add</button>
</form>
<div class="ql">${customCmds.length===0?`<div class="qe">No custom commands yet</div>`:customCmds.map((c,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt"><b style="color:var(--red2)">${esc(c.cmd)}</b> → ${esc(c.reply)}</span><form method="POST" action="/api/cmds/remove?tab=dashboard&itab=cmds" style="margin:0"><input type="hidden" name="index" value="${i}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("")}</div>
</div>`;

    // COMMANDS REFERENCE
    const pageCommands = `
<div class="shd">${I.chat} Command Reference</div>
<div class="box"><div class="bh"><span class="chip">LOOP</span><span class="bt">Loop Commands</span></div>
<table><tbody>
<tr><td class="td-m">.</td><td>Toggle loop in current thread (group or PM)</td></tr>
<tr><td class="td-m">. &lt;uid&gt;</td><td>Toggle PM loop with that Facebook UID</td></tr>
<tr><td class="td-m">. &lt;name&gt;</td><td>Search friends and toggle PM loop by name</td></tr>
<tr><td class="td-m">!stop</td><td>Force-stop the loop</td></tr>
<tr><td class="td-m">!looppm &lt;uid&gt;</td><td>Start PM loop</td></tr>
<tr><td class="td-m">!stoppm &lt;uid&gt;</td><td>Stop PM loop</td></tr>
<tr><td class="td-m">!schedule &lt;sec&gt; &lt;msg&gt;</td><td>Send message after N seconds</td></tr>
</tbody></table></div>
<div class="box"><div class="bh"><span class="chip">AUTO</span><span class="bt">Auto-Respond</span></div>
<table><tbody>
<tr><td class="td-m">!on / !off</td><td>Enable/disable auto-respond (groups)</td></tr>
<tr><td class="td-m">!mute / !unmute</td><td>Pause/resume auto-respond</td></tr>
<tr><td class="td-m">!broadcast &lt;text&gt;</td><td>Send to all active threads</td></tr>
</tbody></table></div>
<div class="box"><div class="bh"><span class="chip">GROUP</span><span class="bt">Group Tools</span></div>
<table><tbody>
<tr><td class="td-m">!nn &lt;name&gt;</td><td>Set & lock nicknames for all members</td></tr>
<tr><td class="td-m">!nn1 &lt;uid&gt; &lt;name&gt;</td><td>Set one person's nickname</td></tr>
<tr><td class="td-m">!clearnn</td><td>Clear all nicknames</td></tr>
<tr><td class="td-m">!cg &lt;name&gt; / !uncg</td><td>Change & lock group name</td></tr>
<tr><td class="td-m">!banner [url] / !unbanner</td><td>Set & lock group banner</td></tr>
<tr><td class="td-m">!kick / !add &lt;uid&gt;</td><td>Remove/add member</td></tr>
<tr><td class="td-m">!promote / !demote &lt;uid&gt;</td><td>Set/remove admin status</td></tr>
<tr><td class="td-m">!emoji &lt;e&gt; / !color &lt;name&gt;</td><td>Set thread emoji/color</td></tr>
<tr><td class="td-m">!freeze / !unfreeze</td><td>Freeze group (kick non-admins who chat)</td></tr>
<tr><td class="td-m">!gmute / !gunmute &lt;uid&gt;</td><td>Ghost-mute a specific user</td></tr>
<tr><td class="td-m">!perms &lt;uid&gt; &lt;time&gt;</td><td>Give temporary permissions</td></tr>
</tbody></table></div>
<div class="box"><div class="bh"><span class="chip">VOICE</span><span class="bt">Voice & Music</span></div>
<table><tbody>
<tr><td class="td-m">!vm &lt;text&gt;</td><td>Send TTS voice message</td></tr>
<tr><td class="td-m">!vmpm &lt;uid&gt; &lt;text&gt;</td><td>Send TTS to a PM</td></tr>
<tr><td class="td-m">!p &lt;song name&gt;</td><td>Search YouTube and send song as audio</td></tr>
<tr><td class="td-m">!p &lt;youtube url&gt;</td><td>Send YouTube audio directly</td></tr>
</tbody></table></div>
<div class="box"><div class="bh"><span class="chip">FUN</span><span class="bt">Fun Commands</span></div>
<table><tbody>
<tr><td class="td-m">!flip</td><td>Coin flip</td></tr>
<tr><td class="td-m">!roll [sides]</td><td>Dice roll</td></tr>
<tr><td class="td-m">!8ball &lt;q&gt;</td><td>Magic 8-ball</td></tr>
<tr><td class="td-m">!pick a|b|c</td><td>Random picker</td></tr>
<tr><td class="td-m">!reverse / !shout / !mock / !clap &lt;text&gt;</td><td>Text effects</td></tr>
<tr><td class="td-m">!timer &lt;sec&gt;</td><td>Countdown ping</td></tr>
<tr><td class="td-m">!repeat &lt;n&gt; &lt;text&gt;</td><td>Repeat message N times</td></tr>
<tr><td class="td-m">!spam &lt;n&gt; &lt;text&gt;</td><td>Spam N times (max 20)</td></tr>
</tbody></table></div>
<div class="box"><div class="bh"><span class="chip">TOOLS</span><span class="bt">Utilities</span></div>
<table><tbody>
<tr><td class="td-m">!status</td><td>Show loop/auto-respond status</td></tr>
<tr><td class="td-m">!info</td><td>Thread info (name, members, admins)</td></tr>
<tr><td class="td-m">!members</td><td>List all member UIDs</td></tr>
<tr><td class="td-m">!id</td><td>Get replying user's UID</td></tr>
<tr><td class="td-m">!myid</td><td>Get your own UID</td></tr>
<tr><td class="td-m">!seen</td><td>Mark chat as read</td></tr>
<tr><td class="td-m">!say &lt;text&gt;</td><td>Send message as bot</td></tr>
<tr><td class="td-m">!forward &lt;tid&gt; &lt;msg&gt;</td><td>Forward message to another thread</td></tr>
<tr><td class="td-m">!gp [url/off]</td><td>Lock/unlock profile picture</td></tr>
<tr><td class="td-m">!antirestrict</td><td>Toggle anti-restrict</td></tr>
<tr><td class="td-m">!test</td><td>Ping bot</td></tr>
<tr><td class="td-m">!help</td><td>Show help in chat</td></tr>
</tbody></table></div>`;

    const pages = { overview: pageOverview, loop: pageLoop, threads: pageThreads, config: pageConfig, cookie: pageCookie, cmds: pageCmds, commands: pageCommands };
    return tabBar + (pages[itab] || pageOverview);
}

// ─── ACCOUNT STATUS TAB ───────────────────────────────────────────────────────
function buildAccountContent() {
    const ai    = accountInfo || {};
    const botN  = state.botName || ai.name || "—";
    const botID = state.developerID || ai.id || "—";
    const friends = ai.friendCount != null ? String(ai.friendCount) : "—";
    const threads = Object.keys({...state.loopEnabled,...state.autoRespondEnabled});
    const gcCount = [...new Set(threads)].length;
    const isOnline = state.loggedIn;

    const card = (label, val, sub, icon) => `<div class="ac"><div class="ac-lbl">${icon||""}${label}</div><div class="ac-val">${esc(String(val))}</div>${sub?`<div class="ac-sub">${esc(String(sub))}</div>`:""}  </div>`;

    return `
<div class="shd">${I.user} Facebook Account</div>
<div class="acg">
${card("Profile Name", botN, isOnline?"Connected":"Offline", `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`)}
${card("Profile ID", botID, "Facebook UID", `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`)}
${card("Total Friends", friends, "Friend count fetched at login", I.friends??"<svg width='12' height='12' fill='none' stroke='currentColor' stroke-width='2' viewBox='0 0 24 24'><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>")}
${card("Total GCs", gcCount, "Active group chat threads", I.chat??"<svg width='12' height='12' fill='none' stroke='currentColor' stroke-width='2' viewBox='0 0 24 24'><path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/></svg>")}
${card("Account Status", isOnline?"Active":"Offline", isOnline?"Bot is connected and listening":"Bot is not logged in", `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`)}
${card("Uptime", getUptime(), "Time since last restart", `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`)}
${card("Messages Sent", state.totalRepliesSent, "Total since last restart", I.msg??"<svg width='12' height='12' fill='none' stroke='currentColor' stroke-width='2' viewBox='0 0 24 24'><path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/></svg>")}
${card("Account Health", isOnline?"Good":"Degraded", isOnline?"No issues detected":"Offline or cookie expired", `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`)}
</div>
${!isOnline?`<div class="box" style="padding:18px;margin-top:8px"><div style="text-align:center;color:var(--gray);font-size:13px">Bot is offline. Go to <a href="/?tab=dashboard&itab=cookie" style="color:var(--red2)">Cookie tab</a> to connect.</div></div>`:""}
<div class="shd">${I.bell} Notification Center</div>
<div class="box" style="padding:0">
<div class="bh"><span class="chip chip-y">ALERTS</span><span class="bt">Recent Notifications</span><span class="bm">${alerts.length}</span></div>
<div class="la">${alerts.length===0?`<div class="lr lr-idle"><span class="lt">--:--</span><span class="ll">IDLE</span><span class="lm">No alerts yet</span></div>`:alerts.map(a=>`<div class="lr lr-${a.type==="error"?"error":a.type==="warn"?"warn":"info"}"><span class="lt">${esc(a.time)}</span><span class="ll">${a.type.toUpperCase()}</span><span class="lm">${esc(a.message)}</span></div>`).join("")}</div>
</div>`;
}

// ─── ABOUT TAB ────────────────────────────────────────────────────────────────
function buildAboutContent() {
    return `<div class="ab-wrap">
<div class="shd">${I.info} Developer</div>
<div class="ab-hero">
  <div class="ab-name">Kyle Gaspari</div>
  <div class="ab-role">Lead Developer &amp; Platform Architect</div>
  <p class="ab-txt">Kyle Gaspari is the developer and architect behind DUMMYL BOT, a powerful Facebook Messenger automation platform engineered to give users complete control over their bot workflows. With a deep focus on real-time systems and performance, Kyle designed every layer of this platform from the ground up — including the multi-worker bot engine, the MQTT-based listener, the live dashboard, and the per-user isolation system — to ensure stability, speed, and ease of use.</p>
  <br/>
  <p class="ab-txt">The platform supports a rich command set covering group management, loop automation, voice messages, song playback, anti-spam enforcement, and more. Every feature has been carefully crafted with both the bot owner and their users in mind.</p>
  <br/>
  <p class="ab-txt">If you encounter any errors on this platform, discover a bug, or have suggestions for improvements or new features, Kyle welcomes your feedback directly. Responsible and constructive input helps make the platform better for everyone who uses it.</p>
</div>
<div class="ab-contact">
  <div class="ab-ct-title">Contact Information</div>
  <div class="ct-item">
    <div class="ct-ico"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>
    <div><div class="ct-val">Reach out via Facebook Messenger</div><div class="ct-hint">Contact the developer if you found any error or have suggestions</div></div>
  </div>
  <div class="ct-item">
    <div class="ct-ico"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
    <div><div class="ct-val">Bug Reports &amp; Suggestions</div><div class="ct-hint">Report issues directly — your feedback shapes the platform's roadmap</div></div>
  </div>
</div>
<div style="margin-top:14px;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:10px;">
  <div style="font-size:11px;font-weight:700;letter-spacing:.1em;color:var(--gray);text-transform:uppercase;margin-bottom:8px;">Platform Info</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12.5px;color:var(--off);">
    <div>Version: <b style="color:var(--white)">v2.2</b></div>
    <div>Engine: <b style="color:var(--white)">ws3-fca (MQTT)</b></div>
    <div>Runtime: <b style="color:var(--white)">Node.js</b></div>
    <div>Platform: <b style="color:var(--white)">DUMMYL BOT</b></div>
  </div>
</div>
</div>`;
}

// ─── ADMIN TAB ────────────────────────────────────────────────────────────────
function buildAdminContent() {
    const users        = auth.getAllUsers();
    const activeSess   = auth.getActiveSessions();
    const activeMap    = {};
    for (const s of activeSess) activeMap[s.userId] = s;

    const rows = users.map(u => {
        const isActive = !!activeMap[u.id];
        const actSince = isActive && activeMap[u.id].createdAt ? new Date(activeMap[u.id].createdAt).toLocaleTimeString() : "—";
        return `<tr>
<td><b style="color:var(--white)">${esc(u.username)}</b><div style="font-size:11px;color:var(--gray)">${esc(u.email)}</div></td>
<td>${isActive?`<span class="tag tag-g">Online</span>`:`<span class="tag tag-d">Offline</span>`}</td>
<td style="font-size:12px;color:var(--gray)">${u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "Never"}</td>
<td style="font-size:12px;color:var(--gray)">${isActive ? actSince : "—"}</td>
<td>${u.isBanned?`<span class="tag tag-r">BANNED</span>`:(u.isAdmin?`<span class="tag tag-b">ADMIN</span>`:`<span class="tag tag-g">OK</span>`)}</td>
<td>
  <div style="display:flex;gap:6px;flex-wrap:wrap;">
    ${!u.isAdmin && !u.isBanned ? `<form method="POST" action="/admin/ban" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-danger btn-xs">Ban</button></form>` : ""}
    ${!u.isAdmin && u.isBanned  ? `<form method="POST" action="/admin/unban" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-o btn-xs">Unban</button></form>` : ""}
    ${!u.isAdmin ? `<form method="POST" action="/admin/delete" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-danger btn-xs" onclick="return confirm('Delete this user?')">Delete</button></form>` : ""}
  </div>
</td>
</tr>`;
    }).join("");

    return `
<div class="adm-banner">
  <div class="adm-ic">${I.admin}</div>
  <div><div class="adm-title">Admin Control Panel</div><div class="adm-sub">${users.length} registered users — ${activeSess.length} currently online</div></div>
</div>
<div class="sg" style="grid-template-columns:repeat(3,1fr)">
  <div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r">${I.user}</div><div class="sc-val">${users.length}</div><div class="sc-lbl">Total Users</div></div>
  <div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w">${I.globe}</div><div class="sc-val">${activeSess.length}</div><div class="sc-lbl">Online Now</div></div>
  <div class="sc"><div class="sc-glow gc-g"></div><div class="sc-ico ci-g">${I.shield}</div><div class="sc-val">${users.filter(u=>u.isBanned).length}</div><div class="sc-lbl">Banned</div></div>
</div>
<div class="shd">${I.user} User Management</div>
<div class="box">
  <div class="bh"><span class="chip">USERS</span><span class="bt">Registered Accounts</span><span class="bm">${users.length} total</span></div>
  <table>
    <thead><tr><th>User</th><th>Status</th><th>Last Seen</th><th>Session Start</th><th>Role</th><th>Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="td-e">No users yet</td></tr>`}</tbody>
  </table>
</div>
<div class="shd">${I.clock} Active Sessions</div>
<div class="box">
  <div class="bh"><span class="chip chip-g">LIVE</span><span class="bt">Current Sessions</span><span class="bm">${activeSess.length} sessions</span></div>
  <table>
    <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Session Age</th></tr></thead>
    <tbody>${activeSess.length===0?`<tr><td colspan="4" class="td-e">No active sessions</td></tr>`:activeSess.map(s=>`<tr><td>${esc(s.username||"Unknown")}</td><td style="color:var(--gray);font-size:12px">${esc(s.email||"")}</td><td>${s.isAdmin?`<span class="tag tag-b">Admin</span>`:`<span class="tag tag-g">User</span>`}</td><td style="font-size:12px;color:var(--gray)">${s.createdAt ? Math.round((Date.now()-s.createdAt)/60000)+"m ago" : "—"}</td></tr>`).join("")}</tbody>
  </table>
</div>`;
}

// ─── FULL PAGE BUILDER ────────────────────────────────────────────────────────
function buildPage(session, mainTab, innerTab) {
    let content = "";
    if (mainTab === "dashboard") content = buildDashboardContent(innerTab);
    else if (mainTab === "account") content = buildAccountContent();
    else if (mainTab === "about")   content = buildAboutContent();
    else if (mainTab === "admin" && session.isAdmin) content = buildAdminContent();
    else content = buildDashboardContent(innerTab);
    return buildLayout(session, mainTab || "dashboard", content);
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function startDashboard(port) {
    const server = http.createServer(async (req, res) => {
        const url  = new URL(req.url, `http://localhost`);
        const path_ = url.pathname;
        const sess = getSessionFromReq(req);

        function redirect(to, code = 302) {
            res.writeHead(code, { Location: to }); res.end();
        }
        function html(body, code = 200) {
            res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(body);
        }
        function json(obj, code = 200) {
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
        }

        // ── Auth pages (public)
        if (path_ === "/login" || path_ === "/") {
            if (path_ === "/login" || !sess) {
                if (sess) return redirect("/?tab=dashboard");
                return html(buildLoginPage());
            }
        }
        if (path_ === "/register") {
            if (sess) return redirect("/?tab=dashboard");
            return html(buildRegisterPage());
        }

        // ── Auth API (public)
        if (path_ === "/api/auth/login" && req.method === "POST") {
            const body = await parseBody(req);
            const result = auth.login(body.email || "", body.password || "");
            if (result.error) return html(buildLoginPage(result.error));
            const token = auth.createSession(result.user);
            res.writeHead(302, { "Set-Cookie": `dbl_sess=${token}; Path=/; HttpOnly; SameSite=Lax`, "Location": "/?tab=dashboard" });
            res.end();
            return;
        }
        if (path_ === "/api/auth/register" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.password !== body.confirm) return html(buildRegisterPage("Passwords do not match"));
            const result = auth.register(body.username || "", body.email || "", body.password || "");
            if (result.error) return html(buildRegisterPage(result.error));
            const token = auth.createSession(result.user);
            res.writeHead(302, { "Set-Cookie": `dbl_sess=${token}; Path=/; HttpOnly; SameSite=Lax`, "Location": "/?tab=dashboard" });
            res.end();
            return;
        }
        if (path_ === "/api/auth/logout" && req.method === "POST") {
            const tok = getTokenFromReq(req);
            if (tok) auth.destroySession(tok);
            res.writeHead(302, { "Set-Cookie": `dbl_sess=; Path=/; HttpOnly; Max-Age=0`, "Location": "/login" });
            res.end();
            return;
        }

        // ── Everything else requires auth
        if (!sess) return redirect("/login");
        auth.updateLastSeen(sess.userId);

        // ── Main dashboard (GET /)
        if (path_ === "/" && req.method === "GET") {
            const mainTab  = url.searchParams.get("tab") || "dashboard";
            const innerTab = url.searchParams.get("itab") || "overview";
            if (mainTab === "admin" && !sess.isAdmin) return redirect("/?tab=dashboard");
            return html(buildPage(sess, mainTab, innerTab));
        }

        // ── Admin actions
        if (path_ === "/admin/ban" && req.method === "POST" && sess.isAdmin) {
            const body = await parseBody(req);
            auth.banUser(body.userId, body.reason || "");
            return redirect("/?tab=admin");
        }
        if (path_ === "/admin/unban" && req.method === "POST" && sess.isAdmin) {
            const body = await parseBody(req);
            auth.unbanUser(body.userId);
            return redirect("/?tab=admin");
        }
        if (path_ === "/admin/delete" && req.method === "POST" && sess.isAdmin) {
            const body = await parseBody(req);
            auth.deleteUser(body.userId);
            return redirect("/?tab=admin");
        }

        // ── API: JSON endpoints
        if (path_ === "/api/status")       return json({ loggedIn: state.loggedIn, botName: state.botName, uptime: getUptime(), totalRepliesSent: state.totalRepliesSent });
        if (path_ === "/api/hourly-stats") return json(getHourlyStats());
        if (path_ === "/api/alerts")       return json(alerts);

        // ── Redirect helper for POST actions
        function postRedirect(req, fallback) {
            const ref = req.headers.referer || fallback || "/?tab=dashboard";
            return ref;
        }

        // ── API: Replies
        if (path_ === "/api/replies/add" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.word) { const a = readCustomReplies(); a.push(body.word.trim()); writeCustomReplies(a); }
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "loop";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/replies/remove" && req.method === "POST") {
            const body = await parseBody(req);
            const a = readCustomReplies(); a.splice(parseInt(body.index), 1); writeCustomReplies(a);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "loop";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/images/add" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.url) { const a = readImageReplies(); a.push(body.url.trim()); writeImageReplies(a); }
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "loop";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/images/remove" && req.method === "POST") {
            const body = await parseBody(req);
            const a = readImageReplies(); a.splice(parseInt(body.index), 1); writeImageReplies(a);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "loop";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }

        // ── API: Config
        if (path_ === "/api/config/save" && req.method === "POST") {
            const body = await parseBody(req);
            const cfg = readBotConfig();
            const num = (k, def) => { const v = parseFloat(body[k]); return isNaN(v) ? def : v; };
            const bool = k => body[k] === "1" || body[k] === "true" || body[k] === "on";
            cfg.loopReact         = body.loopReact         || cfg.loopReact;
            cfg.loopDelay         = num("loopDelay", 1);
            cfg.imageProbability  = num("imageProbability", 20);
            cfg.loopMode          = body.loopMode          || "sequential";
            cfg.maxLoopCount      = num("maxLoopCount", 0);
            cfg.autoStopMinutes   = num("autoStopMinutes", 0);
            cfg.loopStartMsg      = body.loopStartMsg      ?? cfg.loopStartMsg;
            cfg.loopStopMsg       = body.loopStopMsg       ?? cfg.loopStopMsg;
            cfg.ttsLang           = body.ttsLang           || cfg.ttsLang;
            cfg.reactOnlyMode     = bool("reactOnlyMode");
            cfg.greetNewMembers   = bool("greetNewMembers");
            cfg.greetMsg          = body.greetMsg          ?? cfg.greetMsg;
            cfg.antiSpamEnabled   = bool("antiSpamEnabled");
            cfg.antiSpamMaxMsg    = num("antiSpamMaxMsg", 5);
            cfg.antiSpamWindowSec = num("antiSpamWindowSec", 10);
            cfg.autoSeenEnabled   = bool("autoSeenEnabled");
            cfg.typingSimulate    = bool("typingSimulate");
            cfg.silentMode        = bool("silentMode");
            cfg.loopSilentMode    = bool("loopSilentMode");
            cfg.autoReactEnabled  = bool("autoReactEnabled");
            cfg.autoReactEmoji    = body.autoReactEmoji    || cfg.autoReactEmoji;
            writeBotConfig(cfg);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "config";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }

        // ── API: Cookie
        if (path_ === "/api/cookie/slot" && req.method === "POST") {
            const body = await parseBody(req);
            const raw = body.cookie || "";
            if (!raw.trim()) return redirect("/?tab=dashboard&itab=cookie");
            let parsed;
            try { parsed = JSON.parse(raw); } catch(_) { return redirect("/?tab=dashboard&itab=cookie"); }
            if (!Array.isArray(parsed) || parsed.length === 0) return redirect("/?tab=dashboard&itab=cookie");
            const slot = body.slot || "fbstate.json";
            const dest = require("path").join(DATA_DIR, path.basename(slot).replace(/[^a-zA-Z0-9._-]/g, ""));
            fs.writeFileSync(dest, JSON.stringify(parsed, null, 2), "utf8");
            resetAll();
            if (_cookieUpdateCb) _cookieUpdateCb();
            return redirect("/?tab=dashboard&itab=cookie");
        }

        // ── API: Custom commands
        if (path_ === "/api/cmds/add" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.cmd && body.reply) {
                const a = readCustomCommands();
                const cmd = body.cmd.startsWith("!") ? body.cmd : "!" + body.cmd;
                a.push({ cmd, reply: body.reply });
                writeCustomCommands(a);
            }
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "cmds";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/cmds/remove" && req.method === "POST") {
            const body = await parseBody(req);
            const a = readCustomCommands(); a.splice(parseInt(body.index), 1); writeCustomCommands(a);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "cmds";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }

        // ── API: Whitelist
        if (path_ === "/api/whitelist/toggle" && req.method === "POST") {
            const w = readWhitelist(); w.enabled = !w.enabled; writeWhitelist(w);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "threads";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/whitelist/add" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.uid) { const w = readWhitelist(); if (!w.uids.includes(body.uid)) { w.uids.push(body.uid); writeWhitelist(w); } }
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "threads";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/whitelist/remove" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.uid) { const w = readWhitelist(); w.uids = w.uids.filter(u => u !== body.uid); writeWhitelist(w); }
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "threads";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }

        // ── API: Thread controls
        if (path_ === "/api/thread/config" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.threadID) {
                const c = readThreadConfig();
                c[body.threadID] = { loopDelay: parseFloat(body.loopDelay) || null, loopReact: body.loopReact || null };
                writeThreadConfig(c);
            }
            return redirect("/?tab=dashboard&itab=threads");
        }
        if (path_ === "/api/thread/startloop" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.threadID && _loopControlCb) _loopControlCb("start", body.threadID);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "threads";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/thread/stoploop" && req.method === "POST") {
            const body = await parseBody(req);
            if (body.threadID && _loopControlCb) _loopControlCb("stop", body.threadID);
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "threads";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }
        if (path_ === "/api/thread/stopall" && req.method === "POST") {
            const threads = Object.keys(state.loopEnabled || {}).filter(t => state.loopEnabled[t]);
            threads.forEach(t => { if (_loopControlCb) _loopControlCb("stop", t); });
            const tab = url.searchParams.get("tab") || "dashboard";
            const itab = url.searchParams.get("itab") || "threads";
            return redirect(`/?tab=${tab}&itab=${itab}`);
        }

        // ── 404
        res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
    });

    server.listen(parseInt(port) || 5000, "0.0.0.0", () => {
        console.log(`[cozy-bot] Dashboard running on port ${port}`);
    });
}

module.exports = { startDashboard, addLog, addAlert, state, setCookieUpdateHandler, setLoopControlHandler, trackMessage, setAccountInfoForUser };
