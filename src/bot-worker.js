"use strict";

const { login } = require("ws3-fca");
const fs   = require("fs");
const path = require("path");
const axios = require("axios");
const { replies, imageReplies: builtinImageReplies } = require("./replies");

const FBSTATE_PATH       = process.argv[2];
const BOT_LABEL          = process.argv[3] || "Bot";
const DEVELOPER_ID       = process.argv[4] || "";
const PREFIX             = "!";
const MIN_RECONNECT      = 5000;
const MAX_RECONNECT      = 60000;
const DEFAULT_BANNER_URL = "https://file.garden/aahuG_hIDGRlXD24/image.jpg";
const STATE_FILE         = path.join(__dirname, "../data/bot_state.json");
const CUSTOM_REPLIES_FILE= path.join(__dirname, "../data/custom_replies.json");
const IMAGE_REPLIES_FILE = path.join(__dirname, "../data/image_replies.json");
const BOT_CONFIG_FILE    = path.join(__dirname, "../data/bot_config.json");
const FBSTATE_FILE       = path.join(__dirname, "../data/fbstate.json");

const COLOR_MAP = {
    blue:"196241301102133",pink:"169463077092846",hotpink:"169463077092846",
    aqua:"2442142322678320",purple:"234137870477637",coral:"980963458735625",
    orange:"175615189761153",green:"2136751179887052",lavender:"2058653964378557",
    red:"2129984390566328",yellow:"174636906462322",teal:"1928399724138152",
    berry:"164535220883264",ocean:"736591620215564",love:"741311439775765",
    rose:"1257453361255152",monochrome:"788274591712841",candy:"205488546921017",
    unicorn:"273728810607574",tropical:"262191918210707",default:"3259963564026002",
};

// ─── IPC ─────────────────────────────────────────────────────────────────────
function send(type, payload = {}) { try { process.send({ type, ...payload }); } catch (_) {} }
function log(level, msg) { send("log", { level, message: `[${BOT_LABEL}] ${msg}` }); }

// ─── STATE ────────────────────────────────────────────────────────────────────
function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        return {
            loopEnabled:       s.loopEnabled       || {},  // dot-triggered loop state (persisted)
            autoRespondEnabled:s.autoRespondEnabled || {},  // !on/!off auto-respond (groups only)
            mutedThreads:      s.mutedThreads       || {},
            nicknameMap:       s.nicknameMap        || {},
            antiRestrict:      s.antiRestrict       || false,
            antiChat:          s.antiChat           || {},
        };
    } catch (_) {
        return { loopEnabled:{}, autoRespondEnabled:{}, mutedThreads:{}, nicknameMap:{}, antiRestrict:false, antiChat:{} };
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
        }, null, 2));
    } catch (_) {}
}
const sharedState = loadState();

// ─── IN-MEMORY LOOP TRACKERS ──────────────────────────────────────────────────
let reconnectDelay  = MIN_RECONNECT;
let lockedProfilePic= null;
let profilePicTimer = null;
const tempPerms     = {};
const loopActive    = {};   // threadID → bool (loop timer is running)
const loopTimers    = {};   // threadID → setTimeout handle
const loopIndex     = {};   // sequential index per thread
const loopCounts    = {};   // how many messages sent this run
const loopAutoStop  = {};   // auto-stop timeout handles
const spamTracker   = {};   // anti-spam

// ─── RESOURCE READERS ─────────────────────────────────────────────────────────
function getBotConfig() {
    try { return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, "utf8")); }
    catch (_) { return { loopReact:"😆",loopDelay:5,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false }; }
}
function getCustomReplies() {
    try { return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE, "utf8")); } catch (_) { return []; }
}
function getImageReplies() {
    let custom = [];
    try { custom = JSON.parse(fs.readFileSync(IMAGE_REPLIES_FILE, "utf8")); } catch (_) {}
    return [...builtinImageReplies, ...custom].filter(u => u && u.startsWith("http"));
}
function getAllReplies() {
    return [...replies, ...getCustomReplies()];
}
function getRandomReply() {
    const all = getAllReplies();
    if (!all.length) return "...";
    return all[Math.floor(Math.random() * all.length)];
}
function getRandomImageUrl() {
    const imgs = getImageReplies();
    return imgs.length ? imgs[Math.floor(Math.random() * imgs.length)] : null;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function startProfileGuard(api) {
    if (profilePicTimer) clearInterval(profilePicTimer);
    profilePicTimer = setInterval(() => {
        if (!lockedProfilePic || !api) return;
        api.changeAvatar(lockedProfilePic, "", err => {
            if (err) log("warn", `!gp restore error: ${err.message||err}`);
            else log("info", "!gp — profile picture restored.");
        });
    }, 5 * 60 * 1000);
}
function stopProfileGuard() {
    if (profilePicTimer) { clearInterval(profilePicTimer); profilePicTimer = null; }
    lockedProfilePic = null;
}
function hasTempPerm(uid) {
    if (!tempPerms[uid]) return false;
    if (Date.now() > tempPerms[uid]) { delete tempPerms[uid]; return false; }
    return true;
}
function isAuthorized(senderID, isSelf) {
    return senderID === DEVELOPER_ID || isSelf || hasTempPerm(senderID);
}
function parseTime(str) {
    const m = str.match(/^(\d+)(s|sec|min|m|h|hr)$/i);
    if (!m) return null;
    const v = parseInt(m[1]), u = m[2].toLowerCase();
    if (u==="s"||u==="sec") return v*1000;
    if (u==="m"||u==="min") return v*60000;
    if (u==="h"||u==="hr")  return v*3600000;
    return null;
}
function formatTimeLeft(ms) {
    const s=Math.ceil(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
    if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;
}
function setGroupBanner(api, imageUrl, threadID, cb) {
    axios.get(imageUrl,{responseType:"stream"})
        .then(r=>api.changeGroupImage(r.data,threadID,err=>{if(cb)cb(err);}))
        .catch(err=>{if(cb)cb(err);});
}
function checkAntiSpam(senderID, threadID, cfg) {
    if (!cfg.antiSpamEnabled) return false;
    const key = `${senderID}_${threadID}`;
    const now  = Date.now(), win = (cfg.antiSpamWindowSec||10)*1000;
    if (!spamTracker[key]) spamTracker[key] = [];
    spamTracker[key] = spamTracker[key].filter(t => now-t < win);
    spamTracker[key].push(now);
    return spamTracker[key].length > (cfg.antiSpamMaxMsg||5);
}

// ─── LOOP (dot trigger — works in BOTH groups AND PMs) ────────────────────────
function startLoop(api, threadID) {
    if (loopActive[threadID]) return;
    loopActive[threadID] = true;
    loopCounts[threadID] = 0;
    if (!loopIndex[threadID]) loopIndex[threadID] = 0;
    sharedState.loopEnabled[threadID] = true;
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
    const cfg0 = getBotConfig();
    if (cfg0.loopStartMsg) api.sendMessage(cfg0.loopStartMsg, threadID, ()=>{});
    if (cfg0.autoStopMinutes > 0) {
        if (loopAutoStop[threadID]) clearTimeout(loopAutoStop[threadID]);
        loopAutoStop[threadID] = setTimeout(()=>stopLoop(threadID,api), cfg0.autoStopMinutes*60000);
    }
    function sendNext() {
        if (!loopActive[threadID]) return;
        const cfg = getBotConfig();
        const all = getAllReplies();
        if (!all.length) { loopTimers[threadID]=setTimeout(sendNext,(cfg.loopDelay||5)*1000); return; }
        if (cfg.maxLoopCount > 0 && loopCounts[threadID] >= cfg.maxLoopCount) { stopLoop(threadID,api); return; }
        let idx;
        if ((cfg.loopMode||"sequential")==="shuffle") {
            idx = Math.floor(Math.random()*all.length);
        } else {
            idx = loopIndex[threadID] % all.length;
            loopIndex[threadID] = (idx+1) % all.length;
        }
        loopCounts[threadID]++;
        const useImage = !cfg.reactOnlyMode && Math.random() < ((cfg.imageProbability||20)/100);
        const imageUrl = getRandomImageUrl();
        function onSent(err, msgInfo) {
            if (!err && msgInfo?.messageID)
                api.setMessageReaction(cfg.loopReact||"😆", msgInfo.messageID, ()=>{}, true);
            send("totalReply");
            if (loopActive[threadID])
                loopTimers[threadID] = setTimeout(sendNext, (cfg.loopDelay||5)*1000);
        }
        if (useImage && imageUrl) {
            axios.get(imageUrl,{responseType:"stream",timeout:15000})
                .then(r=>api.sendMessage({attachment:r.data},threadID,onSent))
                .catch(()=>api.sendMessage(all[idx],threadID,onSent));
        } else {
            api.sendMessage(all[idx], threadID, onSent);
        }
    }
    sendNext();
}

function stopLoop(threadID, api) {
    loopActive[threadID] = false;
    loopIndex[threadID]  = 0;
    loopCounts[threadID] = 0;
    if (loopTimers[threadID])  { clearTimeout(loopTimers[threadID]);  delete loopTimers[threadID]; }
    if (loopAutoStop[threadID]){ clearTimeout(loopAutoStop[threadID]); delete loopAutoStop[threadID]; }
    sharedState.loopEnabled[threadID] = false;
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
    const cfg = getBotConfig();
    if (api && cfg.loopStopMsg) api.sendMessage(cfg.loopStopMsg, threadID, ()=>{});
}

// ─── AUTO-RESPOND (groups only, triggered by !on / !off) ──────────────────────
function sendAutoReply(api, threadID, retryCount=0) {
    const cfg = getBotConfig();
    const imageUrl = getRandomImageUrl();
    const useImage = imageUrl && Math.random() < ((cfg.imageProbability||20)/100);
    const MAX_RETRIES = 2;
    function onDone(err, msgInfo) {
        if (err) {
            log("warn", `AutoReply send failed in ${threadID}: ${err.message||err}`);
            if (sharedState.antiChat[threadID] && retryCount < MAX_RETRIES) {
                setTimeout(()=>sendAutoReply(api,threadID,retryCount+1), 30000);
            }
            return;
        }
        if (msgInfo?.messageID) api.setMessageReaction("😂",msgInfo.messageID,()=>{},true);
    }
    if (useImage) {
        axios.get(imageUrl,{responseType:"stream",timeout:15000})
            .then(r=>api.sendMessage({attachment:r.data},threadID,onDone))
            .catch(()=>api.sendMessage(getRandomReply(),threadID,onDone));
    } else {
        api.sendMessage(getRandomReply(), threadID, onDone);
    }
}

// ─── RECONNECT ────────────────────────────────────────────────────────────────
function scheduleReconnect() {
    log("warn", `Reconnecting in ${reconnectDelay/1000}s...`);
    send("status",{loggedIn:false,reconnecting:true,nextReconnectIn:reconnectDelay/1000});
    setTimeout(()=>{ send("status",{reconnecting:false}); startBot(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay*2, MAX_RECONNECT);
}

// ─── MAIN BOT ─────────────────────────────────────────────────────────────────
function startBot() {
    let appState;
    try { appState = JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8")); }
    catch(e) {
        log("error","Cannot read fbstate: "+e.message);
        send("status",{loggedIn:false,reconnecting:false});
        return;
    }

    login(appState,{bypassRegion:"ash",online:false,selfListen:true,listenEvents:true,autoMarkDelivery:false},(err,api)=>{
        if (err) {
            const msg = err.message||JSON.stringify(err);
            log("error","Login failed: "+msg);
            const isExpired = msg.includes("Error retrieving userID")||msg.includes("Checkpoint");
            if (isExpired && reconnectDelay>=MAX_RECONNECT) {
                log("error","Session expired. Please update the fbstate cookie from the dashboard.");
                send("status",{loggedIn:false,reconnecting:false,expired:true});
                return;
            }
            scheduleReconnect();
            return;
        }

        api.setOptions({ userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36" });
        reconnectDelay = MIN_RECONNECT;
        send("status",{loggedIn:true,reconnecting:false,expired:false,nextReconnectIn:0});
        log("info","Logged in. Listening for messages...");

        const keepalive = setInterval(()=>{ try{api.getThreadList(1,null,[],()=>{})}catch(_){} },55000);
        if (lockedProfilePic) startProfileGuard(api);

        const lockedBanner     = {};
        const settingBanner    = {};
        const lockedGroupName  = {};
        const settingGroupName = {};
        const frozenThreads    = {};

        api.listenMqtt((err,event)=>{
            if (err) {
                clearInterval(keepalive);
                const code = err.error||(err.res&&err.res.error)||"unknown";
                log("error",`Listener error (code ${code}): session may be expired.`);
                send("status",{loggedIn:false});
                scheduleReconnect();
                return;
            }
            try { handleEvent(api,event,lockedBanner,settingBanner,lockedGroupName,settingGroupName,frozenThreads); }
            catch(e) { log("error","Event handler crash: "+(e.message||e)); }
        });

        function handleEvent(api,event,lockedBanner,settingBanner,lockedGroupName,settingGroupName,frozenThreads) {
            if (event.type==="presence"||event.type==="typ") return;
            log("info",`Event: ${event.type} ${event.logMessageType||""} ${event.body?'"'+event.body.slice(0,30)+'"':""}`);

            // ── Nickname lock
            if (event.type==="event"&&event.logMessageType==="log:user-nickname") {
                const tid=event.threadID,uid=event.logMessageData?.participant_id;
                if (sharedState.nicknameMap[tid]?.[uid]!==undefined) {
                    const saved=sharedState.nicknameMap[tid][uid],current=event.logMessageData?.nickname||"";
                    if (current!==saved) api.changeNickname(saved,tid,uid,()=>log("info",`Nickname restored for ${uid}`));
                }
                return;
            }
            // ── Banner lock
            if (event.type==="event"&&event.logMessageType==="log:thread-image") {
                const tid=event.threadID;
                if (lockedBanner[tid]&&!settingBanner[tid]) {
                    settingBanner[tid]=true;
                    setTimeout(()=>setGroupBanner(api,lockedBanner[tid],tid,()=>{settingBanner[tid]=false;}),1500);
                }
                return;
            }
            // ── Group name lock
            if (event.type==="event"&&event.logMessageType==="log:thread-name") {
                const tid=event.threadID;
                if (lockedGroupName[tid]&&!settingGroupName[tid]) {
                    settingGroupName[tid]=true;
                    setTimeout(()=>api.setTitle(lockedGroupName[tid],tid,()=>{settingGroupName[tid]=false;}),1500);
                }
                return;
            }
            // ── Anti-restrict
            if (event.type==="event"&&event.logMessageType==="log:unsubscribe") {
                const removedUID=event.logMessageData?.leftParticipantFbId;
                if (removedUID===api.getCurrentUserID()) {
                    log("warn",`Bot was removed from group ${event.threadID}!`);
                    if (sharedState.antiRestrict) api.sendMessage(`[anti-restrict] Removed from group ${event.threadID}.`,DEVELOPER_ID,()=>{});
                }
                return;
            }
            // ── Greet new members
            if (event.type==="event"&&event.logMessageType==="log:subscribe") {
                const cfg=getBotConfig();
                if (cfg.greetNewMembers&&cfg.greetMsg) {
                    (event.logMessageData?.addedParticipants||[]).forEach(p=>{
                        api.sendMessage(cfg.greetMsg,event.threadID,()=>{});
                    });
                }
                return;
            }
            if (event.type!=="message") return;

            const {threadID,senderID,body,messageID}=event;
            const isSelf   = senderID===api.getCurrentUserID();
            const isGroup  = !!event.isGroup;
            const isPM     = !isGroup;
            const message  = (body||"").trim();

            log("info",`[MSG] sender=${senderID} group=${isGroup} self=${isSelf} msg="${message.substring(0,40)}"`);

            // Auto-seen
            const cfg0=getBotConfig();
            if (cfg0.autoSeenEnabled&&!isSelf) { try{api.markAsRead(threadID,true,()=>{})}catch(_){} }

            // Frozen group
            if (frozenThreads[threadID]&&!isSelf&&senderID!==DEVELOPER_ID&&!hasTempPerm(senderID)) {
                if (!message.startsWith(PREFIX)) {
                    api.removeUserFromGroup(senderID,threadID,err=>{
                        if(!err)log("warn",`Kicked ${senderID} from frozen ${threadID}`);
                    });
                    return;
                }
            }

            // Anti-spam (groups only)
            if (isGroup&&!isSelf&&!isAuthorized(senderID,isSelf)) {
                if (checkAntiSpam(senderID,threadID,getBotConfig())) {
                    log("warn",`Anti-spam: kicking ${senderID}`);
                    api.removeUserFromGroup(senderID,threadID,()=>{});
                    return;
                }
            }

            // ── DOT TRIGGER: Toggle loop
            // In PM: any participant can trigger (both sides of the conversation)
            // In groups: must be authorized (self or developer or temp perms)
            const canDot = isPM || isSelf || isAuthorized(senderID, isSelf);
            if (message==="." && canDot) {
                if (loopActive[threadID]) { stopLoop(threadID,api); log("info",`Loop OFF — ${threadID}`); }
                else { startLoop(api,threadID); log("info",`Loop ON — ${threadID}`); }
                return;
            }

            if (isSelf&&!message.startsWith(PREFIX)) return;

            if (message.startsWith(PREFIX)) {
                const args = message.slice(PREFIX.length).trim().split(/\s+/);
                const cmd  = args[0].toLowerCase();

                // ── !on / !off : AUTO-RESPOND (GROUPS ONLY)
                if (cmd==="on") {
                    if (isPM) { api.sendMessage("❌ !on is for groups only. Use . (dot) to toggle the loop in PM.",threadID); return; }
                    if (!isAuthorized(senderID,isSelf)) return;
                    sharedState.autoRespondEnabled[threadID]=true;
                    send("stateUpdate",{autoRespondEnabled:sharedState.autoRespondEnabled});
                    saveState(); log("info",`Auto-respond ON — ${threadID}`);
                    api.sendMessage("✅ Auto-respond is ON. I'll reply to every message sent.",threadID);
                    return;
                }
                if (cmd==="off") {
                    if (isPM) { api.sendMessage("❌ !off is for groups only. Use . (dot) to toggle the loop in PM.",threadID); return; }
                    if (!isAuthorized(senderID,isSelf)) return;
                    sharedState.autoRespondEnabled[threadID]=false;
                    send("stateUpdate",{autoRespondEnabled:sharedState.autoRespondEnabled});
                    saveState(); log("info",`Auto-respond OFF — ${threadID}`);
                    api.sendMessage("🔴 Auto-respond is OFF.",threadID);
                    return;
                }

                if (!isAuthorized(senderID,isSelf)) {
                    log("warn",`Command blocked — not authorized. Sender: ${senderID}`);
                    return;
                }

                if (cmd==="mute") {
                    sharedState.mutedThreads[threadID]=true;
                    send("stateUpdate",{mutedThreads:sharedState.mutedThreads});
                    saveState();
                    api.sendMessage("🔇 Muted. Use !unmute to resume auto-respond.",threadID); return;
                }
                if (cmd==="unmute") {
                    delete sharedState.mutedThreads[threadID];
                    send("stateUpdate",{mutedThreads:sharedState.mutedThreads});
                    saveState();
                    api.sendMessage("🔔 Unmuted!",threadID); return;
                }
                if (cmd==="nn") {
                    const nickname=args.slice(1).join(" ");
                    if(!nickname){api.sendMessage("Usage: !nn <nickname>",threadID);return;}
                    api.getThreadInfo(threadID,(err,info)=>{
                        if(err){api.sendMessage("❌ Could not get thread info.",threadID);return;}
                        const parts=info.participantIDs||[];
                        if(!sharedState.nicknameMap[threadID])sharedState.nicknameMap[threadID]={};
                        parts.forEach(uid=>sharedState.nicknameMap[threadID][uid]=nickname);
                        let done=0,fail=0;
                        parts.forEach(uid=>api.changeNickname(nickname,threadID,uid,e=>{
                            e?fail++:done++;
                            if(done+fail===parts.length)
                                api.sendMessage(`✅ Nickname "${nickname}" set for ${done}/${parts.length}. Protection ON.`,threadID);
                        }));
                    });return;
                }
                if (cmd==="cg") {
                    const gname=args.slice(1).join(" ");
                    if(!gname){api.sendMessage("Usage: !cg <name>",threadID);return;}
                    lockedGroupName[threadID]=gname;settingGroupName[threadID]=true;
                    api.setTitle(gname,threadID,err=>{
                        settingGroupName[threadID]=false;
                        if(err){api.sendMessage("❌ Failed.",threadID);return;}
                        api.sendMessage(`✅ Group name → "${gname}". Protection ON.`,threadID);
                    });return;
                }
                if (cmd==="banner") {
                    const url=args[1]||DEFAULT_BANNER_URL;
                    api.sendMessage("⏳ Setting group photo...",threadID);
                    settingBanner[threadID]=true;
                    setGroupBanner(api,url,threadID,err=>{
                        settingBanner[threadID]=false;
                        if(err){api.sendMessage("❌ Failed. Check URL.",threadID);return;}
                        lockedBanner[threadID]=url;
                        api.sendMessage(`✅ Group photo set + protected.`,threadID);
                    });return;
                }
                if (cmd==="kick") {
                    const uid=args[1];
                    if(!uid){api.sendMessage("Usage: !kick <UID>",threadID);return;}
                    api.removeUserFromGroup(uid,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed. Make sure I'm an admin.",threadID);return;}
                        api.sendMessage(`✅ Kicked ${uid}.`,threadID);
                    });return;
                }
                if (cmd==="add") {
                    const uid=args[1];
                    if(!uid){api.sendMessage("Usage: !add <UID>",threadID);return;}
                    api.addUserToGroup(uid,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed.",threadID);return;}
                        api.sendMessage(`✅ Added ${uid}.`,threadID);
                    });return;
                }
                if (cmd==="emoji") {
                    const em=args[1];
                    if(!em){api.sendMessage("Usage: !emoji <emoji>",threadID);return;}
                    api.changeThreadEmoji(em,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed.",threadID);return;}
                        api.sendMessage(`✅ Emoji → ${em}`,threadID);
                    });return;
                }
                if (cmd==="color") {
                    const cn=(args[1]||"").toLowerCase();
                    if(!cn){api.sendMessage(`Usage: !color <name>\nOptions: ${Object.keys(COLOR_MAP).join(", ")}`,threadID);return;}
                    const cid=COLOR_MAP[cn];
                    if(!cid){api.sendMessage(`❌ Unknown color. Options: ${Object.keys(COLOR_MAP).join(", ")}`,threadID);return;}
                    api.changeThreadColor(cid,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed.",threadID);return;}
                        api.sendMessage(`✅ Color → ${cn}`,threadID);
                    });return;
                }
                if (cmd==="seen") {
                    api.markAsRead(threadID,true,err=>{
                        api.sendMessage(err?"❌ Failed.":"✅ All messages marked as seen.",threadID);
                    });return;
                }
                if (cmd==="spam") {
                    const n=parseInt(args[1]),txt=args.slice(2).join(" ");
                    if(!n||!txt||n<1||n>20){api.sendMessage("Usage: !spam <1-20> <message>",threadID);return;}
                    let i=0;const go=()=>{if(i>=n)return;api.sendMessage(txt,threadID,()=>{i++;setTimeout(go,500);});};
                    go();return;
                }
                if (cmd==="info") {
                    api.getThreadInfo(threadID,(err,info)=>{
                        if(err){api.sendMessage("❌ Could not get info.",threadID);return;}
                        const name=info.threadName||"(no name)",cnt=(info.participantIDs||[]).length;
                        const admins=(info.adminIDs||[]).map(a=>a.id||a).join(", ")||"none";
                        const loop=loopActive[threadID]?"🟢 ON":"🔴 OFF";
                        const ar=sharedState.autoRespondEnabled[threadID]?"🟢 ON":"🔴 OFF";
                        api.sendMessage(`╔══ Thread Info ══╗\n📛 ${name}\n👥 Members: ${cnt}\n👑 Admins: ${admins}\n🔄 Loop: ${loop}\n💬 Auto-respond: ${ar}\n❄️ Frozen: ${frozenThreads[threadID]?"YES":"NO"}\n🆔 ${threadID}\n╚═════════════════╝`,threadID);
                    });return;
                }
                if (cmd==="lock") {
                    let m="🔒 Lock status:\n";
                    m+=sharedState.nicknameMap[threadID]&&Object.keys(sharedState.nicknameMap[threadID]).length?"✅ Nickname: ON\n":"⚠️ Nickname: not set\n";
                    m+=lockedGroupName[threadID]?`✅ Group name: ON (${lockedGroupName[threadID]})\n`:"⚠️ Group name: not locked\n";
                    m+=lockedBanner[threadID]?"✅ Banner: ON\n":"⚠️ Banner: not set\n";
                    m+=frozenThreads[threadID]?"✅ Freeze: ON":"ℹ️ Freeze: OFF";
                    api.sendMessage(m,threadID);return;
                }
                if (cmd==="freeze") {
                    frozenThreads[threadID]=true;
                    api.sendMessage("❄️ Group FROZEN. Anyone who chats will be kicked. Use !unfreeze to lift.",threadID);return;
                }
                if (cmd==="unfreeze") {
                    delete frozenThreads[threadID];
                    api.sendMessage("✅ Group UNFROZEN.",threadID);return;
                }
                if (cmd==="perms") {
                    const tuid=args[1],tstr=args[2];
                    if(!tuid||!tstr){api.sendMessage("Usage: !perms <UID> <time>  e.g. !perms 100xxx 5min",threadID);return;}
                    const ms=parseTime(tstr);
                    if(!ms){api.sendMessage("❌ Invalid time. Use: 30s, 5min, 1h",threadID);return;}
                    tempPerms[tuid]=Date.now()+ms;
                    api.sendMessage(`✅ Permissions granted to ${tuid} for ${formatTimeLeft(ms)}.`,threadID);
                    setTimeout(()=>delete tempPerms[tuid],ms);return;
                }
                if (cmd==="revoke") {
                    const tuid=args[1];
                    if(tuid){
                        if(tempPerms[tuid]){delete tempPerms[tuid];api.sendMessage(`✅ Revoked for ${tuid}.`,threadID);}
                        else api.sendMessage(`ℹ️ ${tuid} has no active perms.`,threadID);
                    } else {
                        const c=Object.keys(tempPerms).length;
                        for(const u in tempPerms)delete tempPerms[u];
                        api.sendMessage(`✅ Revoked all perms (${c} users).`,threadID);
                    }return;
                }
                if (cmd==="count") {
                    let i=1;const go=()=>{if(i>20)return;api.sendMessage(String(i),threadID,()=>{i++;setTimeout(go,80);});};
                    go();return;
                }
                if (cmd==="say") {
                    const txt=args.slice(1).join(" ");
                    if(!txt){api.sendMessage("Usage: !say <message>",threadID);return;}
                    api.sendMessage(txt,threadID);return;
                }
                if (cmd==="vm") {
                    const txt=args.slice(1).join(" ");
                    if(!txt){api.sendMessage("Usage: !vm <text>",threadID);return;}
                    const tmp=`/tmp/vm_${Date.now()}.mp3`;
                    const cfg=getBotConfig();
                    axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(txt)}&tl=${cfg.ttsLang||"tl"}&client=tw-ob&ttsspeed=1`,{
                        responseType:"arraybuffer",
                        headers:{"User-Agent":"Mozilla/5.0","Referer":"https://translate.google.com/","Accept":"audio/mpeg"},
                        timeout:20000
                    }).then(r=>{
                        const buf=Buffer.from(r.data);
                        if(buf.length<100){api.sendMessage("❌ TTS empty. Try again.",threadID);return;}
                        fs.writeFileSync(tmp,buf);
                        api.sendMessage({body:"",attachment:fs.createReadStream(tmp)},threadID,e=>{
                            try{fs.unlinkSync(tmp)}catch(_){}
                            if(e)api.sendMessage("❌ Failed to send voice.",threadID);
                        });
                    }).catch(()=>api.sendMessage("❌ TTS failed.",threadID));
                    return;
                }
                if (cmd==="broadcast") {
                    const txt=args.slice(1).join(" ");
                    if(!txt){api.sendMessage("Usage: !broadcast <message>",threadID);return;}
                    const targets=Object.keys(sharedState.autoRespondEnabled).filter(t=>sharedState.autoRespondEnabled[t]);
                    if(!targets.length){api.sendMessage("⚠️ No active auto-respond threads.",threadID);return;}
                    targets.forEach(t=>api.sendMessage(`📢 ${txt}`,t,()=>{}));
                    api.sendMessage(`✅ Broadcast to ${targets.length} thread(s).`,threadID);return;
                }
                if (cmd==="gp") {
                    const sub=args[1];
                    if(!sub||sub==="off"){stopProfileGuard();api.sendMessage("Guard profile OFF.",threadID);return;}
                    if(!sub.startsWith("http")){api.sendMessage("Usage: !gp <url> | !gp off",threadID);return;}
                    lockedProfilePic=sub;startProfileGuard(api);
                    api.sendMessage("✅ Profile guard ON. Restores every 5min.",threadID);return;
                }
                if (cmd==="antirestrict") {
                    sharedState.antiRestrict=!sharedState.antiRestrict;
                    api.sendMessage(`Anti-restrict: ${sharedState.antiRestrict?"ON — will notify on kick":"OFF"}.`,threadID);return;
                }
                if (cmd==="antichat") {
                    sharedState.antiChat[threadID]=!sharedState.antiChat[threadID];
                    api.sendMessage(`Anti-chat retry: ${sharedState.antiChat[threadID]?"ON":"OFF"}.`,threadID);return;
                }
                if (cmd==="id") {
                    const rep=event.messageReply;
                    if(!rep){api.sendMessage("❌ Reply to someone's message first.",threadID);return;}
                    api.sendMessage(`🆔 ID: ${rep.senderID}`,threadID);return;
                }
                if (cmd==="status") {
                    const loop=loopActive[threadID]?"🟢 ON":"🔴 OFF";
                    const ar=sharedState.autoRespondEnabled[threadID]?"🟢 ON":"🔴 OFF";
                    const muted=sharedState.mutedThreads[threadID];
                    api.sendMessage(`📊 Status:\nLoop (dot): ${loop}\nAuto-respond (!on/!off): ${ar}${muted?" 🔇 muted":""}\nFrozen: ${frozenThreads[threadID]?"YES ❄️":"NO"}`,threadID);return;
                }
                if (cmd==="test") { api.sendMessage("online ako bobo ka",threadID);return; }
                if (cmd==="myid") { api.sendMessage(`Your Facebook ID: ${senderID}`,threadID);return; }
                if (cmd==="help") {
                    api.sendMessage(
                        `╔══ CZB BOT COMMANDS ══╗\n`+
                        `\n— LOOP (dot trigger) —\n`+
                        `. (dot) — toggle loop ON/OFF in groups & PMs\n`+
                        `\n— AUTO-RESPOND (groups only) —\n`+
                        `!on — auto-respond to every message\n`+
                        `!off — stop auto-respond\n`+
                        `!mute / !unmute — pause/resume auto-respond\n`+
                        `\n— GROUP TOOLS —\n`+
                        `!nn <name> — nickname all members\n`+
                        `!cg <name> — change group name\n`+
                        `!banner [url] — set group photo\n`+
                        `!kick/!add <uid> — kick/add member\n`+
                        `!emoji <e> — change group emoji\n`+
                        `!color <name> — change chat color\n`+
                        `!freeze / !unfreeze — freeze group\n`+
                        `!perms <uid> <time> — temp perms\n`+
                        `!revoke [uid] — remove perms\n`+
                        `\n— UTILITY —\n`+
                        `!say <text> — bot sends text\n`+
                        `!vm <text> — voice message (TTS)\n`+
                        `!spam <n> <text> — spam n times\n`+
                        `!broadcast <text> — send to all active threads\n`+
                        `!seen / !count / !id / !info / !lock\n`+
                        `!status — show loop + auto-respond status\n`+
                        `!gp <url> / !gp off — profile guard\n`+
                        `!test / !myid\n`+
                        `╚══════════════════════╝`,threadID
                    );return;
                }
                api.sendMessage(`❓ Unknown command. Send !help for the list.`,threadID);
                return;
            }

            // ── AUTO-RESPOND trigger (groups only, !on/!off enabled)
            if (isGroup && !isSelf && sharedState.autoRespondEnabled[threadID] && !sharedState.mutedThreads[threadID]) {
                sendAutoReply(api, threadID);
            }
        }
    });
}

process.on("uncaughtException", err=>log("error","Uncaught: "+(err.message||err)));
process.on("unhandledRejection", r=>log("error","Rejection: "+(r?.message||r)));
process.on("message", msg=>{ if(msg.type==="sharedState") Object.assign(sharedState,msg.data); });

startBot();
