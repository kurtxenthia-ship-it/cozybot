"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const auth = require("./auth");

const MAX_LOGS   = 200;
const MUSIC_URL  = "https://file.garden/aahuG_hIDGRlXD24/In%20This%20Darkness.mp3";
const MUSIC_NAME = "In This Darkness";

// ─── PER-USER STATE ───────────────────────────────────────────────────────────
const userStates    = new Map();
const accountInfos  = new Map();

function getUserState(userId) {
    if (!userStates.has(userId)) {
        const s = {
            bots: [], developerID: "", loopEnabled: {}, autoRespondEnabled: {},
            mutedThreads: {}, totalRepliesSent: 0, startedAt: new Date(),
            botName: "", loginInProgress: false, logs: [], alerts: [], msgTimestamps: [],
            get loggedIn()    { return this.bots.some(b => b.loggedIn); },
            get reconnecting(){ return !this.loggedIn && this.bots.some(b => b.reconnecting); },
        };
        userStates.set(userId, s);
    }
    return userStates.get(userId);
}
// Global state ref for compat (admin's state)
const state = getUserState(auth.ADMIN_ID || "admin_001");

function addLog(userId, type, message) {
    const s = getUserState(userId);
    s.logs.unshift({ time: new Date().toLocaleTimeString(), type, message });
    if (s.logs.length > MAX_LOGS) s.logs.pop();
}
function sysLog(type, message) { addLog(auth.ADMIN_ID || "admin_001", type, message); }
function addAlert(userId, type, message) {
    const s = getUserState(userId);
    s.alerts.unshift({ time: new Date().toLocaleTimeString(), type, message });
    if (s.alerts.length > 50) s.alerts.pop();
}
function trackMessage(userId) {
    const s = getUserState(userId);
    s.msgTimestamps.push(Date.now());
    const cutoff = Date.now() - 24*3600*1000;
    while (s.msgTimestamps.length && s.msgTimestamps[0] < cutoff) s.msgTimestamps.shift();
}
function setAccountInfoForUser(userId, data) {
    if (!accountInfos.has(userId)) accountInfos.set(userId, {});
    Object.assign(accountInfos.get(userId), data);
}
function getAccountInfo(userId) { return accountInfos.get(userId) || {}; }

let _cookieUpdateCb = null;
function setCookieUpdateHandler(cb) { _cookieUpdateCb = cb; }
let _loopControlCb = null;
function setLoopControlHandler(cb) { _loopControlCb = cb; }
let _stopAllCb = null;
function setStopAllHandler(cb) { _stopAllCb = cb; }

// ─── DATA FILE HELPERS ────────────────────────────────────────────────────────
function uDir(userId) { return auth.getUserDataDir(userId); }
function uFile(userId, name) { return path.join(uDir(userId), name); }

function readCustomReplies(uid)    { try{return JSON.parse(fs.readFileSync(uFile(uid,"custom_replies.json"),"utf8"));}catch(_){return[];} }
function writeCustomReplies(uid,a) { auth.ensureUserDataDir(uid); fs.writeFileSync(uFile(uid,"custom_replies.json"),JSON.stringify(a,null,2),"utf8"); }
function readImageReplies(uid)     { try{return JSON.parse(fs.readFileSync(uFile(uid,"image_replies.json"),"utf8"));}catch(_){return[];} }
function writeImageReplies(uid,a)  { auth.ensureUserDataDir(uid); fs.writeFileSync(uFile(uid,"image_replies.json"),JSON.stringify(a,null,2),"utf8"); }
function readBotConfig(uid) {
    try{return JSON.parse(fs.readFileSync(uFile(uid,"bot_config.json"),"utf8"));}
    catch(_){return{loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false,silentMode:false,loopSilentMode:false,autoReactEnabled:false,autoReactEmoji:"😆"};}
}
function writeBotConfig(uid,c)     { auth.ensureUserDataDir(uid); fs.writeFileSync(uFile(uid,"bot_config.json"),JSON.stringify(c,null,2),"utf8"); }
function readCustomCommands(uid)   { try{return JSON.parse(fs.readFileSync(uFile(uid,"custom_commands.json"),"utf8"));}catch(_){return[];} }
function writeCustomCommands(uid,a){ auth.ensureUserDataDir(uid); fs.writeFileSync(uFile(uid,"custom_commands.json"),JSON.stringify(a,null,2),"utf8"); }
function readWhitelist(uid)        { try{return JSON.parse(fs.readFileSync(uFile(uid,"whitelist.json"),"utf8"));}catch(_){return{enabled:false,uids:[]};} }
function writeWhitelist(uid,w)     { auth.ensureUserDataDir(uid); fs.writeFileSync(uFile(uid,"whitelist.json"),JSON.stringify(w,null,2),"utf8"); }
function readThreadConfig(uid)     { try{return JSON.parse(fs.readFileSync(uFile(uid,"thread_config.json"),"utf8"));}catch(_){return {};} }
function writeThreadConfig(uid,c)  { auth.ensureUserDataDir(uid); fs.writeFileSync(uFile(uid,"thread_config.json"),JSON.stringify(c,null,2),"utf8"); }
function getFbstateFiles(uid) {
    try { return fs.readdirSync(uDir(uid)).filter(f=>/^fbstate.*\.json$/i.test(f)).sort(); }
    catch(_){ return ["fbstate.json"]; }
}
function hasCookieForUser(uid) {
    const dir = uDir(uid);
    try {
        const files = fs.readdirSync(dir).filter(f => /^fbstate.*\.json$/i.test(f));
        return files.some(f => {
            try {
                const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                return Array.isArray(arr) && arr.length > 0;
            } catch(_) { return false; }
        });
    } catch(_) { return false; }
}

function getUptime(userId) {
    const ms = Date.now() - getUserState(userId).startedAt.getTime();
    const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
    if(d>0)return`${d}d ${h%24}h`;if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;
}
function getHourlyStats(userId) {
    const now = Date.now();
    const buckets = new Array(24).fill(0);
    for (const ts of (getUserState(userId).msgTimestamps||[])) {
        const h = Math.floor((now - ts) / 3600000);
        if (h < 24) buckets[23 - h]++;
    }
    return buckets;
}
function esc(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function parseBody(req) {
    return new Promise(resolve => {
        let raw="";
        req.on("data",c=>{raw+=c.toString();});
        req.on("end",()=>{
            const p={};
            raw.split("&").forEach(pair=>{
                const eqIdx=pair.indexOf("=");if(eqIdx===-1)return;
                try{const k=decodeURIComponent(pair.slice(0,eqIdx).replace(/\+/g," "));const v=decodeURIComponent(pair.slice(eqIdx+1).replace(/\+/g," "));p[k]=v;}catch(_){}
            });
            resolve(p);
        });
    });
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
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
:root{
  --bg:#05040a;--bg2:#080612;--sidebar:rgba(8,5,16,0.94);
  --card:rgba(14,10,24,0.78);--card2:rgba(20,14,34,0.85);
  --border:rgba(220,38,38,0.12);--border2:rgba(220,38,38,0.22);
  --red:#dc2626;--red2:#ef4444;--red3:#f87171;--red-dim:#991b1b;
  --rg:rgba(220,38,38,0.08);--rg2:rgba(220,38,38,0.16);--rg3:rgba(220,38,38,0.32);
  --rg4:rgba(220,38,38,0.5);
  --white:#fff;--off:#e8e4f0;--gray:#8b7fa8;--gray2:#5c5278;--muted:#3a3355;
  --ok:#22c55e;--warn:#f59e0b;--info:#3b82f6;
  --glow-red:0 0 20px rgba(220,38,38,0.45),0 0 40px rgba(220,38,38,0.2);
  --glow-sm:0 0 10px rgba(220,38,38,0.35);
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{
  font-family:'Inter',system-ui,sans-serif;
  background:var(--bg);color:var(--white);
  min-height:100vh;display:flex;overflow-x:hidden;
}
body::before{
  content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(ellipse 80% 60% at 10% 30%,rgba(139,0,0,0.14) 0%,transparent 60%),
    radial-gradient(ellipse 60% 50% at 90% 70%,rgba(100,0,0,0.10) 0%,transparent 55%),
    radial-gradient(ellipse 40% 40% at 50% 10%,rgba(60,0,30,0.08) 0%,transparent 50%);
}
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(220,38,38,0.3);border-radius:2px;}
::-webkit-scrollbar-thumb:hover{background:var(--red);}
a{text-decoration:none;color:inherit;}

/* ── SIDEBAR ── */
.sb{
  width:250px;min-height:100vh;
  background:var(--sidebar);
  backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;
  position:fixed;top:0;left:0;height:100vh;z-index:100;
  transition:width .3s cubic-bezier(.4,0,.2,1);overflow:hidden;
  box-shadow:4px 0 40px rgba(0,0,0,0.6);
}
.sb::after{
  content:'';position:absolute;left:0;top:15%;bottom:15%;width:2px;
  background:linear-gradient(180deg,transparent,var(--red),var(--red2),var(--red),transparent);
  box-shadow:0 0 16px var(--red),0 0 32px rgba(220,38,38,0.4);
  border-radius:2px;opacity:0.7;
}
.sb.col{width:64px;}
.sb-top{padding:18px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;min-height:70px;flex-shrink:0;}
.sb-logo{
  width:38px;height:38px;
  background:linear-gradient(135deg,var(--red),var(--red-dim));
  border-radius:10px;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;
  box-shadow:0 0 18px var(--rg3),0 4px 12px rgba(0,0,0,0.4);
  transition:box-shadow .3s;
}
.sb-logo:hover{box-shadow:var(--glow-red);}
.sb-brand{overflow:hidden;white-space:nowrap;transition:opacity .2s,width .3s;}
.sb.col .sb-brand{opacity:0;width:0;}
.sb-name{font-size:13px;font-weight:800;letter-spacing:.1em;color:var(--white);text-shadow:0 0 20px rgba(220,38,38,0.5);}
.sb-sub{font-size:9px;color:var(--gray);letter-spacing:.08em;margin-top:1px;}
.sb-tog{
  background:none;border:1px solid var(--border);color:var(--gray);
  cursor:pointer;padding:7px 10px;border-radius:8px;margin:10px 8px;
  width:calc(100% - 16px);display:flex;align-items:center;justify-content:center;
  gap:8px;font-size:11px;font-family:inherit;
  transition:all .2s cubic-bezier(.4,0,.2,1);
}
.sb-tog:hover{border-color:var(--red);color:var(--red);box-shadow:var(--glow-sm);}
.tog-lbl{white-space:nowrap;overflow:hidden;transition:opacity .2s,width .3s;}
.sb.col .tog-lbl{opacity:0;width:0;}
.sb-nav{flex:1;padding:8px;display:flex;flex-direction:column;gap:3px;overflow:hidden;}
.ni{
  display:flex;align-items:center;gap:12px;padding:11px 13px;
  border-radius:10px;color:var(--gray);cursor:pointer;
  transition:all .2s cubic-bezier(.4,0,.2,1);
  white-space:nowrap;overflow:hidden;border:1px solid transparent;
}
.ni:hover{background:var(--rg);color:var(--off);border-color:var(--border);box-shadow:inset 0 0 20px rgba(220,38,38,0.04);}
.ni.act{
  background:linear-gradient(135deg,rgba(220,38,38,0.18),rgba(153,27,27,0.12));
  color:var(--white);border-color:rgba(220,38,38,0.3);
  box-shadow:0 0 16px rgba(220,38,38,0.15),inset 0 0 20px rgba(220,38,38,0.06);
}
.ni .ico{flex-shrink:0;color:inherit;transition:filter .2s;}
.ni.act .ico{color:var(--red2);filter:drop-shadow(0 0 5px rgba(239,68,68,0.7));}
.ni .lbl{font-size:12.5px;font-weight:500;letter-spacing:.04em;transition:opacity .2s;}
.sb.col .ni .lbl{opacity:0;}
.ni-sep{height:1px;background:var(--border);margin:6px 8px;}
.sb-foot{padding:12px 8px;border-top:1px solid var(--border);flex-shrink:0;}
.u-pill{
  display:flex;align-items:center;gap:10px;padding:10px 12px;
  border-radius:10px;
  background:rgba(20,14,34,0.6);
  border:1px solid var(--border);overflow:hidden;margin-bottom:8px;white-space:nowrap;
  transition:border-color .2s;
}
.u-pill:hover{border-color:var(--border2);}
.u-av{
  width:32px;height:32px;border-radius:50%;
  background:linear-gradient(135deg,var(--red),var(--red-dim));
  display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:700;flex-shrink:0;
  box-shadow:0 0 10px rgba(220,38,38,0.4);
}
.u-info{overflow:hidden;}
.u-name{font-size:12px;font-weight:600;color:var(--white);}
.u-role{font-size:10px;color:var(--gray);}
.sb.col .u-info{opacity:0;width:0;}
.lo-btn{
  width:100%;padding:9px 12px;background:none;
  border:1px solid var(--border);border-radius:8px;
  color:var(--gray);cursor:pointer;font-size:11.5px;font-family:inherit;
  display:flex;align-items:center;justify-content:center;gap:8px;
  transition:all .2s;
}
.lo-btn:hover{border-color:var(--red2);color:var(--red3);box-shadow:var(--glow-sm);}
.sb.col .lo-lbl{opacity:0;width:0;overflow:hidden;}

/* ── MAIN CONTENT ── */
.mw{margin-left:250px;flex:1;min-height:100vh;display:flex;flex-direction:column;transition:margin-left .3s cubic-bezier(.4,0,.2,1);position:relative;z-index:1;}
.mw.col{margin-left:64px;}
.topbar{
  height:56px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;padding:0 24px;gap:14px;
  background:rgba(5,4,10,0.85);backdrop-filter:blur(20px);
  position:sticky;top:0;z-index:50;
}
.tb-title{font-size:12.5px;font-weight:500;color:var(--gray);letter-spacing:.04em;}
.tb-title span{color:var(--white);font-weight:600;}
.tb-right{margin-left:auto;display:flex;align-items:center;gap:12px;}
.st-badge{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid;}
.st-on{border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.08);color:#22c55e;}
.st-off{border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.08);color:#ef4444;}
.st-warn{border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.08);color:#f59e0b;}
.st-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0;}
.st-on .st-dot{animation:neonPulse 2s infinite;box-shadow:0 0 6px currentColor;}
@keyframes neonPulse{0%,100%{opacity:1;box-shadow:0 0 4px currentColor;}50%{opacity:.5;box-shadow:0 0 14px currentColor,0 0 24px currentColor;}}
.mc{padding:24px;flex:1;padding-bottom:90px;}

/* ── INNER TABS ── */
.itabs{display:flex;gap:3px;background:rgba(14,10,24,0.6);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:12px;padding:5px;margin-bottom:22px;flex-wrap:wrap;}
.itab{padding:8px 15px;border-radius:8px;font-size:12px;font-weight:500;color:var(--gray);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid transparent;}
.itab:hover{color:var(--off);background:var(--rg);border-color:var(--border);}
.itab.act{background:linear-gradient(135deg,var(--red),var(--red-dim));color:#fff;box-shadow:0 0 18px var(--rg3);}

/* ── STAT GRID ── */
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:22px;}
.sc{
  background:var(--card);backdrop-filter:blur(16px);
  border:1px solid var(--border);border-radius:14px;
  padding:20px;position:relative;overflow:hidden;
  transition:all .3s cubic-bezier(.4,0,.2,1);
  cursor:default;
}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--red),transparent);opacity:0;transition:opacity .3s;}
.sc:hover{border-color:var(--border2);box-shadow:0 0 30px rgba(220,38,38,0.12),0 8px 32px rgba(0,0,0,0.5);transform:translateY(-2px);}
.sc:hover::before{opacity:1;}
.sc-glow{position:absolute;top:-30px;right:-30px;width:100px;height:100px;border-radius:50%;filter:blur(35px);opacity:0.3;pointer-events:none;}
.gc-r{background:radial-gradient(circle,#dc2626,transparent);}
.gc-w{background:radial-gradient(circle,#a78bfa,transparent);}
.gc-g{background:radial-gradient(circle,#6b7280,transparent);}
.gc-o{background:radial-gradient(circle,#f59e0b,transparent);}
.sc-ico{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;}
.ci-r{background:rgba(220,38,38,0.15);color:#ef4444;}
.ci-w{background:rgba(167,139,250,0.12);color:#c4b5fd;}
.ci-g{background:rgba(107,114,128,0.15);color:#9ca3af;}
.ci-o{background:rgba(245,158,11,0.12);color:#f59e0b;}
.sc-val{font-size:28px;font-weight:800;margin-bottom:4px;line-height:1;letter-spacing:-.02em;}
.sc-lbl{font-size:11.5px;color:var(--gray);font-weight:500;}
.sc-sub{font-size:10px;color:var(--gray2);}

/* ── HERO ── */
.hero{background:var(--card);backdrop-filter:blur(16px);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:22px;position:relative;transition:border-color .3s;}
.hero:hover{border-color:var(--border2);}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--red),var(--red2),var(--red),transparent);background-size:200% 100%;animation:borderFlow 4s linear infinite;}
@keyframes borderFlow{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
.hero-in{padding:24px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.hero-l{display:flex;align-items:center;gap:18px;}
.hero-ic{width:52px;height:52px;background:linear-gradient(135deg,var(--red),var(--red-dim));border-radius:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 30px var(--rg3),0 8px 24px rgba(0,0,0,0.4);flex-shrink:0;}
.hero-title{font-size:22px;font-weight:900;letter-spacing:-.02em;text-shadow:0 0 30px rgba(220,38,38,0.35);}
.hero-ver{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:rgba(220,38,38,0.15);color:var(--red2);margin-left:8px;vertical-align:middle;border:1px solid rgba(220,38,38,0.25);}
.hero-desc{font-size:12px;color:var(--gray);margin-top:5px;}
.hero-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;}
.p-on{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.25);}
.p-off{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.25);}
.p-warn{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.25);}
.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;animation:neonPulse 2s infinite;}

/* ── BOX ── */
.box{background:var(--card);backdrop-filter:blur(14px);border:1px solid var(--border);border-radius:14px;margin-bottom:18px;overflow:hidden;transition:border-color .25s,box-shadow .25s;}
.box:hover{border-color:rgba(220,38,38,0.18);}
.bh{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}
.bt{font-size:13px;font-weight:700;color:var(--white);}
.bm{font-size:11px;color:var(--gray);margin-left:auto;}
.chip{font-size:9px;font-weight:700;letter-spacing:.12em;padding:3px 8px;border-radius:5px;background:rgba(220,38,38,0.15);color:var(--red2);border:1px solid rgba(220,38,38,0.28);}
.chip-g{background:rgba(34,197,94,.1);color:#22c55e;border-color:rgba(34,197,94,.22);}
.chip-y{background:rgba(245,158,11,.1);color:#f59e0b;border-color:rgba(245,158,11,.22);}
.chip-b{background:rgba(59,130,246,.1);color:#60a5fa;border-color:rgba(59,130,246,.22);}
.chip-p{background:rgba(168,85,247,.1);color:#c084fc;border-color:rgba(168,85,247,.22);}
.shd{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:700;letter-spacing:.14em;color:var(--gray);text-transform:uppercase;margin:22px 0 12px;}
.shd svg{color:var(--red);flex-shrink:0;filter:drop-shadow(0 0 4px rgba(220,38,38,0.6));}

/* ── TABLE ── */
table{width:100%;border-collapse:collapse;}
th{text-align:left;padding:10px 20px;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--gray);text-transform:uppercase;border-bottom:1px solid var(--border);}
td{padding:12px 20px;font-size:13px;border-bottom:1px solid rgba(220,38,38,0.06);}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(220,38,38,0.04);}
.td-m{font-family:'Courier New',monospace;font-size:11.5px;color:var(--gray);}
.td-e{text-align:center;color:var(--gray2);font-size:12px;padding:28px;}
.tag{display:inline-block;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:600;letter-spacing:.04em;}
.tag-r{background:rgba(220,38,38,0.15);color:#ef4444;}
.tag-g{background:rgba(34,197,94,.12);color:#22c55e;}
.tag-d{background:rgba(255,255,255,.05);color:var(--gray2);}
.tag-y{background:rgba(245,158,11,.12);color:#f59e0b;}
.tag-b{background:rgba(59,130,246,.1);color:#60a5fa;}

/* ── LOG ── */
.la{max-height:280px;overflow-y:auto;font-family:'Courier New',monospace;font-size:11.5px;}
.lr{display:grid;grid-template-columns:70px 46px 1fr;gap:8px;align-items:center;padding:7px 18px;border-bottom:1px solid rgba(220,38,38,0.04);}
.lr:hover{background:rgba(220,38,38,0.03);}
.lt{color:var(--gray2);}
.ll{font-weight:700;font-size:10px;letter-spacing:.1em;}
.lr-error .ll{color:#ef4444;text-shadow:0 0 8px rgba(239,68,68,0.5);}
.lr-warn .ll{color:#f59e0b;}
.lr-reply .ll{color:#22c55e;}
.lr-info .ll{color:#60a5fa;}
.lr-idle .ll{color:var(--gray2);}
.lm{color:var(--off);}
.lr-error .lm{color:#fca5a5;}
.lr-warn .lm{color:#fde68a;}

/* ── FORMS ── */
.fld{margin-bottom:18px;}
.flbl{display:block;font-size:11px;font-weight:600;color:var(--gray);margin-bottom:7px;letter-spacing:.06em;text-transform:uppercase;}
.fi,.fs{width:100%;background:rgba(8,5,16,0.7);border:1px solid var(--border2);border-radius:10px;padding:10px 14px;color:var(--white);font-size:13px;font-family:inherit;transition:all .2s;outline:none;backdrop-filter:blur(8px);}
.fi:focus,.fs:focus{border-color:var(--red);box-shadow:0 0 0 3px rgba(220,38,38,0.12),var(--glow-sm);}
.fhint{font-size:11px;color:var(--gray2);margin-top:5px;}
.fs{appearance:none;}
.tr-row{display:flex;align-items:center;gap:12px;padding:10px 0;cursor:pointer;font-size:13px;color:var(--off);}
.tck{display:none;}
.ttr{width:38px;height:21px;border-radius:11px;background:var(--muted);position:relative;transition:all .25s;flex-shrink:0;box-shadow:inset 0 1px 3px rgba(0,0,0,0.4);}
.tth{width:15px;height:15px;background:var(--white);border-radius:50%;position:absolute;top:3px;left:3px;transition:transform .25s;box-shadow:0 2px 4px rgba(0,0,0,0.4);}
.tck:checked+.ttr{background:var(--red);box-shadow:0 0 10px rgba(220,38,38,0.4);}
.tck:checked+.ttr .tth{transform:translateX(17px);}
.btn{padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .2s cubic-bezier(.4,0,.2,1);border:1px solid transparent;display:inline-flex;align-items:center;gap:8px;}
.btn-r{background:linear-gradient(135deg,var(--red),var(--red-dim));color:#fff;border:none;box-shadow:0 4px 18px rgba(220,38,38,0.25);}
.btn-r:hover{box-shadow:0 4px 28px rgba(220,38,38,0.55),var(--glow-sm);transform:translateY(-1px);}
.btn-o{background:transparent;border-color:var(--border2);color:var(--gray);}
.btn-o:hover{border-color:var(--red);color:var(--red2);box-shadow:var(--glow-sm);}
.btn-sm{padding:7px 14px;font-size:12px;}
.btn-xs{padding:5px 10px;font-size:11px;}
.btn-danger{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.28);color:#ef4444;}
.btn-danger:hover{background:rgba(239,68,68,0.2);box-shadow:0 0 12px rgba(239,68,68,0.3);}
.add-row{display:flex;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);}
.ai{flex:1;background:rgba(8,5,16,0.6);border:1px solid var(--border2);border-radius:10px;padding:9px 14px;color:var(--white);font-size:13px;font-family:inherit;outline:none;transition:all .2s;}
.ai:focus{border-color:var(--red);box-shadow:0 0 0 2px rgba(220,38,38,0.1);}
.btn-a{background:linear-gradient(135deg,var(--red),var(--red-dim));border:none;color:#fff;padding:9px 18px;border-radius:10px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;box-shadow:0 0 12px rgba(220,38,38,0.2);}
.btn-a:hover{box-shadow:0 0 22px rgba(220,38,38,0.5);transform:translateY(-1px);}
.btn-rm{background:none;border:1px solid var(--border2);color:var(--gray2);width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:12px;transition:all .18s;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.btn-rm:hover{border-color:#ef4444;color:#ef4444;background:rgba(239,68,68,0.08);box-shadow:0 0 8px rgba(239,68,68,0.25);}
.ql{padding:10px 18px;display:flex;flex-direction:column;gap:5px;}
.qi{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:rgba(8,5,16,0.5);border:1px solid var(--border);transition:border-color .2s;}
.qi:hover{border-color:var(--border2);}
.qn{font-size:10.5px;font-weight:700;color:var(--red2);width:24px;flex-shrink:0;}
.qt{flex:1;font-size:12.5px;color:var(--off);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qu{font-family:monospace;font-size:11px;color:var(--gray);}
.qe{text-align:center;color:var(--gray2);font-size:12px;padding:28px 0;}

/* ── GRAPH ── */
.rg{display:flex;align-items:flex-end;gap:3px;height:90px;padding:0 4px;}
.rc{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;}
.rbw{flex:1;display:flex;align-items:flex-end;width:100%;}
.rb{width:100%;min-height:3px;background:linear-gradient(180deg,var(--red2),var(--red-dim));border-radius:3px 3px 0 0;transition:height .4s cubic-bezier(.4,0,.2,1);box-shadow:0 0 4px rgba(220,38,38,0.3);}
.rc:hover .rb{background:linear-gradient(180deg,#f87171,var(--red2));box-shadow:0 0 10px rgba(220,38,38,0.6);}
.rl{font-size:8px;color:var(--gray2);white-space:nowrap;}

/* ── TWO COL ── */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;}

/* ── CONFIG ── */
.cb{padding:18px 20px;}
.cfg-tabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:18px;}
.cfg-tab{padding:8px 15px;border-radius:8px;border:1px solid var(--border2);background:none;color:var(--gray);font-size:12px;font-family:inherit;cursor:pointer;transition:all .2s;}
.cfg-tab:hover{border-color:var(--red);color:var(--red2);}
.cfg-tab.active{background:linear-gradient(135deg,var(--red),var(--red-dim));border-color:transparent;color:#fff;box-shadow:0 0 14px rgba(220,38,38,0.3);}
.cc{display:none;}.cc.act{display:block;}
.save-bar{display:flex;justify-content:flex-end;padding:16px 20px;border-top:1px solid var(--border);}

/* ── COOKIE ── */
.ck-wrap{max-width:640px;margin:0 auto;text-align:center;padding:36px 24px;}
.ck-title{font-size:28px;font-weight:900;margin-bottom:10px;text-shadow:0 0 30px rgba(220,38,38,0.4);}
.ck-title span{color:var(--red2);}
.ck-desc{color:var(--gray);font-size:13.5px;line-height:1.7;margin-bottom:30px;}
.steps-g{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:26px;}
.step{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:left;transition:border-color .2s;}
.step:hover{border-color:var(--border2);}
.snum{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,var(--red),var(--red-dim));color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-bottom:9px;box-shadow:0 0 8px rgba(220,38,38,0.4);}
.stxt{font-size:12px;color:var(--off);line-height:1.6;}
.stxt b{color:var(--white);}
.ck-ta{width:100%;background:rgba(5,4,10,0.7);border:1px solid var(--border2);border-radius:12px;padding:14px;color:var(--gray);font-family:monospace;font-size:11.5px;line-height:1.6;min-height:110px;resize:vertical;outline:none;margin-bottom:16px;transition:all .2s;}
.ck-ta:focus{border-color:var(--red);color:var(--off);box-shadow:0 0 0 3px rgba(220,38,38,0.1);}
.ck-ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:10px;padding:12px 16px;font-size:12.5px;color:#22c55e;display:flex;align-items:center;gap:8px;margin-bottom:16px;text-align:left;}
.conn-btn{width:100%;padding:14px;background:linear-gradient(135deg,var(--red),var(--red-dim));border:none;border-radius:12px;color:#fff;font-size:14px;font-weight:800;letter-spacing:.05em;cursor:pointer;font-family:inherit;transition:all .25s;box-shadow:0 4px 24px var(--rg3);display:flex;align-items:center;justify-content:center;gap:10px;}
.conn-btn:hover{transform:translateY(-2px);box-shadow:0 8px 36px var(--rg4);}
.skip-btn{background:none;border:1px solid var(--border2);color:var(--gray);padding:9px 20px;border-radius:10px;cursor:pointer;font-size:12.5px;font-family:inherit;margin-top:12px;transition:all .2s;}
.skip-btn:hover{border-color:var(--red);color:var(--red2);}
.ck-note{font-size:11px;color:var(--gray2);margin-top:12px;}

/* ── ACCOUNT STATUS ── */
.acg{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
.ac{background:var(--card);backdrop-filter:blur(14px);border:1px solid var(--border);border-radius:14px;padding:20px;transition:all .25s;position:relative;overflow:hidden;}
.ac::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,transparent,var(--red),var(--red2),transparent);box-shadow:0 0 10px rgba(220,38,38,0.5);}
.ac:hover{border-color:var(--border2);box-shadow:0 0 20px rgba(220,38,38,0.1);}
.ac-lbl{font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--gray);text-transform:uppercase;margin-bottom:9px;display:flex;align-items:center;gap:6px;}
.ac-lbl svg{color:var(--red);filter:drop-shadow(0 0 4px rgba(220,38,38,0.6));}
.ac-val{font-size:22px;font-weight:800;color:var(--white);}
.ac-sub{font-size:11.5px;color:var(--gray);margin-top:4px;}
.ac-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:20px;font-size:11px;font-weight:600;background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.25);}
.ac-badge-r{background:rgba(220,38,38,.1);color:#ef4444;border-color:rgba(220,38,38,.25);}

/* ── ABOUT ── */
.ab-wrap{max-width:720px;}
.ab-hero{background:var(--card);backdrop-filter:blur(14px);border:1px solid var(--border);border-radius:16px;padding:34px;margin-bottom:18px;position:relative;overflow:hidden;}
.ab-hero::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--red),var(--red2),transparent);}
.ab-name{font-size:24px;font-weight:900;margin-bottom:4px;text-shadow:0 0 20px rgba(220,38,38,0.3);}
.ab-role{font-size:13px;color:var(--red2);font-weight:700;margin-bottom:18px;}
.ab-txt{font-size:13.5px;color:#b8b0cc;line-height:1.85;}
.ab-contact{background:var(--card);backdrop-filter:blur(14px);border:1px solid var(--border);border-radius:14px;padding:22px;}
.ab-ct-title{font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--gray);text-transform:uppercase;margin-bottom:14px;}
.ct-item{display:flex;align-items:center;gap:14px;padding:14px;background:rgba(8,5,16,0.5);border:1px solid var(--border);border-radius:10px;margin-bottom:10px;transition:border-color .2s;}
.ct-item:last-child{margin-bottom:0;}
.ct-item:hover{border-color:var(--border2);}
.ct-ico{width:34px;height:34px;background:rgba(220,38,38,0.12);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--red2);flex-shrink:0;}
.ct-val{font-size:13px;font-weight:600;color:var(--white);}
.ct-hint{font-size:11px;color:var(--gray);margin-top:2px;}

/* ── ADMIN ── */
.adm-banner{background:linear-gradient(135deg,rgba(153,27,27,0.2),rgba(220,38,38,0.08));border:1px solid rgba(220,38,38,0.25);border-radius:16px;padding:24px 28px;display:flex;align-items:center;gap:18px;margin-bottom:22px;position:relative;overflow:hidden;}
.adm-banner::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--red),transparent);}
.adm-ic{width:52px;height:52px;background:linear-gradient(135deg,var(--red),var(--red-dim));border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:var(--glow-red);}
.adm-title{font-size:18px;font-weight:900;text-shadow:0 0 20px rgba(220,38,38,0.3);}
.adm-sub{font-size:12px;color:var(--gray);margin-top:4px;}

/* ── AUTH PAGES ── */
.auth-pg{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;position:relative;overflow:hidden;}
.auth-pg::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 40%,rgba(120,0,0,0.18) 0%,transparent 65%),var(--bg);z-index:0;}
.auth-card{
  width:100%;max-width:420px;position:relative;z-index:1;
  background:rgba(12,8,22,0.92);backdrop-filter:blur(32px);
  border:1px solid var(--border2);border-radius:20px;
  padding:36px 32px;
  box-shadow:0 0 60px rgba(220,38,38,0.15),0 24px 60px rgba(0,0,0,0.7);
}
.auth-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:20px 20px 0 0;background:linear-gradient(90deg,transparent,var(--red),var(--red2),var(--red),transparent);background-size:200% 100%;animation:borderFlow 4s linear infinite;}
.auth-logo{display:flex;align-items:center;gap:14px;margin-bottom:28px;}
.auth-li{width:44px;height:44px;background:linear-gradient(135deg,var(--red),var(--red-dim));border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:var(--glow-red);flex-shrink:0;}
.auth-lt{font-size:14px;font-weight:900;letter-spacing:.1em;text-shadow:0 0 20px rgba(220,38,38,0.4);}
.auth-ls{font-size:10px;color:var(--gray);letter-spacing:.06em;margin-top:1px;}
.auth-h{font-size:22px;font-weight:900;margin-bottom:6px;}
.auth-s{color:var(--gray);font-size:13px;margin-bottom:22px;}
.aerr{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.28);border-radius:10px;padding:11px 14px;font-size:12.5px;color:#f87171;margin-bottom:18px;display:flex;align-items:center;gap:8px;}
.af{margin-bottom:16px;}
.al{display:block;font-size:10.5px;font-weight:700;color:var(--gray);margin-bottom:7px;letter-spacing:.08em;text-transform:uppercase;}
.ain{width:100%;background:rgba(5,4,10,0.7);border:1px solid var(--border2);border-radius:11px;padding:11px 15px;color:var(--white);font-size:13px;font-family:inherit;outline:none;transition:all .2s;}
.ain:focus{border-color:var(--red);box-shadow:0 0 0 3px rgba(220,38,38,0.12),var(--glow-sm);}
.asub{width:100%;padding:13px;background:linear-gradient(135deg,var(--red),var(--red-dim));border:none;border-radius:12px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;transition:all .25s;box-shadow:0 4px 22px var(--rg3);letter-spacing:.04em;}
.asub:hover{box-shadow:0 4px 36px var(--rg4);transform:translateY(-1px);}
.afoot{margin-top:20px;text-align:center;font-size:12.5px;color:var(--gray);}
.afoot a{color:var(--red2);font-weight:600;transition:color .15s;}
.afoot a:hover{color:var(--red3);}

/* ── MUSIC PLAYER ── */
.music-bar{
  position:fixed;bottom:0;left:0;right:0;z-index:200;
  background:rgba(8,5,18,0.95);backdrop-filter:blur(24px);
  border-top:1px solid var(--border2);
  display:flex;align-items:center;padding:10px 24px;gap:20px;
  box-shadow:0 -4px 40px rgba(220,38,38,0.15);
  height:62px;
}
.music-bar::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--red),var(--red2),var(--red),transparent);background-size:200% 100%;animation:borderFlow 4s linear infinite;}
.music-waves{display:flex;align-items:flex-end;gap:3px;height:22px;flex-shrink:0;}
.music-wave-bar{width:3px;border-radius:2px;background:var(--red2);box-shadow:0 0 6px rgba(239,68,68,0.6);}
.music-wave-bar.paused{animation:none!important;height:3px!important;}
.music-wave-bar:nth-child(1){animation:wave 0.9s ease-in-out infinite;}
.music-wave-bar:nth-child(2){animation:wave 0.7s ease-in-out infinite 0.1s;}
.music-wave-bar:nth-child(3){animation:wave 1.1s ease-in-out infinite 0.2s;}
.music-wave-bar:nth-child(4){animation:wave 0.8s ease-in-out infinite 0.3s;}
.music-wave-bar:nth-child(5){animation:wave 1.0s ease-in-out infinite 0.15s;}
@keyframes wave{0%,100%{height:4px;}50%{height:20px;}}
.music-title{font-size:12px;font-weight:600;color:var(--off);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}
.music-title span{font-size:10px;color:var(--gray);display:block;margin-top:1px;}
.music-ctrl{background:none;border:1px solid var(--border2);color:var(--gray);width:32px;height:32px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0;}
.music-ctrl:hover{border-color:var(--red);color:var(--red2);box-shadow:var(--glow-sm);}
.music-vol{appearance:none;width:90px;height:3px;background:var(--border2);border-radius:2px;outline:none;cursor:pointer;flex-shrink:0;}
.music-vol::-webkit-slider-thumb{appearance:none;width:14px;height:14px;background:var(--red2);border-radius:50%;box-shadow:0 0 8px rgba(239,68,68,0.6);cursor:pointer;transition:box-shadow .2s;}
.music-vol::-webkit-slider-thumb:hover{box-shadow:0 0 14px rgba(239,68,68,0.9);}
.music-label{font-size:10px;color:var(--gray);letter-spacing:.06em;flex-shrink:0;}

/* ── MISC ── */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
@media(max-width:900px){.sg{grid-template-columns:repeat(2,1fr);}.two-col{grid-template-columns:1fr;}}
@media(max-width:600px){.sg{grid-template-columns:1fr;}}
`;

// ─── ICONS ────────────────────────────────────────────────────────────────────
const I = {
    dash:   `<svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`,
    user:   `<svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    info:   `<svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    shield: `<svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    loop:   `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
    globe:  `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    logout: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
    bell:   `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    clock:  `<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    bot:    `<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/></svg>`,
    admin:  `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
};

// ─── MUSIC PLAYER HTML ────────────────────────────────────────────────────────
const MUSIC_PLAYER = `
<div class="music-bar" id="musicBar">
  <div class="music-waves" id="musicWaves">
    <div class="music-wave-bar" style="height:8px"></div>
    <div class="music-wave-bar" style="height:14px"></div>
    <div class="music-wave-bar" style="height:20px"></div>
    <div class="music-wave-bar" style="height:12px"></div>
    <div class="music-wave-bar" style="height:18px"></div>
  </div>
  <div class="music-title">
    ${MUSIC_NAME}
    <span>Background Music • Looping</span>
  </div>
  <span class="music-label">VOL</span>
  <input type="range" class="music-vol" id="volSlider" min="0" max="1" step="0.05" value="0.35" oninput="setMusicVol(this.value)">
  <button class="music-ctrl" id="musicBtn" onclick="toggleMusic()" title="Play/Pause">
    <svg id="musicIcon" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
  </button>
  <audio id="bgMusic" loop>
    <source src="${MUSIC_URL}" type="audio/mpeg">
  </audio>
</div>
<script>
(function(){
  const audio = document.getElementById('bgMusic');
  const btn   = document.getElementById('musicBtn');
  const icon  = document.getElementById('musicIcon');
  const waves = document.getElementById('musicWaves');
  const vol   = document.getElementById('volSlider');
  let playing = false;

  const PLAY_ICON  = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const PAUSE_ICON = '<polygon points="5 3 19 12 5 21 5 3"/>';

  function setPlaying(p) {
    playing = p;
    icon.innerHTML = p ? PLAY_ICON : PAUSE_ICON;
    Array.from(waves.children).forEach(b => b.classList.toggle('paused', !p));
  }

  audio.volume = parseFloat(vol.value);

  function tryPlay() {
    if (!playing) {
      audio.play().then(() => setPlaying(true)).catch(() => {
        document.addEventListener('click', function startOnClick() {
          if (!playing) audio.play().then(() => setPlaying(true)).catch(()=>{});
          document.removeEventListener('click', startOnClick);
        }, { once: true });
      });
    }
  }

  window.toggleMusic = function() {
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.play().then(() => setPlaying(true)).catch(()=>{}); }
  };
  window.setMusicVol = function(v) { audio.volume = parseFloat(v); };

  tryPlay();
})();
</script>
`;

// ─── AUTH PAGES ───────────────────────────────────────────────────────────────
function buildLoginPage(err) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DUMMYL BOT — Login</title><style>${CSS}body{display:block;}</style></head><body>
<div class="auth-pg">
<div class="auth-card">
  <div class="auth-logo">
    <div class="auth-li">${I.bot}</div>
    <div><div class="auth-lt">DUMMYL BOT</div><div class="auth-ls">Messenger Automation Platform</div></div>
  </div>
  <h1 class="auth-h">Welcome back</h1>
  <p class="auth-s">Sign in to access your bot dashboard.</p>
  ${err?`<div class="aerr"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${esc(err)}</div>`:""}
  <form method="POST" action="/api/auth/login">
    <div class="af"><label class="al">Email Address</label><input class="ain" type="email" name="email" placeholder="you@example.com" required autocomplete="email"/></div>
    <div class="af"><label class="al">Password</label><input class="ain" type="password" name="password" placeholder="••••••••" required autocomplete="current-password"/></div>
    <button class="asub" type="submit">Sign In</button>
  </form>
  <div class="afoot">Don't have an account? <a href="/register">Create one</a></div>
</div>
</div>
</body></html>`;
}

function buildRegisterPage(err) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DUMMYL BOT — Register</title><style>${CSS}body{display:block;}</style></head><body>
<div class="auth-pg">
<div class="auth-card">
  <div class="auth-logo">
    <div class="auth-li">${I.bot}</div>
    <div><div class="auth-lt">DUMMYL BOT</div><div class="auth-ls">Messenger Automation Platform</div></div>
  </div>
  <h1 class="auth-h">Create account</h1>
  <p class="auth-s">Join to manage your Facebook Messenger bot.</p>
  ${err?`<div class="aerr"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${esc(err)}</div>`:""}
  <form method="POST" action="/api/auth/register">
    <div class="af"><label class="al">Username</label><input class="ain" type="text" name="username" placeholder="Your name" required autocomplete="name"/></div>
    <div class="af"><label class="al">Email Address</label><input class="ain" type="email" name="email" placeholder="you@example.com" required autocomplete="email"/></div>
    <div class="af"><label class="al">Password</label><input class="ain" type="password" name="password" placeholder="Min. 6 characters" required autocomplete="new-password"/></div>
    <div class="af"><label class="al">Confirm Password</label><input class="ain" type="password" name="confirm" placeholder="Repeat password" required autocomplete="new-password"/></div>
    <button class="asub" type="submit">Create Account</button>
  </form>
  <div class="afoot">Already have an account? <a href="/login">Sign in</a></div>
</div>
</div>
</body></html>`;
}

// ─── LAYOUT ───────────────────────────────────────────────────────────────────
function buildLayout(session, mainTab, innerContent) {
    const us   = getUserState(session.userId);
    const isOn = us.loggedIn, isRecon = us.reconnecting;
    const stCls = isOn?"st-on":(isRecon?"st-warn":"st-off");
    const stLbl = isOn?"Online":(isRecon?"Reconnecting":"Offline");
    const nav   = (id, icon, label) =>
        `<a class="ni${mainTab===id?" act":""}" href="/?tab=${id}">${icon}<span class="lbl">${label}</span></a>`;
    const initials = (session.username||"U").slice(0,2).toUpperCase();

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DUMMYL BOT</title>
<style>${CSS}</style>
</head><body>
<div class="sb" id="sb">
  <div class="sb-top">
    <div class="sb-logo"><svg width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/></svg></div>
    <div class="sb-brand"><div class="sb-name">DUMMYL BOT</div><div class="sb-sub">v2.3 PLATFORM</div></div>
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
      <div class="st-badge ${stCls}"><div class="st-dot"></div>${stLbl}${us.botName?` — ${esc(us.botName)}`:""}</div>
    </div>
  </div>
  <div class="mc">${innerContent}</div>
</div>
${MUSIC_PLAYER}
<script>
function toggleSb(){var s=document.getElementById('sb'),m=document.getElementById('mw');s.classList.toggle('col');m.classList.toggle('col');localStorage.setItem('sb_col',s.classList.contains('col')?'1':'0');}
(function(){if(localStorage.getItem('sb_col')==='1'){document.getElementById('sb').classList.add('col');document.getElementById('mw').classList.add('col');}})();
function showCfg(id,btn){document.querySelectorAll('.cc').forEach(e=>e.classList.remove('act'));document.querySelectorAll('.cfg-tab').forEach(e=>e.classList.remove('active'));document.getElementById('cc-'+id).classList.add('act');btn.classList.add('active');}
</script>
</body></html>`;
}

// ─── DASHBOARD CONTENT ────────────────────────────────────────────────────────
function buildDashboardContent(userId, innerTab) {
    const itab    = innerTab || "overview";
    const us      = getUserState(userId);
    const cfg     = readBotConfig(userId);
    const customReplies = readCustomReplies(userId);
    const imageReplies  = readImageReplies(userId);
    const customCmds    = readCustomCommands(userId);
    const whitelist     = readWhitelist(userId);
    const threadCfg     = readThreadConfig(userId);

    const threads       = Object.keys({...us.loopEnabled,...us.autoRespondEnabled});
    const uniqueThreads = [...new Set(threads)];
    const loopCount     = Object.values(us.loopEnabled||{}).filter(Boolean).length;
    const arCount       = Object.values(us.autoRespondEnabled||{}).filter(Boolean).length;
    const mutedCount    = Object.values(us.mutedThreads||{}).filter(Boolean).length;
    const hasFbstate    = getFbstateFiles(userId).length > 0;

    const INNER_TABS = [
        {id:"overview", label:"Overview",    icon:`<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`},
        {id:"loop",     label:"Loop Queue",  icon:I.loop},
        {id:"threads",  label:"Threads",     icon:`<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`},
        {id:"config",   label:"Config",      icon:`<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`},
        {id:"cookie",   label:"Cookie",      icon:`<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`},
        {id:"cmds",     label:"Custom Cmds", icon:`<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`},
        {id:"commands", label:"Commands",    icon:`<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`},
    ];

    const tabBar = `<div class="itabs">${INNER_TABS.map(t=>`<a class="itab${itab===t.id?" act":""}" href="/?tab=dashboard&itab=${t.id}">${t.icon} ${t.label}</a>`).join("")}</div>`;

    const botPills = us.bots.length===0
        ? `<span class="pill p-off"><i></i>No bots loaded</span>`
        : us.bots.map(b=>{const cls=b.loggedIn?"p-on":(b.reconnecting?"p-warn":"p-off");const lbl=b.loggedIn?"Online":(b.reconnecting?`Reconnecting ${b.nextReconnectIn}s`:"Offline");return `<span class="pill ${cls}"><i></i>${esc(b.label)} — ${lbl}</span>`;}).join("");

    const logRows = us.logs.length===0
        ? `<div class="lr lr-idle"><span class="lt">--:--</span><span class="ll">IDLE</span><span class="lm">Waiting for events…</span></div>`
        : us.logs.slice(0,120).map(l=>`<div class="lr lr-${l.type}"><span class="lt">${esc(l.time)}</span><span class="ll">${{error:"ERR",warn:"WARN",reply:"OUT",info:"INFO"}[l.type]||"INFO"}</span><span class="lm">${esc(l.message)}</span></div>`).join("");

    const pageOverview = `
<div class="hero">
  <div class="hero-in">
    <div class="hero-l">
      <div class="hero-ic">${I.bot}</div>
      <div>
        <div class="hero-title">DUMMYL BOT <span class="hero-ver">v2.3</span></div>
        <div class="hero-desc">loop · auto-respond · lock · pm-loop · tts · song player · group tools</div>
        <div class="hero-pills">${botPills}</div>
      </div>
    </div>
  </div>
</div>
<div class="sg">
  <div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><div class="sc-val">${us.totalRepliesSent}</div><div class="sc-lbl">Messages Sent</div></div>
  <div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w">${I.loop}</div><div class="sc-val">${loopCount}</div><div class="sc-lbl">Active Loops</div></div>
  <div class="sc"><div class="sc-glow gc-g"></div><div class="sc-ico ci-g"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg></div><div class="sc-val">${arCount}</div><div class="sc-lbl">Auto-Respond <span class="sc-sub">${mutedCount} muted</span></div></div>
  <div class="sc"><div class="sc-glow gc-o"></div><div class="sc-ico ci-o"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="sc-val" style="font-size:20px">${getUptime(userId)}</div><div class="sc-lbl">Uptime</div></div>
</div>
<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Message Rate (Last 24h)</div>
<div class="box" style="padding:16px 18px">
  <div class="bh" style="border:none;padding:0 0 12px"><span class="chip">GRAPH</span><span class="bt">Hourly Volume</span></div>
  <div class="rg">${(()=>{const b=getHourlyStats(userId);const mx=Math.max(...b,1);return b.map((v,i)=>{const pct=Math.round((v/mx)*100);const hr=(new Date().getHours()-23+i+24)%24;const label=`${String(hr).padStart(2,"0")}:00`;return `<div class="rc"><div class="rbw"><div class="rb" style="height:${pct}%" title="${v} msgs at ${label}"></div></div><div class="rl">${hr%6===0?label:""}</div></div>`;}).join("")})()}</div>
</div>
<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Thread Registry</div>
<div class="box">
  <div class="bh"><span class="chip chip-g">LIVE</span><span class="bt">Active Threads</span><span class="bm">${uniqueThreads.length} registered</span></div>
  <table><thead><tr><th>Thread ID</th><th>Loop</th><th>Auto-Respond</th></tr></thead><tbody>${uniqueThreads.length===0?`<tr><td colspan="3" class="td-e">No threads yet — send <code>.</code> in Messenger to start a loop</td></tr>`:uniqueThreads.map(tid=>{const loop=us.loopEnabled&&us.loopEnabled[tid];const ar=us.autoRespondEnabled&&us.autoRespondEnabled[tid];const muted=us.mutedThreads&&us.mutedThreads[tid];return `<tr><td class="td-m">${esc(tid)}</td><td>${loop?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td><td>${ar?`<span class="tag tag-b">ON</span>`:`<span class="tag tag-d">OFF</span>`}${muted?` <span class="tag tag-y">MUTED</span>`:""}</td></tr>`;}).join("")}</tbody></table>
</div>
${us.alerts.length>0?`<div class="shd">${I.bell} Notification Feed</div><div class="box" style="padding:0"><div class="bh"><span class="chip chip-y">ALERTS</span><span class="bt">Recent Events</span><span class="bm">${us.alerts.length}</span></div><div class="la">${us.alerts.map(a=>`<div class="lr lr-${a.type==="error"?"error":a.type==="warn"?"warn":"info"}"><span class="lt">${esc(a.time)}</span><span class="ll">${a.type.toUpperCase()}</span><span class="lm">${esc(a.message)}</span></div>`).join("")}</div></div>`:""}
<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Live Console</div>
<div class="box" style="padding:0"><div class="bh"><span class="chip">LOG</span><span class="bt">Real-time Events</span><span class="bm">${us.logs.length} entries</span></div><div class="la">${logRows}</div></div>`;

    const textRows = customReplies.length===0?`<div class="qe">Queue empty — add a message above</div>`:customReplies.map((w,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt">${esc(w)}</span><form method="POST" action="/api/replies/remove?tab=dashboard&itab=loop" style="margin:0"><input type="hidden" name="index" value="${i}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("");
    const imgRows  = imageReplies.length===0?`<div class="qe">No image URLs yet</div>`:imageReplies.map((u,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt qu">${esc(u)}</span><form method="POST" action="/api/images/remove?tab=dashboard&itab=loop" style="margin:0"><input type="hidden" name="index" value="${i}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("");
    const pageLoop = `<div class="two-col">
<div><div class="shd">${I.loop} Text Pool</div><div class="box"><div class="bh"><span class="chip">QUEUE</span><span class="bt">Loop Messages</span><span class="bm">${customReplies.length}</span></div><form class="add-row" method="POST" action="/api/replies/add?tab=dashboard&itab=loop"><input class="ai" type="text" name="word" placeholder="Add message to loop pool…" required/><button class="btn-a" type="submit">+ Add</button></form><div class="ql">${textRows}</div></div></div>
<div><div class="shd">${I.globe} Image Pool</div><div class="box"><div class="bh"><span class="chip chip-p">IMAGES</span><span class="bt">Image URLs</span><span class="bm">${imageReplies.length}</span></div><form class="add-row" method="POST" action="/api/images/add?tab=dashboard&itab=loop"><input class="ai" type="url" name="url" placeholder="https://example.com/image.jpg" required/><button class="btn-a" type="submit">+ Add</button></form><div class="ql">${imgRows}</div></div></div>
</div>`;

    const allThreads = [...new Set(Object.keys({...us.loopEnabled,...us.autoRespondEnabled,...(readThreadConfig(userId)||{})}))];
    const pageThreads = `
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
  <form method="POST" action="/api/thread/stopall?tab=dashboard&itab=threads"><button class="btn btn-danger btn-sm" type="submit">Stop All Loops</button></form>
  <span style="font-size:12px;color:var(--gray)">${allThreads.length} known threads</span>
  ${whitelist.enabled?`<span class="tag tag-y">WHITELIST ON</span>`:`<span class="tag tag-d">WHITELIST OFF</span>`}
  <form method="POST" action="/api/whitelist/toggle?tab=dashboard&itab=threads" style="margin:0"><button class="btn btn-o btn-sm" type="submit">${whitelist.enabled?"Disable":"Enable"} Whitelist</button></form>
</div>
<div class="box"><div class="bh"><span class="chip">THREADS</span><span class="bt">Thread Manager</span></div>
<table><thead><tr><th>Thread ID</th><th>Loop</th><th>Auto-Respond</th><th>Actions</th></tr></thead><tbody>
${allThreads.length===0?`<tr><td colspan="4" class="td-e">No threads detected yet</td></tr>`:allThreads.map(tid=>{const loop=us.loopEnabled&&us.loopEnabled[tid];const ar=us.autoRespondEnabled&&us.autoRespondEnabled[tid];return `<tr><td class="td-m">${esc(tid)}</td><td>${loop?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td><td>${ar?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td><td style="display:flex;gap:6px;"><form method="POST" action="/api/thread/${loop?"stoploop":"startloop"}?tab=dashboard&itab=threads" style="margin:0"><input type="hidden" name="threadID" value="${esc(tid)}"/><button class="btn btn-o btn-xs">${loop?"Stop":"Start"} Loop</button></form></td></tr>`;}).join("")}
</tbody></table></div>
<div class="shd">${I.shield} Whitelist UIDs</div>
<div class="box"><div class="bh"><span class="chip">${whitelist.enabled?"ACTIVE":"INACTIVE"}</span><span class="bt">Allowed UIDs</span><span class="bm">${(whitelist.uids||[]).length} UIDs</span></div>
<form class="add-row" method="POST" action="/api/whitelist/add?tab=dashboard&itab=threads"><input class="ai" type="text" name="uid" placeholder="Facebook UID to whitelist…" required/><button class="btn-a" type="submit">+ Add</button></form>
<div class="ql">${(whitelist.uids||[]).length===0?`<div class="qe">No UIDs whitelisted yet</div>`:(whitelist.uids||[]).map((uid,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt qu">${esc(uid)}</span><form method="POST" action="/api/whitelist/remove?tab=dashboard&itab=threads" style="margin:0"><input type="hidden" name="uid" value="${esc(uid)}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("")}</div></div>`;

    function toggle(name, label, val) { return `<label class="tr-row"><input type="checkbox" class="tck" name="${name}"${val?" checked":""}><span class="ttr"><span class="tth"></span></span>${label}</label>`; }
    const pageConfig = `<div class="box">
<div class="bh"><span class="chip">CONFIG</span><span class="bt">Bot Configuration</span></div>
<div class="cb">
<div class="cfg-tabs">
  <button class="cfg-tab active" onclick="showCfg('loop',this)">Loop</button>
  <button class="cfg-tab" onclick="showCfg('respond',this)">Auto-Respond</button>
  <button class="cfg-tab" onclick="showCfg('security',this)">Security</button>
  <button class="cfg-tab" onclick="showCfg('misc',this)">Misc</button>
</div>
<form method="POST" action="/api/config/save?tab=dashboard&itab=config">
<div id="cc-loop" class="cc act">
  <div class="two-col">
    <div class="fld"><label class="flbl">Loop Delay (seconds)</label><input class="fi" type="number" name="loopDelay" value="${cfg.loopDelay||1}" min="0.1" step="0.1"/></div>
    <div class="fld"><label class="flbl">Image Probability (%)</label><input class="fi" type="number" name="imageProbability" value="${cfg.imageProbability||20}" min="0" max="100"/></div>
    <div class="fld"><label class="flbl">Loop Mode</label><select class="fs" name="loopMode"><option value="sequential"${cfg.loopMode==="sequential"?" selected":""}>Sequential</option><option value="shuffle"${cfg.loopMode==="shuffle"?" selected":""}>Shuffle</option></select></div>
    <div class="fld"><label class="flbl">Loop React Emoji</label><input class="fi" type="text" name="loopReact" value="${esc(cfg.loopReact||"😆")}"/></div>
    <div class="fld"><label class="flbl">Max Loop Count (0=∞)</label><input class="fi" type="number" name="maxLoopCount" value="${cfg.maxLoopCount||0}" min="0"/></div>
    <div class="fld"><label class="flbl">Auto-Stop (minutes, 0=off)</label><input class="fi" type="number" name="autoStopMinutes" value="${cfg.autoStopMinutes||0}" min="0"/></div>
    <div class="fld"><label class="flbl">Loop Start Message</label><input class="fi" type="text" name="loopStartMsg" value="${esc(cfg.loopStartMsg||"")}"/></div>
    <div class="fld"><label class="flbl">Loop Stop Message</label><input class="fi" type="text" name="loopStopMsg" value="${esc(cfg.loopStopMsg||"")}"/></div>
  </div>
  ${toggle("reactOnlyMode","React-Only Mode (no text, only react)",cfg.reactOnlyMode)}
  ${toggle("loopSilentMode","Silent Loop (no push notification)",cfg.loopSilentMode)}
</div>
<div id="cc-respond" class="cc">
  ${toggle("greetNewMembers","Greet new group members",cfg.greetNewMembers)}
  <div class="fld" style="margin-top:12px"><label class="flbl">Greet Message</label><input class="fi" type="text" name="greetMsg" value="${esc(cfg.greetMsg||"Welcome! 👋")}"/></div>
  ${toggle("silentMode","Silent Mode (no push on auto-reply)",cfg.silentMode)}
  ${toggle("autoReactEnabled","Auto-React to all incoming messages",cfg.autoReactEnabled)}
  <div class="fld" style="margin-top:12px"><label class="flbl">Auto-React Emoji</label><input class="fi" type="text" name="autoReactEmoji" value="${esc(cfg.autoReactEmoji||"😆")}"/></div>
</div>
<div id="cc-security" class="cc">
  ${toggle("antiSpamEnabled","Anti-Spam (kick fast senders)",cfg.antiSpamEnabled)}
  <div class="two-col" style="margin-top:12px">
    <div class="fld"><label class="flbl">Max Messages</label><input class="fi" type="number" name="antiSpamMaxMsg" value="${cfg.antiSpamMaxMsg||5}" min="1"/></div>
    <div class="fld"><label class="flbl">Window (seconds)</label><input class="fi" type="number" name="antiSpamWindowSec" value="${cfg.antiSpamWindowSec||10}" min="1"/></div>
  </div>
</div>
<div id="cc-misc" class="cc">
  <div class="fld"><label class="flbl">TTS Language</label><input class="fi" type="text" name="ttsLang" value="${esc(cfg.ttsLang||"tl")}"/><div class="fhint">e.g. tl, en, ja, ko, zh-CN</div></div>
  ${toggle("autoSeenEnabled","Auto Mark as Seen",cfg.autoSeenEnabled)}
  ${toggle("typingSimulate","Simulate Typing Indicator",cfg.typingSimulate)}
</div>
<div class="save-bar"><button class="btn btn-r" type="submit">Save Configuration</button></div>
</form>
</div></div>`;

    const fbFiles = getFbstateFiles(userId);
    const slotRows = fbFiles.length>0?fbFiles.map(f=>`<option value="${esc(f)}">${esc(f)}</option>`).join(""):`<option value="fbstate.json">fbstate.json (default)</option>`;
    const pageCookie = `<div class="ck-wrap">
<div class="ck-title">Connect Your <span>Facebook</span></div>
<p class="ck-desc">Paste your fbstate.json cookie to connect your Facebook account. This is required to run the bot.</p>
<div class="steps-g">
  <div class="step"><div class="snum">1</div><div class="stxt">Install <b>c3c-ufc-utility</b> Chrome extension or use a cookie exporter</div></div>
  <div class="step"><div class="snum">2</div><div class="stxt">Log in to <b>facebook.com</b> in your browser</div></div>
  <div class="step"><div class="snum">3</div><div class="stxt">Click the extension, choose <b>Export as JSON</b></div></div>
  <div class="step"><div class="snum">4</div><div class="stxt">Paste the JSON output below and click <b>Connect Bot</b></div></div>
</div>
<form method="POST" action="/api/cookie/slot">
  <div class="fld"><label class="flbl">Target Slot</label><select class="fs" name="slot" style="margin-bottom:14px">${slotRows}<option value="fbstate2.json">fbstate2.json (slot 2)</option><option value="fbstate3.json">fbstate3.json (slot 3)</option></select></div>
  <textarea class="ck-ta" name="cookie" placeholder='[{"key":"c_user","value":"..."},...]' rows="5"></textarea>
  <button class="conn-btn" type="submit">
    <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
    Connect Bot
  </button>
</form>
<div class="ck-note">Your cookie is stored privately and never shared.</div>
</div>`;

    const cmdRows = customCmds.length===0?`<div class="qe">No custom commands yet</div>`:customCmds.map((c,i)=>`<div class="qi"><span class="qn">${String(i+1).padStart(2,"0")}</span><span class="qt" style="font-weight:600;color:var(--red2)">${esc(c.cmd)}</span><span style="color:var(--gray);font-size:11px;margin:0 6px">→</span><span class="qt">${esc(c.reply)}</span><form method="POST" action="/api/cmds/remove?tab=dashboard&itab=cmds" style="margin:0"><input type="hidden" name="index" value="${i}"/><button class="btn-rm" type="submit">✕</button></form></div>`).join("");
    const pageCmds = `<div class="shd"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Custom Commands</div>
<div class="box"><div class="bh"><span class="chip chip-b">CMDS</span><span class="bt">Custom !Command Builder</span><span class="bm">${customCmds.length}</span></div>
<form class="add-row" method="POST" action="/api/cmds/add?tab=dashboard&itab=cmds" style="flex-wrap:wrap;gap:8px">
  <input class="ai" type="text" name="cmd" placeholder="!command" style="flex:0 1 120px" required/>
  <input class="ai" type="text" name="reply" placeholder="Bot reply text…" required/>
  <button class="btn-a" type="submit">+ Add</button>
</form>
<div class="ql">${cmdRows}</div></div>`;

    const pageCommands = `<div class="box"><div class="bh"><span class="chip">REF</span><span class="bt">Full Command Reference</span></div><div style="padding:20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
${[["LOOP","<code>.</code> — toggle loop (current thread)<br><code>. &lt;uid/name&gt;</code> — toggle PM loop<br><code>!stop</code> · <code>!looppm &lt;uid&gt;</code> · <code>!stoppm &lt;uid&gt;</code><br><code>!schedule &lt;sec&gt; &lt;msg&gt;</code>"],
["AUTO-RESPOND","<code>!on</code> / <code>!off</code> · <code>!mute</code> / <code>!unmute</code><br><code>!broadcast &lt;text&gt;</code>"],
["GROUP TOOLS","<code>!nn &lt;name&gt;</code> · <code>!nn1 &lt;uid&gt; &lt;name&gt;</code> · <code>!clearnn</code><br><code>!cg &lt;name&gt;</code> · <code>!uncg</code> · <code>!banner [url]</code> · <code>!unbanner</code><br><code>!kick / !add / !promote / !demote &lt;uid&gt;</code><br><code>!emoji</code> · <code>!color &lt;name&gt;</code> · <code>!freeze / !unfreeze</code>"],
["SECURITY","<code>!gmute / !gunmute &lt;uid&gt;</code><br><code>!perms &lt;uid&gt; &lt;time&gt;</code> · <code>!revoke [uid]</code><br><code>!members</code> · <code>!forward &lt;tid&gt; &lt;msg&gt;</code>"],
["VOICE & MUSIC","<code>!vm &lt;text&gt;</code> — TTS voice message<br><code>!vmpm &lt;uid&gt; &lt;text&gt;</code> — TTS to PM<br><code>!p &lt;song name&gt;</code> — search YouTube<br><code>!p &lt;youtube url&gt;</code> — direct URL"],
["UTILITIES","<code>!say</code> · <code>!spam</code> · <code>!count</code> · <code>!react &lt;emoji&gt;</code><br><code>!seen</code> · <code>!id</code> · <code>!myid</code> · <code>!info</code> · <code>!status</code><br><code>!lock</code> · <code>!gp [url/off]</code> · <code>!antirestrict</code> · <code>!test</code>"],
["FUN","<code>!flip</code> · <code>!roll [n]</code> · <code>!8ball &lt;q&gt;</code><br><code>!pick a|b|c</code> · <code>!reverse</code> · <code>!shout</code> · <code>!mock</code><br><code>!clap</code> · <code>!timer &lt;sec&gt;</code> · <code>!repeat &lt;n&gt; &lt;text&gt;</code>"]].map(([title,cmds])=>`<div style="background:rgba(8,5,16,0.5);border:1px solid var(--border);border-radius:12px;padding:16px;transition:border-color .2s;" onmouseenter="this.style.borderColor='rgba(220,38,38,0.25)'" onmouseleave="this.style.borderColor='var(--border)'"><div style="font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--red2);text-transform:uppercase;margin-bottom:10px;">${title}</div><div style="font-size:12.5px;color:var(--off);line-height:1.9">${cmds}</div></div>`).join("")}
</div></div>`;

    const pages = {overview:pageOverview, loop:pageLoop, threads:pageThreads, config:pageConfig, cookie:pageCookie, cmds:pageCmds, commands:pageCommands};
    return tabBar + (pages[itab] || pageOverview);
}

// ─── ACCOUNT STATUS TAB ───────────────────────────────────────────────────────
function buildAccountContent(userId) {
    const us       = getUserState(userId);
    const ai       = getAccountInfo(userId);
    const isOnline = us.loggedIn;
    const uptime   = getUptime(userId);
    const threads  = [...new Set(Object.keys({...us.loopEnabled,...us.autoRespondEnabled}))];
    const loopCnt  = Object.values(us.loopEnabled||{}).filter(Boolean).length;

    function card(label, value, sub, icon) {
        return `<div class="ac"><div class="ac-lbl">${icon||""} ${label}</div><div class="ac-val">${value}</div>${sub?`<div class="ac-sub">${sub}</div>`:""}`;
    }
    return `<div class="shd">${I.user} Bot Account</div>
<div class="acg">
  <div class="ac"><div class="ac-lbl"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Status</div>
    <div class="ac-val">${isOnline?`<span class="ac-badge">● Online</span>`:`<span class="ac-badge-r ac-badge">● Offline</span>`}</div>
    <div class="ac-sub">Connected bots: ${us.bots.filter(b=>b.loggedIn).length}/${us.bots.length}</div>
  </div>
  <div class="ac"><div class="ac-lbl"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Bot Identity</div>
    <div class="ac-val" style="font-size:15px">${esc(ai.name||us.botName||"—")}</div>
    <div class="ac-sub">${ai.uid?"UID: "+esc(ai.uid):"Not connected"}</div>
  </div>
  <div class="ac"><div class="ac-lbl"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Messages Sent</div>
    <div class="ac-val">${us.totalRepliesSent}</div>
    <div class="ac-sub">${loopCnt} active loop(s)</div>
  </div>
  <div class="ac"><div class="ac-lbl"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Uptime</div>
    <div class="ac-val" style="font-size:18px">${uptime}</div>
    <div class="ac-sub">Since ${us.startedAt.toLocaleTimeString()}</div>
  </div>
  <div class="ac"><div class="ac-lbl"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Threads</div>
    <div class="ac-val">${threads.length}</div>
    <div class="ac-sub">${loopCnt} looping, ${Object.values(us.autoRespondEnabled||{}).filter(Boolean).length} auto-respond</div>
  </div>
  <div class="ac"><div class="ac-lbl"><svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> Health</div>
    <div class="ac-val" style="font-size:15px">${isOnline?"Good":"Degraded"}</div>
    <div class="ac-sub">${isOnline?"No issues detected":"Offline or cookie expired"}</div>
  </div>
</div>
${!isOnline?`<div class="box" style="padding:20px;margin-top:10px"><div style="text-align:center;color:var(--gray);font-size:13px">Bot is offline. Go to <a href="/?tab=dashboard&itab=cookie" style="color:var(--red2)">Cookie tab</a> to connect.</div></div>`:""}
<div class="shd">${I.bell} Notification Center</div>
<div class="box" style="padding:0">
  <div class="bh"><span class="chip chip-y">ALERTS</span><span class="bt">Recent Notifications</span><span class="bm">${us.alerts.length}</span></div>
  <div class="la">${us.alerts.length===0?`<div class="lr lr-idle"><span class="lt">--:--</span><span class="ll">IDLE</span><span class="lm">No alerts yet</span></div>`:us.alerts.map(a=>`<div class="lr lr-${a.type==="error"?"error":a.type==="warn"?"warn":"info"}"><span class="lt">${esc(a.time)}</span><span class="ll">${a.type.toUpperCase()}</span><span class="lm">${esc(a.message)}</span></div>`).join("")}</div>
</div>`;
}

// ─── ABOUT TAB ────────────────────────────────────────────────────────────────
function buildAboutContent() {
    return `<div class="ab-wrap">
<div class="shd">${I.info} Developer</div>
<div class="ab-hero">
  <div class="ab-name">Kyle Gaspari</div>
  <div class="ab-role">Lead Developer &amp; Platform Architect</div>
  <p class="ab-txt">Kyle Gaspari is the developer and architect behind DUMMYL BOT, a powerful Facebook Messenger automation platform. With a deep focus on real-time systems, Kyle designed every layer from the ground up — including the multi-worker bot engine, the MQTT-based listener, the live dashboard, and the per-user isolation system.</p>
  <br/>
  <p class="ab-txt">If you encounter any errors or have suggestions, Kyle welcomes your feedback directly.</p>
</div>
<div class="ab-contact">
  <div class="ab-ct-title">Contact</div>
  <div class="ct-item"><div class="ct-ico"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div><div><div class="ct-val">Facebook Messenger</div><div class="ct-hint">Reach out directly for bug reports or feature suggestions</div></div></div>
</div>
<div style="margin-top:16px;padding:18px;background:var(--card);border:1px solid var(--border);border-radius:12px;">
  <div style="font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--gray);text-transform:uppercase;margin-bottom:10px;">Platform Info</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12.5px;color:var(--off);">
    <div>Version: <b style="color:var(--white)">v2.3</b></div>
    <div>Engine: <b style="color:var(--white)">ws3-fca (MQTT)</b></div>
    <div>Runtime: <b style="color:var(--white)">Node.js</b></div>
    <div>Storage: <b style="color:var(--white)">Per-User JSON</b></div>
  </div>
</div>
</div>`;
}

// ─── ADMIN TAB ────────────────────────────────────────────────────────────────
function buildAdminContent() {
    const users      = auth.getAllUsers();
    const activeSess = auth.getActiveSessions();
    const activeMap  = {};
    for (const s of activeSess) activeMap[s.userId] = s;

    const rows = users.map(u => {
        const isActive = !!activeMap[u.id];
        const actSince = isActive && activeMap[u.id].createdAt ? new Date(activeMap[u.id].createdAt).toLocaleTimeString() : "—";
        const us       = getUserState(u.id);
        return `<tr>
<td><b style="color:var(--white)">${esc(u.username)}</b><div style="font-size:11px;color:var(--gray)">${esc(u.email)}</div></td>
<td>${isActive?`<span class="tag tag-g">Online</span>`:`<span class="tag tag-d">Offline</span>`}</td>
<td style="font-size:12px;color:var(--gray)">${u.lastSeen ? new Date(u.lastSeen).toLocaleString() : "Never"}</td>
<td style="font-size:12px;color:var(--gray)">${isActive ? actSince : "—"}</td>
<td>${u.isBanned?`<span class="tag tag-r">BANNED</span>`:(u.isAdmin?`<span class="tag tag-b">ADMIN</span>`:`<span class="tag tag-g">OK</span>`)}</td>
<td><div style="display:flex;gap:6px;flex-wrap:wrap;">
  ${!u.isAdmin && !u.isBanned ? `<form method="POST" action="/admin/ban" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-danger btn-xs">Ban</button></form>` : ""}
  ${!u.isAdmin && u.isBanned  ? `<form method="POST" action="/admin/unban" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-o btn-xs">Unban</button></form>` : ""}
  ${!u.isAdmin ? `<form method="POST" action="/admin/delete" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-danger btn-xs" onclick="return confirm('Delete this user?')">Delete</button></form>` : ""}
</div></td>
</tr>`;
    }).join("");

    return `
<div class="adm-banner">
  <div class="adm-ic">${I.admin}</div>
  <div><div class="adm-title">Admin Control Panel</div><div class="adm-sub">${users.length} registered users — ${activeSess.length} currently online</div></div>
</div>
<div class="sg" style="grid-template-columns:repeat(3,1fr)">
  <div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r">${I.user}</div><div class="sc-val">${users.length}</div><div class="sc-lbl">Total Users</div></div>
  <div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w">${I.globe||""}</div><div class="sc-val">${activeSess.length}</div><div class="sc-lbl">Online Now</div></div>
  <div class="sc"><div class="sc-glow gc-g"></div><div class="sc-ico ci-g">${I.shield}</div><div class="sc-val">${users.filter(u=>u.isBanned).length}</div><div class="sc-lbl">Banned</div></div>
</div>
<div class="shd">${I.user} User Management</div>
<div class="box">
  <div class="bh"><span class="chip">USERS</span><span class="bt">Registered Accounts</span><span class="bm">${users.length} total</span></div>
  <table>
    <thead><tr><th>User</th><th>Status</th><th>Last Seen</th><th>Session Start</th><th>Role</th><th>Actions</th></tr></thead>
    <tbody>${rows||`<tr><td colspan="6" class="td-e">No users yet</td></tr>`}</tbody>
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

// ─── COOKIE GATE PAGE ─────────────────────────────────────────────────────────
function buildCookieGatePage(session) {
    const content = `
<div style="min-height:70vh;display:flex;align-items:center;justify-content:center;padding:20px 0;">
<div style="width:100%;max-width:600px;">

<div style="text-align:center;margin-bottom:36px;">
  <div style="width:72px;height:72px;background:linear-gradient(135deg,var(--red),var(--red-dim));border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;box-shadow:0 0 40px rgba(220,38,38,0.5),0 12px 32px rgba(0,0,0,0.5);">
    <svg width="34" height="34" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  </div>
  <h1 style="font-size:28px;font-weight:900;margin-bottom:10px;text-shadow:0 0 30px rgba(220,38,38,0.4);">Connect Your Facebook Account</h1>
  <p style="color:var(--gray);font-size:14px;line-height:1.7;max-width:420px;margin:0 auto;">Before you can access your dashboard, you need to connect your Facebook account using your session cookie (fbstate.json).</p>
</div>

<div class="steps-g" style="margin-bottom:28px;">
  <div class="step"><div class="snum">1</div><div class="stxt">Install <b>c3c-ufc-utility</b> extension on Chrome or any cookie exporter</div></div>
  <div class="step"><div class="snum">2</div><div class="stxt">Log in to <b>facebook.com</b> normally in your browser</div></div>
  <div class="step"><div class="snum">3</div><div class="stxt">Click the extension → choose <b>Export as JSON</b> (fbstate format)</div></div>
  <div class="step"><div class="snum">4</div><div class="stxt">Paste the JSON output below and click <b>Connect Bot</b></div></div>
</div>

<div class="box" style="padding:0;overflow:visible;">
  <div class="bh" style="border-radius:14px 14px 0 0;">
    <span class="chip">SETUP</span>
    <span class="bt">Paste Your Cookie</span>
    <span class="bm">Required to start bot</span>
  </div>
  <div style="padding:22px;">
    <form method="POST" action="/api/cookie/slot">
      <div class="fld">
        <label class="flbl">Cookie Slot</label>
        <select class="fs" name="slot" style="margin-bottom:0">
          <option value="fbstate.json">fbstate.json (Primary)</option>
          <option value="fbstate2.json">fbstate2.json (Slot 2)</option>
          <option value="fbstate3.json">fbstate3.json (Slot 3)</option>
        </select>
      </div>
      <div class="fld">
        <label class="flbl">fbstate.json Content</label>
        <textarea class="ck-ta" name="cookie" placeholder='[{"key":"c_user","value":"100xxxxxxxxx","domain":".facebook.com",...},...]' rows="6" required style="margin-bottom:0"></textarea>
        <div class="fhint" style="margin-top:6px">Paste the full JSON array exported from the c3c-ufc-utility Chrome extension</div>
      </div>
      <button class="conn-btn" type="submit">
        <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        Connect Bot &amp; Enter Dashboard
      </button>
    </form>
    <div style="margin-top:14px;text-align:center;font-size:11.5px;color:var(--gray2);">
      Your cookie is stored privately in your isolated user directory and is never shared.
    </div>
  </div>
</div>

</div>
</div>`;
    return buildLayout(session, "dashboard", content);
}

// ─── PAGE BUILDER ─────────────────────────────────────────────────────────────
function buildPage(session, mainTab, innerTab) {
    let content = "";
    const uid = session.userId;
    if (mainTab === "dashboard") content = buildDashboardContent(uid, innerTab);
    else if (mainTab === "account") content = buildAccountContent(uid);
    else if (mainTab === "about")   content = buildAboutContent();
    else if (mainTab === "admin" && session.isAdmin) content = buildAdminContent();
    else content = buildDashboardContent(uid, innerTab);
    return buildLayout(session, mainTab || "dashboard", content);
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function startDashboard(port) {
    const server = http.createServer(async (req, res) => {
        const url_  = new URL(req.url, `http://localhost`);
        const path_ = url_.pathname;
        const sess  = getSessionFromReq(req);

        function redirect(to, code=302){ res.writeHead(code,{Location:to});res.end(); }
        function html(body, code=200)  { res.writeHead(code,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(body); }
        function json(obj, code=200)   { res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(obj)); }

        // Auth pages (public)
        if (path_==="/login") { if(sess)return redirect("/?tab=dashboard"); return html(buildLoginPage()); }
        if (path_==="/register") { if(sess)return redirect("/?tab=dashboard"); return html(buildRegisterPage()); }
        if (path_==="/" && !sess) return html(buildLoginPage());

        // Auth API
        if (path_==="/api/auth/login" && req.method==="POST") {
            const body   = await parseBody(req);
            const result = auth.login(body.email||"", body.password||"");
            if (result.error) return html(buildLoginPage(result.error));
            const token = auth.createSession(result.user);
            res.writeHead(302,{"Set-Cookie":`dbl_sess=${token}; Path=/; HttpOnly; SameSite=Lax`,"Location":"/?tab=dashboard"});res.end();return;
        }
        if (path_==="/api/auth/register" && req.method==="POST") {
            const body   = await parseBody(req);
            if (body.password!==body.confirm) return html(buildRegisterPage("Passwords do not match"));
            const result = auth.register(body.username||"", body.email||"", body.password||"");
            if (result.error) return html(buildRegisterPage(result.error));
            const token = auth.createSession(result.user);
            res.writeHead(302,{"Set-Cookie":`dbl_sess=${token}; Path=/; HttpOnly; SameSite=Lax`,"Location":"/?tab=dashboard"});res.end();return;
        }
        if (path_==="/api/auth/logout" && req.method==="POST") {
            const tok = getTokenFromReq(req);
            if (tok) auth.destroySession(tok);
            res.writeHead(302,{"Set-Cookie":`dbl_sess=; Path=/; HttpOnly; Max-Age=0`,"Location":"/login"});res.end();return;
        }

        // Everything else requires auth
        if (!sess) return redirect("/login");
        auth.updateLastSeen(sess.userId);
        const uid = sess.userId;

        if (path_==="/" && req.method==="GET") {
            const mainTab  = url_.searchParams.get("tab") || "dashboard";
            const innerTab = url_.searchParams.get("itab") || "overview";
            if (mainTab==="admin" && !sess.isAdmin) return redirect("/?tab=dashboard");
            // Cookie gate: block all tabs (except admin) until user has a valid fbstate
            if (!sess.isAdmin && !hasCookieForUser(uid)) {
                return html(buildCookieGatePage(sess));
            }
            // Also gate admin users if they haven't set up their own cookie yet
            if (sess.isAdmin && !hasCookieForUser(uid) && mainTab !== "admin" && mainTab !== "about") {
                return html(buildCookieGatePage(sess));
            }
            return html(buildPage(sess, mainTab, innerTab));
        }

        // Admin actions
        if (path_==="/admin/ban" && req.method==="POST" && sess.isAdmin) {
            const body = await parseBody(req); auth.banUser(body.userId, body.reason||""); return redirect("/?tab=admin");
        }
        if (path_==="/admin/unban" && req.method==="POST" && sess.isAdmin) {
            const body = await parseBody(req); auth.unbanUser(body.userId); return redirect("/?tab=admin");
        }
        if (path_==="/admin/delete" && req.method==="POST" && sess.isAdmin) {
            const body = await parseBody(req); auth.deleteUser(body.userId); return redirect("/?tab=admin");
        }

        // JSON APIs
        if (path_==="/api/status")       { const us=getUserState(uid); return json({loggedIn:us.loggedIn,botName:us.botName,uptime:getUptime(uid),totalRepliesSent:us.totalRepliesSent}); }
        if (path_==="/api/hourly-stats") return json(getHourlyStats(uid));
        if (path_==="/api/alerts")       return json(getUserState(uid).alerts);

        // Replies
        if (path_==="/api/replies/add" && req.method==="POST") {
            const body=await parseBody(req); if(body.word){const a=readCustomReplies(uid);a.push(body.word.trim());writeCustomReplies(uid,a);}
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"loop"}`);
        }
        if (path_==="/api/replies/remove" && req.method==="POST") {
            const body=await parseBody(req); const a=readCustomReplies(uid);a.splice(parseInt(body.index),1);writeCustomReplies(uid,a);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"loop"}`);
        }
        if (path_==="/api/images/add" && req.method==="POST") {
            const body=await parseBody(req); if(body.url){const a=readImageReplies(uid);a.push(body.url.trim());writeImageReplies(uid,a);}
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"loop"}`);
        }
        if (path_==="/api/images/remove" && req.method==="POST") {
            const body=await parseBody(req); const a=readImageReplies(uid);a.splice(parseInt(body.index),1);writeImageReplies(uid,a);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"loop"}`);
        }

        // Config
        if (path_==="/api/config/save" && req.method==="POST") {
            const body=await parseBody(req); const cfg=readBotConfig(uid);
            const num=(k,def)=>{const v=parseFloat(body[k]);return isNaN(v)?def:v;};
            const bool=k=>body[k]==="1"||body[k]==="true"||body[k]==="on";
            cfg.loopReact=body.loopReact||cfg.loopReact; cfg.loopDelay=num("loopDelay",1); cfg.imageProbability=num("imageProbability",20);
            cfg.loopMode=body.loopMode||"sequential"; cfg.maxLoopCount=num("maxLoopCount",0); cfg.autoStopMinutes=num("autoStopMinutes",0);
            cfg.loopStartMsg=body.loopStartMsg??cfg.loopStartMsg; cfg.loopStopMsg=body.loopStopMsg??cfg.loopStopMsg;
            cfg.ttsLang=body.ttsLang||cfg.ttsLang; cfg.reactOnlyMode=bool("reactOnlyMode"); cfg.greetNewMembers=bool("greetNewMembers");
            cfg.greetMsg=body.greetMsg??cfg.greetMsg; cfg.antiSpamEnabled=bool("antiSpamEnabled");
            cfg.antiSpamMaxMsg=num("antiSpamMaxMsg",5); cfg.antiSpamWindowSec=num("antiSpamWindowSec",10);
            cfg.autoSeenEnabled=bool("autoSeenEnabled"); cfg.typingSimulate=bool("typingSimulate");
            cfg.silentMode=bool("silentMode"); cfg.loopSilentMode=bool("loopSilentMode");
            cfg.autoReactEnabled=bool("autoReactEnabled"); cfg.autoReactEmoji=body.autoReactEmoji||cfg.autoReactEmoji;
            writeBotConfig(uid,cfg);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"config"}`);
        }

        // Cookie
        if (path_==="/api/cookie/slot" && req.method==="POST") {
            const body=await parseBody(req); const raw=body.cookie||"";
            if(!raw.trim()) return redirect("/?tab=dashboard&itab=cookie");
            let parsed; try{parsed=JSON.parse(raw);}catch(_){return redirect("/?tab=dashboard&itab=cookie");}
            if(!Array.isArray(parsed)||!parsed.length) return redirect("/?tab=dashboard&itab=cookie");
            const slot=body.slot||"fbstate.json";
            const dest=path.join(uDir(uid), path.basename(slot).replace(/[^a-zA-Z0-9._-]/g,""));
            auth.ensureUserDataDir(uid);
            fs.writeFileSync(dest, JSON.stringify(parsed,null,2), "utf8");
            const us=getUserState(uid);
            us.logs.splice(0,us.logs.length); us.totalRepliesSent=0; us.startedAt=new Date();
            us.loopEnabled={}; us.autoRespondEnabled={}; us.mutedThreads={};
            us.bots=[]; us.botName=""; us.loginInProgress=true;
            if(_cookieUpdateCb) _cookieUpdateCb(uid);
            return redirect("/?tab=dashboard&itab=cookie");
        }

        // Custom commands
        if (path_==="/api/cmds/add" && req.method==="POST") {
            const body=await parseBody(req);
            if(body.cmd&&body.reply){const a=readCustomCommands(uid);const cmd=body.cmd.startsWith("!")?body.cmd:"!"+body.cmd;a.push({cmd,reply:body.reply});writeCustomCommands(uid,a);}
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"cmds"}`);
        }
        if (path_==="/api/cmds/remove" && req.method==="POST") {
            const body=await parseBody(req); const a=readCustomCommands(uid);a.splice(parseInt(body.index),1);writeCustomCommands(uid,a);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"cmds"}`);
        }

        // Whitelist
        if (path_==="/api/whitelist/toggle" && req.method==="POST") {
            const w=readWhitelist(uid);w.enabled=!w.enabled;writeWhitelist(uid,w);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"threads"}`);
        }
        if (path_==="/api/whitelist/add" && req.method==="POST") {
            const body=await parseBody(req); if(body.uid){const w=readWhitelist(uid);if(!w.uids.includes(body.uid)){w.uids.push(body.uid);writeWhitelist(uid,w);}}
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"threads"}`);
        }
        if (path_==="/api/whitelist/remove" && req.method==="POST") {
            const body=await parseBody(req); if(body.uid){const w=readWhitelist(uid);w.uids=w.uids.filter(u=>u!==body.uid);writeWhitelist(uid,w);}
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"threads"}`);
        }

        // Thread controls
        if (path_==="/api/thread/config" && req.method==="POST") {
            const body=await parseBody(req);
            if(body.threadID){const c=readThreadConfig(uid);c[body.threadID]={loopDelay:parseFloat(body.loopDelay)||null,loopReact:body.loopReact||null};writeThreadConfig(uid,c);}
            return redirect("/?tab=dashboard&itab=threads");
        }
        if (path_==="/api/thread/startloop" && req.method==="POST") {
            const body=await parseBody(req); if(body.threadID&&_loopControlCb) _loopControlCb(uid,"start",body.threadID);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"threads"}`);
        }
        if (path_==="/api/thread/stoploop" && req.method==="POST") {
            const body=await parseBody(req); if(body.threadID&&_loopControlCb) _loopControlCb(uid,"stop",body.threadID);
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"threads"}`);
        }
        if (path_==="/api/thread/stopall" && req.method==="POST") {
            if(_stopAllCb) _stopAllCb(uid);
            const us=getUserState(uid);
            Object.keys(us.loopEnabled||{}).filter(t=>us.loopEnabled[t]).forEach(t=>{if(_loopControlCb)_loopControlCb(uid,"stop",t);});
            return redirect(`/?tab=${url_.searchParams.get("tab")||"dashboard"}&itab=${url_.searchParams.get("itab")||"threads"}`);
        }

        res.writeHead(404,{"Content-Type":"text/plain"});res.end("Not found");
    });

    server.listen(parseInt(port)||5000, "0.0.0.0", ()=>{
        console.log(`[cozy-bot] Dashboard running on port ${port}`);
    });
}

module.exports = {
    startDashboard, getUserState, addLog, sysLog, addAlert, state,
    setCookieUpdateHandler, setLoopControlHandler, setStopAllHandler,
    trackMessage, setAccountInfoForUser,
};
