"use strict";

const { login } = require("ws3-fca");
const fs   = require("fs");
const path = require("path");
const axios = require("axios");
const { replies, imageReplies: builtinImageReplies } = require("./replies");

const FBSTATE_PATH   = process.argv[2];
const BOT_LABEL      = process.argv[3] || "Bot";
const DEVELOPER_ID   = process.argv[4] || "";
const ADMIN_IDS      = new Set(process.argv.slice(4, -1).filter(a => /^\d+$/.test(a)));
const USER_DATA_DIR  = process.argv[process.argv.length - 1];

const PREFIX             = "!";
const MIN_RECONNECT      = 5000;
const MAX_RECONNECT      = 60000;
const DEFAULT_BANNER_URL = "https://file.garden/aahuG_hIDGRlXD24/image.jpg";

function dataFile(name) { return path.join(USER_DATA_DIR, name); }

const STATE_FILE           = dataFile("bot_state.json");
const CUSTOM_REPLIES_FILE  = dataFile("custom_replies.json");
const IMAGE_REPLIES_FILE   = dataFile("image_replies.json");
const BOT_CONFIG_FILE      = dataFile("bot_config.json");
const FBSTATE_FILE         = FBSTATE_PATH;
const CUSTOM_COMMANDS_FILE = dataFile("custom_commands.json");
const WHITELIST_FILE       = dataFile("whitelist.json");
const THREAD_CONFIG_FILE   = dataFile("thread_config.json");

const COLOR_MAP = {
    blue:"196241301102133",pink:"169463077092846",hotpink:"169463077092846",
    aqua:"2442142322678320",purple:"234137870477637",coral:"980963458735625",
    orange:"175615189761153",green:"2136751179887052",lavender:"2058653964378557",
    red:"2129984390566328",yellow:"174636906462322",teal:"1928399724138152",
    berry:"164535220883264",ocean:"736591620215564",love:"741311439775765",
    rose:"1257453361255152",monochrome:"788274591712841",candy:"205488546921017",
    unicorn:"273728810607574",tropical:"262191918210707",default:"3259963564026002",
};

function send(type, payload = {}) { try { process.send({ type, ...payload }); } catch (_) {} }
function log(level, msg)          { send("log", { level, message: `[${BOT_LABEL}] ${msg}` }); }

function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        return {
            loopEnabled:        s.loopEnabled        || {},
            autoRespondEnabled: s.autoRespondEnabled  || {},
            mutedThreads:       s.mutedThreads        || {},
            nicknameMap:        s.nicknameMap         || {},
            antiRestrict:       s.antiRestrict        || false,
            antiChat:           s.antiChat            || {},
            lockedBanners:      s.lockedBanners       || {},
            lockedGroupNames:   s.lockedGroupNames    || {},
        };
    } catch (_) {
        return { loopEnabled:{}, autoRespondEnabled:{}, mutedThreads:{}, nicknameMap:{}, antiRestrict:false, antiChat:{}, lockedBanners:{}, lockedGroupNames:{} };
    }
}
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            loopEnabled:        sharedState.loopEnabled,
            autoRespondEnabled: sharedState.autoRespondEnabled,
            mutedThreads:       sharedState.mutedThreads,
            nicknameMap:        sharedState.nicknameMap,
            antiRestrict:       sharedState.antiRestrict,
            antiChat:           sharedState.antiChat,
            lockedBanners:      sharedState.lockedBanners,
            lockedGroupNames:   sharedState.lockedGroupNames,
        }, null, 2));
    } catch (_) {}
}
const sharedState = loadState();

let reconnectDelay   = MIN_RECONNECT;
let lockedProfilePic = null;
let profilePicTimer  = null;
const tempPerms      = {};
const loopActive     = {};
const loopTimers     = {};
const loopIndex      = {};
const loopCounts     = {};
const loopAutoStop   = {};
const pmThreads      = {};
const spamTracker    = {};
const settingBanner      = {};
const settingGroupName   = {};

function stopAllLoops(api) {
    const active = Object.keys(loopActive).filter(t => loopActive[t]);
    if (!active.length) return;
    log("warn", `Stopping ${active.length} active loop(s) due to disconnect.`);
    active.forEach(tid => stopLoop(tid, api));
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
}

function getBotConfig() {
    try { return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, "utf8")); }
    catch (_) { return { loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false,silentMode:false,loopSilentMode:false,autoReactEnabled:false,autoReactEmoji:"😆" }; }
}
function getCustomReplies()  { try { return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8")); } catch(_){return[];} }
function getImageReplies()   { let c=[]; try{c=JSON.parse(fs.readFileSync(IMAGE_REPLIES_FILE,"utf8"));}catch(_){} return [...builtinImageReplies,...c].filter(u=>u&&u.startsWith("http")); }
function getAllReplies()      { return [...replies, ...getCustomReplies()].filter(r=>r&&r.trim()); }
function getRandomReply()    { const a=getAllReplies(); return a.length?a[Math.floor(Math.random()*a.length)]:"..."; }
function getRandomImageUrl() { const i=getImageReplies(); return i.length?i[Math.floor(Math.random()*i.length)]:null; }
function getCustomCommands() { try{return JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE,"utf8"));}catch(_){return[];} }
function getWhitelist()      { try{return JSON.parse(fs.readFileSync(WHITELIST_FILE,"utf8"));}catch(_){return{enabled:false,uids:[]};} }
function getThreadConfig(tid){ try{const all=JSON.parse(fs.readFileSync(THREAD_CONFIG_FILE,"utf8"));return all[tid]||{};}catch(_){return {};} }

function startProfileGuard(api) {
    if (profilePicTimer) clearInterval(profilePicTimer);
    profilePicTimer = setInterval(()=>{
        if (!lockedProfilePic||!api) return;
        api.changeAvatar(lockedProfilePic,"",err=>{ if(!err) log("info","Profile restored."); });
    }, 5*60*1000);
}
function stopProfileGuard() { if(profilePicTimer){clearInterval(profilePicTimer);profilePicTimer=null;} lockedProfilePic=null; }
function hasTempPerm(uid)   { if(!tempPerms[uid])return false; if(Date.now()>tempPerms[uid]){delete tempPerms[uid];return false;} return true; }
function parseTime(str) {
    const m=str.match(/^(\d+)(s|sec|min|m|h|hr)$/i);
    if(!m)return null;
    const v=parseInt(m[1]),u=m[2].toLowerCase();
    if(u==="s"||u==="sec")return v*1000;
    if(u==="m"||u==="min")return v*60000;
    if(u==="h"||u==="hr")return v*3600000;
    return null;
}
function formatTimeLeft(ms) { const s=Math.ceil(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60); if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`; }
function setGroupBanner(api,imageUrl,threadID,cb) {
    axios.get(imageUrl,{responseType:"arraybuffer"}).then(r=>{
        const buf=Buffer.from(r.data);
        const {Readable}=require("stream");
        const stream=new Readable();stream.push(buf);stream.push(null);
        api.changeGroupImage(stream,threadID,err=>{if(cb)cb(err);});
    }).catch(err=>{if(cb)cb(err);});
}
function checkAntiSpam(senderID,threadID,cfg) {
    if(!cfg.antiSpamEnabled)return false;
    const key=`${senderID}_${threadID}`,now=Date.now(),win=(cfg.antiSpamWindowSec||10)*1000;
    if(!spamTracker[key])spamTracker[key]=[];
    spamTracker[key]=spamTracker[key].filter(t=>now-t<win);
    spamTracker[key].push(now);
    return spamTracker[key].length>(cfg.antiSpamMaxMsg||5);
}
function isUID(str) { return /^\d{10,20}$/.test((str||"").trim()); }

function startLoop(api, threadID, isPM = false) {
    if (loopActive[threadID]) { log("warn",`Loop already active in ${threadID}`); return; }
    if (isPM) pmThreads[threadID] = true;
    loopActive[threadID] = true;
    loopCounts[threadID] = 0;
    if (!loopIndex[threadID]) loopIndex[threadID] = 0;
    sharedState.loopEnabled[threadID] = true;
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
    log("info", `Loop STARTED in thread ${threadID} (pm=${isPM})`);

    const cfg0 = getBotConfig();
    const isGroupThread = !pmThreads[threadID];
    const _send = (msg, cb) => api.sendMessage(msg, threadID, cb, null, isGroupThread);

    if (cfg0.loopStartMsg) _send(cfg0.loopStartMsg, ()=>{});
    if (cfg0.autoStopMinutes > 0) {
        if (loopAutoStop[threadID]) clearTimeout(loopAutoStop[threadID]);
        loopAutoStop[threadID] = setTimeout(()=>{ log("info",`Loop auto-stopped in ${threadID}`); stopLoop(threadID,api); }, cfg0.autoStopMinutes*60000);
    }

    function sendNext() {
        if (!loopActive[threadID]) return;
        const cfg = getBotConfig();
        const tcfg = getThreadConfig(threadID);
        const all = getAllReplies();
        const effectiveDelay = tcfg.loopDelay != null ? tcfg.loopDelay : (cfg.loopDelay||1);
        const effectiveReact = tcfg.loopReact || cfg.loopReact || "😆";
        if (!all.length) { loopTimers[threadID]=setTimeout(sendNext,effectiveDelay*1000); return; }
        if (cfg.maxLoopCount>0 && loopCounts[threadID]>=cfg.maxLoopCount) { stopLoop(threadID,api); return; }
        let idx;
        if ((cfg.loopMode||"sequential")==="shuffle") { idx = Math.floor(Math.random()*all.length); }
        else { idx = loopIndex[threadID] % all.length; loopIndex[threadID] = idx + 1; }
        loopCounts[threadID]++;
        const useImage = !cfg.reactOnlyMode && Math.random() < ((cfg.imageProbability||20)/100);
        const imageUrl = getRandomImageUrl();
        const isGrp = !pmThreads[threadID];
        const __send = (msg, cb) => api.sendMessage(msg, threadID, cb, null, isGrp);
        function onSent(err, msgInfo) {
            if (err) { log("warn",`Loop send error in ${threadID}: ${err.message||err}`); }
            else if (msgInfo?.messageID) api.setMessageReaction(effectiveReact,msgInfo.messageID,()=>{},true);
            send("totalReply");
            if (loopActive[threadID]) loopTimers[threadID]=setTimeout(sendNext,effectiveDelay*1000);
        }
        const loopSilent = !!cfg.loopSilentMode;
        const loopMsg = loopSilent ? {body: all[idx], silent: true} : all[idx];
        if (useImage && imageUrl) {
            axios.get(imageUrl,{responseType:"stream",timeout:15000})
                .then(r=>__send(loopSilent ? {attachment:r.data, silent:true} : {attachment:r.data},onSent))
                .catch(()=>__send(loopMsg,onSent));
        } else {
            __send(loopMsg, onSent);
        }
    }
    sendNext();
}

function stopLoop(threadID, api) {
    loopActive[threadID] = false;
    if (loopTimers[threadID])  { clearTimeout(loopTimers[threadID]);  delete loopTimers[threadID]; }
    if (loopAutoStop[threadID]){ clearTimeout(loopAutoStop[threadID]); delete loopAutoStop[threadID]; }
    loopIndex[threadID]  = 0;
    loopCounts[threadID] = 0;
    sharedState.loopEnabled[threadID] = false;
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
    log("info", `Loop STOPPED in thread ${threadID}`);
    const cfg = getBotConfig();
    const isGrpStop = !pmThreads[threadID];
    if (api && cfg.loopStopMsg) api.sendMessage(cfg.loopStopMsg, threadID, ()=>{}, null, isGrpStop);
    delete pmThreads[threadID];
}

function sendAutoReply(api, threadID) {
    const cfg = getBotConfig();
    const imageUrl = getRandomImageUrl();
    const useImage = imageUrl && Math.random()<((cfg.imageProbability||20)/100);
    const silent = !!cfg.silentMode;
    const replyMsg = silent ? {body: getRandomReply(), silent: true} : getRandomReply();
    function onDone(err,msgInfo) {
        if (!err && msgInfo?.messageID) api.setMessageReaction("😂",msgInfo.messageID,()=>{},true);
    }
    if (useImage) {
        axios.get(imageUrl,{responseType:"stream",timeout:15000})
            .then(r=>api.sendMessage(silent ? {attachment:r.data, silent:true} : {attachment:r.data},threadID,onDone))
            .catch(()=>api.sendMessage(replyMsg,threadID,onDone));
    } else {
        api.sendMessage(replyMsg, threadID, onDone);
    }
}

function scheduleReconnect() {
    log("warn",`Reconnecting in ${reconnectDelay/1000}s...`);
    send("status",{loggedIn:false,reconnecting:true,nextReconnectIn:reconnectDelay/1000});
    setTimeout(()=>{ send("status",{reconnecting:false}); startBot(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay*2, MAX_RECONNECT);
}

// ─── !p COMMAND — YouTube audio download ─────────────────────────────────────
async function playCommand(api, query, threadID) {
    if (!query) { api.sendMessage("Usage: !p <song name> or !p <youtube url>", threadID, ()=>{}); return; }
    api.sendMessage(`🔍 Searching: "${query.slice(0,60)}"...`, threadID, ()=>{});

    const ytdl    = require("@distube/ytdl-core");
    const ytSearch= require("youtube-search-api");
    const tmp     = `/tmp/song_${Date.now()}.mp4`;

    const YT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    };

    async function downloadAndSend(videoUrl) {
        try {
            const info  = await ytdl.getInfo(videoUrl, { requestOptions: { headers: YT_HEADERS } });
            const title = info.videoDetails.title || "Unknown";
            const dur   = parseInt(info.videoDetails.lengthSeconds) || 0;
            if (dur > 600) {
                api.sendMessage(`❌ Song too long (max 10 min). Found: "${title}"`, threadID, ()=>{});
                return;
            }

            // Pick the best audio-only format
            const formats = ytdl.filterFormats(info.formats, "audioonly");
            if (!formats.length) {
                api.sendMessage("❌ No audio stream available for that video.", threadID, ()=>{});
                return;
            }
            const fmt = formats.sort((a,b) => (a.audioBitrate||0) - (b.audioBitrate||0))[0];

            const stream = ytdl.downloadFromInfo(info, { format: fmt, requestOptions: { headers: YT_HEADERS } });
            const ws     = fs.createWriteStream(tmp);

            await new Promise((resolve, reject) => {
                stream.pipe(ws);
                ws.on("finish", resolve);
                ws.on("error", reject);
                stream.on("error", reject);
            });

            await new Promise((resolve, reject) => {
                api.sendMessage(
                    { body: `🎵 Now playing: ${title}`, attachment: fs.createReadStream(tmp) },
                    threadID,
                    err => {
                        try { fs.unlinkSync(tmp); } catch(_) {}
                        if (err) { log("warn", `!p send error: ${err}`); reject(err); }
                        else { send("totalReply"); resolve(); }
                    }
                );
            });
        } catch(err) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch(_) {}
            log("warn", `!p error: ${err.message}`);
            api.sendMessage(`❌ Could not play that. Try a direct YouTube URL instead.`, threadID, ()=>{});
        }
    }

    const isYtUrl = /youtu(?:be\.com|\.be)/i.test(query);
    if (isYtUrl) {
        downloadAndSend(query);
        return;
    }

    // Search YouTube
    try {
        const results = await ytSearch.GetListByKeyword(query, false, 10);
        const items   = (results && results.items) || [];
        const video   = items.find(i => i.type === "video" || (i.id && i.title));
        if (!video || !video.id) {
            api.sendMessage(`❌ No results found for: "${query}"`, threadID, ()=>{});
            return;
        }
        downloadAndSend(`https://www.youtube.com/watch?v=${video.id}`);
    } catch(err) {
        log("warn", `!p search error: ${err.message}`);
        api.sendMessage("❌ Search failed. Try sending a YouTube URL directly.", threadID, ()=>{});
    }
}

function startBot() {
    let appState;
    try { appState = JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8")); }
    catch(e) { log("error","Cannot read fbstate: "+e.message); send("status",{loggedIn:false,reconnecting:false}); return; }

    login(appState,{
        online:true, selfListen:true, listenEvents:true, autoMarkDelivery:false, logLevel:"silent",
    }, (err, api) => {
        if (err) {
            const msg = err.message||JSON.stringify(err);
            log("error","Login failed: "+msg);
            const isExpired = msg.includes("Error retrieving userID")||msg.includes("Checkpoint");
            if (isExpired && reconnectDelay>=MAX_RECONNECT) {
                log("error","Session expired. Update cookie from dashboard.");
                send("status",{loggedIn:false,reconnecting:false,expired:true});
                return;
            }
            scheduleReconnect();
            return;
        }

        api.setOptions({ userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36" });
        reconnectDelay = MIN_RECONNECT;
        const BOT_SELF_ID = api.getCurrentUserID();
        api.getUserInfo([BOT_SELF_ID], (err2, ret) => {
            const name = (!err2 && ret && ret[BOT_SELF_ID])
                ? (ret[BOT_SELF_ID].name || ret[BOT_SELF_ID].fullName || BOT_SELF_ID)
                : BOT_SELF_ID;
            send("status",{loggedIn:true,reconnecting:false,expired:false,nextReconnectIn:0,botName:name});
            send("accountInfo",{data:{name,uid:BOT_SELF_ID}});
            log("info",`Logged in! Bot ready. botID=${BOT_SELF_ID} name=${name}`);
        });

        const keepalive = setInterval(()=>{ try{api.getThreadList(1,null,[],()=>{});}catch(_){} }, 55000);
        if (lockedProfilePic) startProfileGuard(api);

        const frozenThreads = {};
        const gmutedUsers   = {};

        api.listenMqtt((err, event) => {
            if (err) {
                clearInterval(keepalive);
                stopAllLoops(null);
                log("error",`Listener error: ${err.error||err.message||err}.`);
                send("status",{loggedIn:false});
                scheduleReconnect();
                return;
            }
            try { handleEvent(api, event, frozenThreads, gmutedUsers); }
            catch(e) { log("error","Event crash: "+(e.message||e)); }
        });

        process.removeAllListeners("message");
        process.on("message", msg => {
            if (msg.type === "sharedState")  Object.assign(sharedState, msg.data);
            if (msg.type === "stopLoop"    && msg.threadID) stopLoop(msg.threadID, api);
            if (msg.type === "stopAllLoops")                stopAllLoops(api);
            if (msg.type === "startLoop"   && msg.threadID) startLoop(api, msg.threadID);
        });

        function isAuthorized(sid) { return ADMIN_IDS.has(sid)||sid===BOT_SELF_ID||hasTempPerm(sid); }

        function handleEvent(api, event, frozenThreads, gmutedUsers) {
            if (event.type==="presence"||event.type==="typ") return;

            if (event.type==="event"&&event.logMessageType==="log:user-nickname") {
                const tid=event.threadID, uid=event.logMessageData?.participant_id;
                const saved=sharedState.nicknameMap[tid]?.[uid];
                if (saved!==undefined) {
                    const current=event.logMessageData?.nickname||"";
                    if (current!==saved) api.changeNickname(saved,tid,uid,()=>{});
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:thread-image") {
                const tid=event.threadID;
                if (sharedState.lockedBanners[tid]&&!settingBanner[tid]) {
                    settingBanner[tid]=true;
                    setTimeout(()=>setGroupBanner(api,sharedState.lockedBanners[tid],tid,err=>{
                        setTimeout(()=>{settingBanner[tid]=false;},3000);
                        if(err) log("warn",`Banner restore error: ${err}`);
                        else log("info",`Banner restored in ${tid}`);
                    }),80);
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:thread-name") {
                const tid=event.threadID;
                if (sharedState.lockedGroupNames[tid]&&!settingGroupName[tid]) {
                    settingGroupName[tid]=true;
                    setTimeout(()=>api.setTitle(sharedState.lockedGroupNames[tid],tid,()=>{settingGroupName[tid]=false;}),80);
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:unsubscribe") {
                const removedUID=event.logMessageData?.leftParticipantFbId;
                if (removedUID===BOT_SELF_ID) {
                    log("warn",`Bot was removed from ${event.threadID}`);
                    if (sharedState.antiRestrict) api.sendMessage(`[anti-restrict] Removed from group ${event.threadID}.`,DEVELOPER_ID,()=>{});
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:subscribe") {
                const cfg=getBotConfig();
                if (cfg.greetNewMembers&&cfg.greetMsg) {
                    (event.logMessageData?.addedParticipants||[]).forEach(()=>api.sendMessage(cfg.greetMsg,event.threadID,()=>{}));
                }
                return;
            }

            if (event.type !== "message" && event.type !== "message_reply") return;

            const threadID  = event.threadID;
            const senderID  = event.senderID;
            const messageID = event.messageID;
            const body      = event.body || "";
            const isGroup   = !!event.isGroup;
            const isPM      = !isGroup;
            const message   = body.trim();

            if (senderID === BOT_SELF_ID && message !== "." && !message.startsWith(".") && !message.startsWith(PREFIX)) return;

            log("info",`MSG type=${event.type} from=${senderID} group=${isGroup} body="${message.slice(0,40)}"`);

            const cfg0 = getBotConfig();
            if (cfg0.autoSeenEnabled) { try{api.markAsRead(threadID,true,()=>{});}catch(_){} }

            if (isGroup && frozenThreads[threadID] && !isAuthorized(senderID)) {
                if (!message.startsWith(PREFIX)) { api.removeUserFromGroup(senderID,threadID,()=>{}); return; }
            }
            if (isGroup && gmutedUsers[threadID]?.[senderID] && !isAuthorized(senderID)) {
                api.removeUserFromGroup(senderID,threadID,()=>{}); return;
            }
            if (isGroup && !isAuthorized(senderID)) {
                if (checkAntiSpam(senderID,threadID,cfg0)) {
                    log("warn",`Anti-spam kick: ${senderID}`);
                    api.removeUserFromGroup(senderID,threadID,()=>{}); return;
                }
            }
            if (cfg0.autoReactEnabled && senderID !== BOT_SELF_ID && messageID) {
                api.setMessageReaction(cfg0.autoReactEmoji||"😆",messageID,()=>{},true);
            }

            if (message === "." || /^\.\s+\S/.test(message)) {
                const dotArg = message.slice(1).trim();
                if (!dotArg) {
                    const canDot = isPM || isAuthorized(senderID);
                    if (!canDot) return;
                    if (loopActive[threadID]) stopLoop(threadID, api);
                    else startLoop(api, threadID, isPM);
                    return;
                }
                if (!isAuthorized(senderID)) return;
                if (isUID(dotArg)) {
                    const targetID = dotArg;
                    if (loopActive[targetID]) { stopLoop(targetID, api); log("info",`DOT-PM loop OFF → ${targetID}`); }
                    else { startLoop(api, targetID, true); log("info",`DOT-PM loop ON → ${targetID}`); }
                } else {
                    api.getFriendsList((err, friends) => {
                        if (err||!friends||typeof friends!=="object") return;
                        const query = dotArg.toLowerCase();
                        const entries = Object.entries(friends);
                        const match = entries.find(([,f]) => (f.name||f.fullName||"").toLowerCase().includes(query));
                        if (!match) { log("warn",`No friend found matching "${dotArg}".`); return; }
                        const [targetUID, friendInfo] = match;
                        const friendName = friendInfo.name || friendInfo.fullName || targetUID;
                        if (loopActive[targetUID]) { stopLoop(targetUID, api); log("info",`DOT-PM loop OFF → ${targetUID} (${friendName})`); }
                        else { startLoop(api, targetUID, true); log("info",`DOT-PM loop ON → ${targetUID} (${friendName})`); }
                    });
                }
                return;
            }

            if (!message.startsWith(PREFIX)) {
                if (isGroup && sharedState.autoRespondEnabled[threadID] && !sharedState.mutedThreads[threadID]) {
                    sendAutoReply(api, threadID);
                }
                return;
            }

            const args = message.slice(PREFIX.length).trim().split(/\s+/);
            const cmd  = args[0].toLowerCase();

            if (cmd==="on") { if (!isPM) { sharedState.autoRespondEnabled[threadID]=true; send("stateUpdate",{autoRespondEnabled:sharedState.autoRespondEnabled}); saveState(); } return; }
            if (cmd==="off"){ if (!isPM) { sharedState.autoRespondEnabled[threadID]=false; send("stateUpdate",{autoRespondEnabled:sharedState.autoRespondEnabled}); saveState(); } return; }

            const wl = getWhitelist();
            if (wl.enabled && !isAuthorized(senderID) && !wl.uids.includes(senderID)) return;
            if (!isAuthorized(senderID)) { log("warn",`Command !${cmd} blocked — unauthorized. sender=${senderID}`); return; }

            if (cmd==="stop") { if (loopActive[threadID]) stopLoop(threadID, api); return; }
            if (cmd==="mute") { sharedState.mutedThreads[threadID]=true; send("stateUpdate",{mutedThreads:sharedState.mutedThreads}); saveState(); return; }
            if (cmd==="unmute") { delete sharedState.mutedThreads[threadID]; send("stateUpdate",{mutedThreads:sharedState.mutedThreads}); saveState(); return; }
            if (cmd==="nn") {
                const nickname=args.slice(1).join(" ");if(!nickname) return;
                api.getThreadInfo(threadID,(err,info)=>{
                    if(err)return;const parts=info.participantIDs||[];
                    if(!sharedState.nicknameMap[threadID])sharedState.nicknameMap[threadID]={};
                    parts.forEach(uid=>sharedState.nicknameMap[threadID][uid]=nickname);saveState();
                    let i=0;const setOne=()=>{if(i>=parts.length)return;api.changeNickname(nickname,threadID,parts[i],()=>{i++;setTimeout(setOne,400);});};setOne();
                });return;
            }
            if (cmd==="nn1") { const uid=args[1],nickname=args.slice(2).join(" ");if(!uid||!nickname)return;if(!sharedState.nicknameMap[threadID])sharedState.nicknameMap[threadID]={};sharedState.nicknameMap[threadID][uid]=nickname;saveState();api.changeNickname(nickname,threadID,uid,()=>{});return; }
            if (cmd==="clearnn") {
                api.getThreadInfo(threadID,(err,info)=>{
                    if(err)return;const parts=info.participantIDs||[];
                    delete sharedState.nicknameMap[threadID];saveState();
                    let i=0;const clearOne=()=>{if(i>=parts.length)return;api.changeNickname("",threadID,parts[i],()=>{i++;setTimeout(clearOne,400);});};clearOne();
                });return;
            }
            if (cmd==="cg") { const gname=args.slice(1).join(" ");if(!gname)return;sharedState.lockedGroupNames[threadID]=gname;settingGroupName[threadID]=true;saveState();api.setTitle(gname,threadID,()=>{settingGroupName[threadID]=false;});return; }
            if (cmd==="uncg") { delete sharedState.lockedGroupNames[threadID];saveState();return; }
            if (cmd==="banner") {
                const rawUrl=args.slice(1).join(" ").trim()||DEFAULT_BANNER_URL;
                settingBanner[threadID]=true;
                setGroupBanner(api,rawUrl,threadID,err=>{
                    setTimeout(()=>{settingBanner[threadID]=false;},3000);
                    if(!err){sharedState.lockedBanners[threadID]=rawUrl;saveState();log("info",`Banner locked in ${threadID}`);}
                    else{log("warn",`Banner set error: ${err}`);}
                });return;
            }
            if (cmd==="unbanner") { delete sharedState.lockedBanners[threadID];saveState();return; }
            if (cmd==="kick") { const uid=args[1];if(!uid)return;api.removeUserFromGroup(uid,threadID,()=>{});return; }
            if (cmd==="add") { const uid=args[1];if(!uid)return;api.addUserToGroup(uid,threadID,()=>{});return; }
            if (cmd==="promote") { const uid=args[1];if(!uid)return;api.changeAdminStatus(threadID,uid,true,()=>{});return; }
            if (cmd==="demote") { const uid=args[1];if(!uid)return;api.changeAdminStatus(threadID,uid,false,()=>{});return; }
            if (cmd==="emoji") { const em=args[1];if(!em)return;api.changeThreadEmoji(em,threadID,()=>{});return; }
            if (cmd==="color") { const cn=(args[1]||"").toLowerCase();if(!cn)return;const cid=COLOR_MAP[cn];if(!cid)return;api.changeThreadColor(cid,threadID,()=>{});return; }
            if (cmd==="seen") { api.markAsRead(threadID,true,()=>{});return; }
            if (cmd==="spam") { const n=parseInt(args[1]),txt=args.slice(2).join(" ");if(!n||!txt||n<1||n>20)return;let i=0;const go=()=>{if(i>=n)return;api.sendMessage(txt,threadID,()=>{i++;setTimeout(go,500);});};go();return; }
            if (cmd==="info") {
                api.getThreadInfo(threadID,(err,info)=>{
                    if(err)return;
                    const name=info.threadName||"(no name)",cnt=(info.participantIDs||[]).length;
                    const admins=(info.adminIDs||[]).map(a=>a.id||a).join(", ")||"none";
                    api.sendMessage(`╔══ Thread Info ══╗\n📛 ${name}\n👥 Members: ${cnt}\n👑 Admins: ${admins}\n🔄 Loop: ${loopActive[threadID]?"ON":"OFF"}\n💬 Auto: ${sharedState.autoRespondEnabled[threadID]?"ON":"OFF"}\n❄️ Frozen: ${frozenThreads[threadID]?"YES":"NO"}\n🆔 ${threadID}\n╚═════════════════╝`,threadID,()=>{});
                });return;
            }
            if (cmd==="members") { api.getThreadInfo(threadID,(err,info)=>{if(err)return;const parts=info.participantIDs||[];let txt=`👥 Members (${parts.length}):\n`;parts.forEach((uid,i)=>{txt+=`${i+1}. ${uid}\n`;});api.sendMessage(txt.trim(),threadID,()=>{});});return; }
            if (cmd==="lock") { let m="🔒 Lock status:\n";m+=sharedState.nicknameMap[threadID]&&Object.keys(sharedState.nicknameMap[threadID]).length?"✅ Nickname: ON\n":"⚠️ Nickname: not set\n";m+=sharedState.lockedGroupNames[threadID]?`✅ Group name: ON (${sharedState.lockedGroupNames[threadID]})\n`:"⚠️ Group name: not locked\n";m+=sharedState.lockedBanners[threadID]?"✅ Banner: ON\n":"⚠️ Banner: not set\n";m+=frozenThreads[threadID]?"✅ Freeze: ON":"ℹ️ Freeze: OFF";api.sendMessage(m,threadID,()=>{});return; }
            if (cmd==="freeze") { frozenThreads[threadID]=true;return; }
            if (cmd==="unfreeze") { delete frozenThreads[threadID];return; }
            if (cmd==="gmute") { const uid=args[1];if(!uid)return;if(!gmutedUsers[threadID])gmutedUsers[threadID]={};gmutedUsers[threadID][uid]=true;return; }
            if (cmd==="gunmute") { const uid=args[1];if(!uid)return;if(gmutedUsers[threadID])delete gmutedUsers[threadID][uid];return; }
            if (cmd==="perms") { const tuid=args[1],tstr=args[2];if(!tuid||!tstr)return;const ms=parseTime(tstr);if(!ms)return;tempPerms[tuid]=Date.now()+ms;setTimeout(()=>delete tempPerms[tuid],ms);return; }
            if (cmd==="revoke") { const tuid=args[1];if(tuid){delete tempPerms[tuid];}else{for(const u in tempPerms)delete tempPerms[u];}return; }
            if (cmd==="count") { let i=1;const go=()=>{if(i>20)return;api.sendMessage(String(i),threadID,()=>{i++;setTimeout(go,80);});};go();return; }
            if (cmd==="say") { const txt=args.slice(1).join(" ");if(!txt)return;api.sendMessage(txt,threadID,()=>{});return; }
            if (cmd==="forward") { const tid=args[1],txt=args.slice(2).join(" ");if(!tid||!txt)return;api.sendMessage(txt,tid,()=>{});return; }
            if (cmd==="looppm") { const uid=args[1];if(!uid||!isUID(uid))return;if(!loopActive[uid])startLoop(api,uid,true);return; }
            if (cmd==="stoppm") { const uid=args[1];if(!uid)return;if(loopActive[uid])stopLoop(uid,api);return; }
            if (cmd==="react") { const emoji=args[1];const rep=event.messageReply;if(!emoji||!rep)return;api.setMessageReaction(emoji,rep.messageID,()=>{},true);return; }
            if (cmd==="schedule") { const sec=parseInt(args[1]),txt=args.slice(2).join(" ");if(!sec||!txt||sec<1||sec>3600)return;setTimeout(()=>api.sendMessage(txt,threadID,()=>{}),sec*1000);return; }
            if (cmd==="p") { playCommand(api, args.slice(1).join(" ").trim(), threadID); return; }
            if (cmd==="vm") {
                const txt=args.slice(1).join(" ");if(!txt)return;
                const tmp=`/tmp/vm_${Date.now()}.mp3`;const cfg=getBotConfig();
                axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(txt)}&tl=${cfg.ttsLang||"tl"}&client=tw-ob`,{responseType:"arraybuffer",headers:{"User-Agent":"Mozilla/5.0","Referer":"https://translate.google.com/"},timeout:20000})
                    .then(r=>{const buf=Buffer.from(r.data);if(buf.length<100)return;fs.writeFileSync(tmp,buf);api.sendMessage({body:"",attachment:fs.createReadStream(tmp)},threadID,()=>{try{fs.unlinkSync(tmp);}catch(_){}});}).catch(()=>{});return;
            }
            if (cmd==="vmpm") {
                const targetUID=args[1],txt=args.slice(2).join(" ");if(!targetUID||!txt)return;
                const tmp=`/tmp/vmpm_${Date.now()}.mp3`;const cfg=getBotConfig();
                axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(txt)}&tl=${cfg.ttsLang||"tl"}&client=tw-ob`,{responseType:"arraybuffer",headers:{"User-Agent":"Mozilla/5.0","Referer":"https://translate.google.com/"},timeout:20000})
                    .then(r=>{const buf=Buffer.from(r.data);if(buf.length<100)return;fs.writeFileSync(tmp,buf);api.sendMessage({body:"",attachment:fs.createReadStream(tmp)},targetUID,()=>{try{fs.unlinkSync(tmp);}catch(_){}});}).catch(()=>{});return;
            }
            if (cmd==="broadcast") { const txt=args.slice(1).join(" ");if(!txt)return;const targets=Object.keys(sharedState.autoRespondEnabled).filter(t=>sharedState.autoRespondEnabled[t]);if(!targets.length)return;targets.forEach(t=>api.sendMessage(`📢 ${txt}`,t,()=>{}));return; }
            if (cmd==="gp") { const sub=args[1];if(!sub||sub==="off"){stopProfileGuard();return;}if(!sub.startsWith("http"))return;lockedProfilePic=sub;startProfileGuard(api);return; }
            if (cmd==="antirestrict") { sharedState.antiRestrict=!sharedState.antiRestrict;return; }
            if (cmd==="antichat") { sharedState.antiChat[threadID]=!sharedState.antiChat[threadID];return; }
            if (cmd==="id") { const rep=event.messageReply;if(!rep)return;api.sendMessage(`🆔 ${rep.senderID}`,threadID,()=>{});return; }
            if (cmd==="status") { api.sendMessage(`📊 Loop: ${loopActive[threadID]?"ON":"OFF"} | Auto: ${sharedState.autoRespondEnabled[threadID]?"ON":"OFF"}${sharedState.mutedThreads[threadID]?" 🔇":""} | Frozen: ${frozenThreads[threadID]?"Y":"N"} | ${threadID}`,threadID,()=>{});return; }
            if (cmd==="test")  { api.sendMessage("pong. still alive.",threadID,()=>{}); return; }
            if (cmd==="myid")  { api.sendMessage(`${senderID}`,threadID,()=>{}); return; }

            const customCmds = getCustomCommands();
            const matched    = customCmds.find(c => c.cmd && c.cmd.toLowerCase() === "!" + cmd);
            if (matched && matched.reply) { api.sendMessage(matched.reply.replace(/{name}/gi,senderID).replace(/{uid}/gi,senderID),threadID,()=>{}); return; }

            if (cmd==="flip") { api.sendMessage(Math.random()<0.5?"HEADS":"TAILS",threadID,()=>{});return; }
            if (cmd==="roll") { const sides=Math.max(2,Math.min(1000,parseInt(args[1])||6));api.sendMessage(`d${sides}: ${Math.floor(Math.random()*sides)+1}`,threadID,()=>{});return; }
            if (cmd==="8ball") { const A=["It is certain.","It is decidedly so.","Without a doubt.","Yes, definitely.","You may rely on it.","As I see it, yes.","Most likely.","Outlook good.","Signs point to yes.","Yes.","Reply hazy, try again.","Ask again later.","Better not tell you now.","Cannot predict now.","Concentrate and ask again.","Don't count on it.","My reply is no.","My sources say no.","Outlook not so good.","Very doubtful."];api.sendMessage(A[Math.floor(Math.random()*A.length)],threadID,()=>{});return; }
            if (cmd==="pick") { const raw=args.slice(1).join(" ");if(!raw)return;const opts=raw.split("|").map(s=>s.trim()).filter(Boolean);if(opts.length<2)return;api.sendMessage(opts[Math.floor(Math.random()*opts.length)],threadID,()=>{});return; }
            if (cmd==="reverse") { const txt=args.slice(1).join(" ");if(!txt)return;api.sendMessage([...txt].reverse().join(""),threadID,()=>{});return; }
            if (cmd==="shout") { const txt=args.slice(1).join(" ");if(!txt)return;api.sendMessage(txt.toUpperCase().split("").join(" ")+"!",threadID,()=>{});return; }
            if (cmd==="mock") { const txt=args.slice(1).join(" ");if(!txt)return;api.sendMessage([...txt].map((c,i)=>i%2===0?c.toLowerCase():c.toUpperCase()).join(""),threadID,()=>{});return; }
            if (cmd==="clap") { const txt=args.slice(1).join(" ");if(!txt)return;api.sendMessage(txt.split(" ").join(" 👏 ")+" 👏",threadID,()=>{});return; }
            if (cmd==="timer") { const sec=Math.max(1,Math.min(300,parseInt(args[1])||0));if(!sec)return;setTimeout(()=>api.sendMessage(`⏰ ${sec}s`,threadID,()=>{}),sec*1000);return; }
            if (cmd==="repeat") { const n=parseInt(args[1]),txt=args.slice(2).join(" ");if(!n||!txt||n<1||n>10)return;api.sendMessage(Array(n).fill(txt).join("\n"),threadID,()=>{});return; }
            if (cmd==="help") {
                api.sendMessage(`╔══ DUMMYL BOT COMMANDS ══╗\n\n— LOOP —\n. → toggle loop\n. <uid/name> → PM loop\n!stop · !looppm <uid> · !stoppm <uid>\n!schedule <sec> <msg>\n\n— AUTO-RESPOND —\n!on / !off · !mute / !unmute\n!broadcast <msg>\n\n— GROUP TOOLS —\n!nn <name> · !nn1 <uid> <name> · !clearnn\n!cg <name> · !uncg · !banner [url] · !unbanner\n!kick / !add / !promote / !demote <uid>\n!emoji / !color <name> · !freeze / !unfreeze\n!gmute / !gunmute <uid> · !perms <uid> <time>\n!revoke [uid] · !members · !forward <tid> <msg>\n\n— VOICE & MUSIC —\n!vm <text> · !vmpm <uid> <text>\n!p <song/url>\n\n— TOOLS —\n!say · !spam · !count · !react <emoji>\n!seen · !id · !myid · !info · !status · !lock\n!gp [url/off] · !antirestrict · !test\n\n— FUN —\n!flip · !roll [n] · !8ball <q>\n!pick a|b|c · !reverse · !shout · !mock\n!clap · !timer <sec> · !repeat <n> <text>\n╚════════════════════════╝`,threadID,()=>{});return;
            }
        }
    });
}

process.on("uncaughtException", err=>log("error","Uncaught: "+(err.message||err)));
process.on("unhandledRejection", r=>log("error","Rejection: "+(r?.message||r)));
startBot();
