"use strict";

const { login } = require("ws3-fca");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { replies, imageReplies } = require("./replies");

const FBSTATE_PATH = process.argv[2];
const BOT_LABEL    = process.argv[3] || "Bot";
const DEVELOPER_ID = process.argv[4] || "";
const PREFIX = "!";
const MIN_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;
const DEFAULT_BANNER_URL  = "https://file.garden/aahuG_hIDGRlXD24/image.jpg";
const STATE_FILE          = path.join(__dirname, "../data/bot_state.json");
const CUSTOM_REPLIES_FILE = path.join(__dirname, "../data/custom_replies.json");

const COLOR_MAP = {
    blue:"196241301102133",pink:"169463077092846",hotpink:"169463077092846",
    aqua:"2442142322678320",purple:"234137870477637",coral:"980963458735625",
    orange:"175615189761153",green:"2136751179887052",lavender:"2058653964378557",
    red:"2129984390566328",yellow:"174636906462322",teal:"1928399724138152",
    berry:"164535220883264",ocean:"736591620215564",love:"741311439775765",
    rose:"1257453361255152",monochrome:"788274591712841",candy:"205488546921017",
    unicorn:"273728810607574",tropical:"262191918210707",default:"3259963564026002",
};

function send(type, payload = {}) {
    try { process.send({ type, ...payload }); } catch (_) {}
}

function log(level, message) {
    send("log", { level, message: `[${BOT_LABEL}] ${message}` });
}

function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, "utf8");
        const saved = JSON.parse(raw);
        return {
            autoReplyEnabled: saved.autoReplyEnabled || {},
            mutedThreads: saved.mutedThreads || {},
            nicknameMap: saved.nicknameMap || {},
            antiRestrict: saved.antiRestrict || false,
            antiChat: saved.antiChat || {},
        };
    } catch (_) {
        return { autoReplyEnabled: {}, mutedThreads: {}, nicknameMap: {}, antiRestrict: false, antiChat: {} };
    }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            autoReplyEnabled: sharedState.autoReplyEnabled,
            mutedThreads: sharedState.mutedThreads,
            nicknameMap: sharedState.nicknameMap,
            antiRestrict: sharedState.antiRestrict,
            antiChat: sharedState.antiChat,
        }, null, 2));
    } catch (_) {}
}

const sharedState = loadState();

let reconnectDelay = MIN_RECONNECT_DELAY;
let lockedProfilePic = null;
let profilePicTimer  = null;
const tempPerms = {};

function startProfileGuard(api) {
    if (profilePicTimer) clearInterval(profilePicTimer);
    profilePicTimer = setInterval(() => {
        if (!lockedProfilePic || !api) return;
        api.changeAvatar(lockedProfilePic, "", (err) => {
            if (err) log("warn", `!gp restore error: ${err.message || err}`);
            else log("info", "!gp — profile picture restored.");
        });
    }, 5 * 60 * 1000);
}
function stopProfileGuard() {
    if (profilePicTimer) { clearInterval(profilePicTimer); profilePicTimer = null; }
    lockedProfilePic = null;
}

function hasTempPerm(userID) {
    if (!tempPerms[userID]) return false;
    if (Date.now() > tempPerms[userID]) { delete tempPerms[userID]; return false; }
    return true;
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
function isAuthorized(senderID, isSelf) {
    return senderID === DEVELOPER_ID || isSelf || hasTempPerm(senderID);
}
function getCustomReplies() {
    try { return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8")); } catch(_){ return []; }
}
function getRandomReply() {
    const all=[...replies,...getCustomReplies()];
    if(!all.length) return "...";
    return all[Math.floor(Math.random()*all.length)];
}
function getRandomImageUrl() {
    const v = imageReplies.filter(u=>u&&u.startsWith("http"));
    return v.length===0 ? null : v[Math.floor(Math.random()*v.length)];
}
function setGroupBanner(api, imageUrl, threadID, callback) {
    axios.get(imageUrl,{responseType:"stream"})
        .then(r=>api.changeGroupImage(r.data,threadID,err=>{if(callback)callback(err);}))
        .catch(err=>{if(callback)callback(err);});
}

function sendAutoReply(api, threadID, retryCount=0) {
    const imageUrl = getRandomImageUrl();
    const useImage = imageUrl && Math.random() < 0.4;
    const MAX_RETRIES = 2;
    function onSendDone(err, msgInfo) {
        if (err) {
            log("warn", `Send failed in ${threadID}: ${err.message||err}`);
            if (sharedState.antiChat[threadID] && retryCount < MAX_RETRIES) {
                log("info", `Anti-chat: retrying in 30s (attempt ${retryCount+1}/${MAX_RETRIES})`);
                setTimeout(()=>sendAutoReply(api,threadID,retryCount+1),30000);
            }
            return;
        }
        if (msgInfo?.messageID) api.setMessageReaction("😂",msgInfo.messageID,()=>{},true);
    }
    if (useImage) {
        axios.get(imageUrl,{responseType:"stream",timeout:15000})
            .then(r=>api.sendMessage({attachment:r.data},threadID,onSendDone))
            .catch(e=>{
                log("warn",`Image fetch failed: ${e.message}`);
                api.sendMessage(getRandomReply(),threadID,onSendDone);
            });
    } else {
        api.sendMessage(getRandomReply(),threadID,onSendDone);
    }
}

function scheduleReconnect() {
    log("warn", `Reconnecting in ${reconnectDelay/1000}s...`);
    send("status", { loggedIn: false, reconnecting: true, nextReconnectIn: reconnectDelay/1000 });
    setTimeout(()=>{
        send("status",{reconnecting:false});
        startBot();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay*2, MAX_RECONNECT_DELAY);
}

function startBot() {
    let appState;
    try {
        appState = JSON.parse(fs.readFileSync(FBSTATE_PATH,"utf8"));
    } catch(e) {
        log("error","Cannot read fbstate: "+e.message);
        send("status",{loggedIn:false,reconnecting:false,error:"Cannot read fbstate"});
        return;
    }

    login(appState,{bypassRegion:"ash",online:false,selfListen:true,listenEvents:true,autoMarkDelivery:false},(err,api)=>{
        if (err) {
            const msg = err.message || JSON.stringify(err);
            log("error","Login failed: "+msg);
            const isExpired = msg.includes("Error retrieving userID") || msg.includes("Checkpoint");
            if (isExpired && reconnectDelay >= MAX_RECONNECT_DELAY) {
                log("error","Session appears to be expired or invalid. Stopping retries. Please provide a fresh fbstate.");
                send("status",{loggedIn:false,reconnecting:false,expired:true});
                return;
            }
            scheduleReconnect();
            return;
        }

        api.setOptions({
            userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
        });

        reconnectDelay = MIN_RECONNECT_DELAY;
        send("status",{loggedIn:true,reconnecting:false,expired:false,nextReconnectIn:0});
        log("info","Logged in. Listening for messages...");

        const keepaliveTimer = setInterval(()=>{
            try { api.getThreadList(1,null,[],()=>{}); } catch(_) {}
        },55000);

        if (lockedProfilePic) startProfileGuard(api);

        const lockedBanner     = {};
        const settingBanner    = {};
        const lockedGroupName  = {};
        const settingGroupName = {};
        const frozenThreads    = {};

        api.listenMqtt((err,event)=>{
            if (err) {
                clearInterval(keepaliveTimer);
                const code = err.error||(err.res&&err.res.error)||"unknown";
                log("error",`Listener error (code ${code}): session may be expired.`);
                send("status",{loggedIn:false});
                scheduleReconnect();
                return;
            }
            try { handleEvent(api,event,lockedBanner,settingBanner,lockedGroupName,settingGroupName,frozenThreads); }
            catch(e) { log("error",`Event handler crash: ${e.message||e}`); }
        });

        function handleEvent(api,event,lockedBanner,settingBanner,lockedGroupName,settingGroupName,frozenThreads) {
            if (event.type==="presence"||event.type==="typ") return;
            log("info",`Event: ${event.type} ${event.logMessageType||""} ${event.body?'"'+event.body.slice(0,30)+'"':""}`);

            if (event.type==="event"&&event.logMessageType==="log:user-nickname") {
                const tid=event.threadID,uid=event.logMessageData?.participant_id;
                if (sharedState.nicknameMap[tid]&&sharedState.nicknameMap[tid][uid]!==undefined) {
                    const saved=sharedState.nicknameMap[tid][uid],current=event.logMessageData?.nickname||"";
                    if (current!==saved) {
                        log("warn",`Nickname changed in ${tid} — restoring...`);
                        api.changeNickname(saved,tid,uid,()=>log("info",`Nickname restored for ${uid}`));
                    }
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:thread-image") {
                const tid=event.threadID;
                if (lockedBanner[tid]&&!settingBanner[tid]) {
                    log("warn",`Banner changed in ${tid} — restoring...`);
                    settingBanner[tid]=true;
                    setTimeout(()=>setGroupBanner(api,lockedBanner[tid],tid,()=>{settingBanner[tid]=false;log("info",`Banner restored in ${tid}`);}),1500);
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:thread-name") {
                const tid=event.threadID;
                if (lockedGroupName[tid]&&!settingGroupName[tid]) {
                    log("warn",`Group name changed in ${tid} — restoring...`);
                    settingGroupName[tid]=true;
                    setTimeout(()=>api.setTitle(lockedGroupName[tid],tid,()=>{settingGroupName[tid]=false;log("info",`Group name restored in ${tid}`);}),1500);
                }
                return;
            }
            if (event.type==="event"&&event.logMessageType==="log:unsubscribe") {
                const removedUID=event.logMessageData?.leftParticipantFbId,botID=api.getCurrentUserID();
                if (removedUID===botID) {
                    log("warn",`Bot was removed from group ${event.threadID}!`);
                    if (sharedState.antiRestrict) api.sendMessage(`[anti-restrict] I was removed from group ${event.threadID}.`,DEVELOPER_ID,()=>{});
                }
                return;
            }
            if (event.type!=="message") return;

            const {threadID,senderID,body,messageID}=event;
            const isSelf=senderID===api.getCurrentUserID();
            const message=(body||"").trim();

            if (frozenThreads[threadID]&&!isSelf&&senderID!==DEVELOPER_ID&&!hasTempPerm(senderID)) {
                if (!message.startsWith(PREFIX)) {
                    api.removeUserFromGroup(senderID,threadID,err=>{
                        if(!err)log("warn",`Kicked ${senderID} from frozen thread ${threadID}`);
                    });
                    return;
                }
            }
            if (isSelf&&!message.startsWith(PREFIX)) return;

            if (message.startsWith(PREFIX)) {
                const args=message.slice(PREFIX.length).trim().split(/\s+/);
                const cmd=args[0].toLowerCase();

                if (!isAuthorized(senderID,isSelf)) {
                    log("warn",`Command blocked — not authorized. Sender: ${senderID}`);
                    api.sendMessage("❌ You are not authorized to use commands.",threadID);
                    return;
                }

                if (cmd==="on") {
                    sharedState.autoReplyEnabled[threadID]=true;
                    send("stateUpdate",{autoReplyEnabled:sharedState.autoReplyEnabled});
                    saveState();
                    log("info",`Auto-reply ON — ${threadID}`);
                    api.sendMessage("✅ Auto-reply is now ON for this chat.",threadID);return;
                }
                if (cmd==="off") {
                    sharedState.autoReplyEnabled[threadID]=false;
                    send("stateUpdate",{autoReplyEnabled:sharedState.autoReplyEnabled});
                    saveState();
                    log("info",`Auto-reply OFF — ${threadID}`);
                    api.sendMessage("🔴 Auto-reply is now OFF for this chat.",threadID);return;
                }
                if (cmd==="mute") {
                    sharedState.mutedThreads[threadID]=true;
                    send("stateUpdate",{mutedThreads:sharedState.mutedThreads});
                    saveState();
                    log("info",`Auto-reply muted — ${threadID}`);
                    api.sendMessage("🔇 Auto-reply muted. Use !unmute to resume.",threadID);return;
                }
                if (cmd==="unmute") {
                    delete sharedState.mutedThreads[threadID];
                    send("stateUpdate",{mutedThreads:sharedState.mutedThreads});
                    saveState();
                    log("info",`Auto-reply unmuted — ${threadID}`);
                    api.sendMessage("🔔 Auto-reply unmuted!",threadID);return;
                }
                if (cmd==="nn") {
                    const nickname=args.slice(1).join(" ");
                    if(!nickname){api.sendMessage("Usage: !nn <nickname>",threadID);return;}
                    api.getThreadInfo(threadID,(err,info)=>{
                        if(err){api.sendMessage("❌ Could not get thread info.",threadID);return;}
                        const participants=info.participantIDs||[];
                        if(!sharedState.nicknameMap[threadID])sharedState.nicknameMap[threadID]={};
                        const total=participants.length;
                        if(total===0){api.sendMessage("No participants found.",threadID);return;}
                        participants.forEach(uid=>sharedState.nicknameMap[threadID][uid]=nickname);
                        let done=0,failed=0;
                        participants.forEach(uid=>api.changeNickname(nickname,threadID,uid,err=>{
                            if(!err)done++;else failed++;
                            if(done+failed===total){
                                log("info",`Nickname "${nickname}" set for ${done}/${total}`);
                                api.sendMessage(`✅ Nickname "${nickname}" set for ${done}/${total} members.\nProtection ON — I'll restore it if changed.`,threadID);
                            }
                        }));
                    });return;
                }
                if (cmd==="cg") {
                    const groupName=args.slice(1).join(" ");
                    if(!groupName){api.sendMessage("Usage: !cg <group name>",threadID);return;}
                    lockedGroupName[threadID]=groupName;settingGroupName[threadID]=true;
                    api.setTitle(groupName,threadID,err=>{
                        settingGroupName[threadID]=false;
                        if(err){api.sendMessage("❌ Failed to change group name.",threadID);return;}
                        log("info",`Group name → "${groupName}" in ${threadID}`);
                        api.sendMessage(`✅ Group name changed to "${groupName}".\nProtection ON — I'll restore it if anyone changes it.`,threadID);
                    });return;
                }
                if (cmd==="banner") {
                    const bannerUrl=args[1]||DEFAULT_BANNER_URL;
                    api.sendMessage("⏳ Setting group photo, please wait...",threadID);
                    settingBanner[threadID]=true;
                    setGroupBanner(api,bannerUrl,threadID,err=>{
                        settingBanner[threadID]=false;
                        if(err){api.sendMessage("❌ Failed to set group photo. Check the URL.",threadID);return;}
                        lockedBanner[threadID]=bannerUrl;
                        log("info",`Banner set + locked in ${threadID}`);
                        api.sendMessage(`✅ Group photo set!\nProtection ON — I'll restore it if changed.`,threadID);
                    });return;
                }
                if (cmd==="pm") {
                    sharedState.autoReplyEnabled[threadID]=true;
                    send("stateUpdate",{autoReplyEnabled:sharedState.autoReplyEnabled});
                    saveState();
                    log("info",`Auto-reply ON via !pm — thread ${threadID}`);
                    api.sendMessage("✅ Auto-reply is now ON for this conversation.",threadID);return;
                }
                if (cmd==="kick") {
                    const uid=args[1];
                    if(!uid){api.sendMessage("Usage: !kick <UID>",threadID);return;}
                    api.removeUserFromGroup(uid,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed to kick user. Make sure I'm an admin.",threadID);return;}
                        log("info",`Kicked ${uid} from ${threadID}`);
                        api.sendMessage(`✅ User ${uid} has been kicked.`,threadID);
                    });return;
                }
                if (cmd==="add") {
                    const uid=args[1];
                    if(!uid){api.sendMessage("Usage: !add <UID>",threadID);return;}
                    api.addUserToGroup(uid,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed to add user.",threadID);return;}
                        log("info",`Added ${uid} to ${threadID}`);
                        api.sendMessage(`✅ User ${uid} added to the group.`,threadID);
                    });return;
                }
                if (cmd==="emoji") {
                    const emoji=args[1];
                    if(!emoji){api.sendMessage("Usage: !emoji <emoji>  e.g. !emoji 🔥",threadID);return;}
                    api.changeThreadEmoji(emoji,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed to change emoji.",threadID);return;}
                        log("info",`Emoji → ${emoji} in ${threadID}`);
                        api.sendMessage(`✅ Group emoji changed to ${emoji}`,threadID);
                    });return;
                }
                if (cmd==="color") {
                    const colorName=(args[1]||"").toLowerCase();
                    if(!colorName){api.sendMessage(`Usage: !color <name>\nAvailable: ${Object.keys(COLOR_MAP).join(", ")}`,threadID);return;}
                    const colorID=COLOR_MAP[colorName];
                    if(!colorID){api.sendMessage(`❌ Unknown color "${colorName}".\nAvailable: ${Object.keys(COLOR_MAP).join(", ")}`,threadID);return;}
                    api.changeThreadColor(colorID,threadID,err=>{
                        if(err){api.sendMessage("❌ Failed to change color.",threadID);return;}
                        log("info",`Color → ${colorName} in ${threadID}`);
                        api.sendMessage(`✅ Chat color changed to ${colorName}!`,threadID);
                    });return;
                }
                if (cmd==="seen") {
                    api.markAsRead(threadID,true,err=>{
                        if(err){api.sendMessage("❌ Failed to mark as read.",threadID);return;}
                        log("info",`Marked as read — ${threadID}`);
                        api.sendMessage("✅ All messages marked as seen.",threadID);
                    });return;
                }
                if (cmd==="spam") {
                    const count=parseInt(args[1]),text=args.slice(2).join(" ");
                    if(!count||!text||count<1||count>20){api.sendMessage("Usage: !spam <count 1-20> <message>",threadID);return;}
                    let sent=0;
                    const sendNext=()=>{if(sent>=count)return;api.sendMessage(text,threadID,()=>{sent++;setTimeout(sendNext,500);});};
                    log("info",`Spamming "${text}" x${count} in ${threadID}`);sendNext();return;
                }
                if (cmd==="revoke") {
                    if(senderID!==DEVELOPER_ID&&!isSelf){api.sendMessage("❌ Only the developer can revoke permissions.",threadID);return;}
                    const targetUID=args[1];
                    if(targetUID){
                        if(tempPerms[targetUID]){delete tempPerms[targetUID];log("info",`Perms revoked for ${targetUID}`);api.sendMessage(`✅ Permissions revoked for ${targetUID}.`,threadID);}
                        else{api.sendMessage(`ℹ️ ${targetUID} has no active permissions.`,threadID);}
                    } else {
                        const c=Object.keys(tempPerms).length;for(const u in tempPerms)delete tempPerms[u];
                        log("info",`Revoked all temp perms (${c} users)`);api.sendMessage(`✅ Revoked permissions for all ${c} temp user(s).`,threadID);
                    }return;
                }
                if (cmd==="info") {
                    api.getThreadInfo(threadID,(err,info)=>{
                        if(err){api.sendMessage("❌ Could not get thread info.",threadID);return;}
                        const name=info.threadName||"(no name)",count=(info.participantIDs||[]).length;
                        const admins=(info.adminIDs||[]).map(a=>a.id||a).join(", ")||"none";
                        const autoReply=sharedState.autoReplyEnabled[threadID]?"ON ✅":"OFF 🔴";
                        const frozen=frozenThreads[threadID]?"YES ❄️":"NO";
                        api.sendMessage(`╔══ Thread Info ══╗\n📛 Name: ${name}\n👥 Members: ${count}\n👑 Admins: ${admins}\n🤖 Auto-reply: ${autoReply}\n❄️ Frozen: ${frozen}\n🆔 ID: ${threadID}\n╚═════════════════╝`,threadID);
                    });return;
                }
                if (cmd==="lock") {
                    let msg="🔒 Lock status:\n";
                    msg+=sharedState.nicknameMap[threadID]&&Object.keys(sharedState.nicknameMap[threadID]).length>0?"✅ Nickname protection: ON\n":"⚠️ Nickname: not set (use !nn first)\n";
                    msg+=lockedGroupName[threadID]?`✅ Group name protection: ON (${lockedGroupName[threadID]})\n`:"⚠️ Group name: not locked (use !cg first)\n";
                    msg+=lockedBanner[threadID]?"✅ Banner protection: ON\n":"⚠️ Banner: not set (use !banner first)\n";
                    msg+=frozenThreads[threadID]?"✅ Freeze: ON":"ℹ️ Freeze: OFF (use !freeze to enable)";
                    api.sendMessage(msg,threadID);return;
                }
                if (cmd==="freeze") {
                    if(senderID!==DEVELOPER_ID&&!isSelf){api.sendMessage("❌ Only the developer can freeze the group.",threadID);return;}
                    frozenThreads[threadID]=true;log("warn",`Group FROZEN — ${threadID}`);
                    api.sendMessage("❄️ Group is now FROZEN.\nAnyone who sends a message will be kicked.\nUse !unfreeze to lift.",threadID);return;
                }
                if (cmd==="unfreeze") {
                    if(senderID!==DEVELOPER_ID&&!isSelf){api.sendMessage("❌ Only the developer can unfreeze the group.",threadID);return;}
                    delete frozenThreads[threadID];log("info",`Group UNFROZEN — ${threadID}`);
                    api.sendMessage("✅ Group is now UNFROZEN. Members can chat again.",threadID);return;
                }
                if (cmd==="perms") {
                    if(senderID!==DEVELOPER_ID&&!isSelf){api.sendMessage("❌ Only the developer can grant permissions.",threadID);return;}
                    const targetUID=args[1],timeStr=args[2];
                    if(!targetUID||!timeStr){api.sendMessage("Usage: !perms <UID> <time>\nExample: !perms 100012345 5min",threadID);return;}
                    const ms=parseTime(timeStr);
                    if(!ms){api.sendMessage("❌ Invalid time. Use: 30s, 5min, 1h",threadID);return;}
                    tempPerms[targetUID]=Date.now()+ms;const label2=formatTimeLeft(ms);
                    log("info",`Perms granted to ${targetUID} for ${label2}`);
                    api.sendMessage(`✅ Permissions granted to ${targetUID} for ${label2}.`,threadID);
                    setTimeout(()=>{delete tempPerms[targetUID];log("info",`Perms expired for ${targetUID}`);},ms);return;
                }
                if (cmd==="count") {
                    let i=1;const sendCount=()=>{if(i>20)return;api.sendMessage(String(i),threadID,()=>{i++;setTimeout(sendCount,80);});};
                    log("info",`Counting in ${threadID}`);sendCount();return;
                }
                if (cmd==="say") {
                    const text=args.slice(1).join(" ");
                    if(!text){api.sendMessage("Usage: !say <message>",threadID);return;}
                    api.sendMessage(text,threadID);
                    log("info",`!say: "${text}" in ${threadID}`);return;
                }
                if (cmd==="test") { api.sendMessage("online ako bobo ka",threadID);return; }
                if (cmd==="myid") { api.sendMessage(`Your Facebook ID: ${senderID}`,threadID);return; }
                if (cmd==="gp") {
                    const sub=args[1];
                    if(!sub||sub==="off"){stopProfileGuard();api.sendMessage("Guard profile is now OFF.",threadID);log("info","!gp disabled.");return;}
                    if(!sub.startsWith("http")){api.sendMessage("Usage: !gp <image_url>\n!gp off — stop.",threadID);return;}
                    lockedProfilePic=sub;startProfileGuard(api);
                    api.sendMessage("Guard profile is now ON.\nProfile pic will be restored every 5 minutes automatically.",threadID);
                    log("info","!gp enabled — profile pic locked.");return;
                }
                if (cmd==="antirestrict") {
                    sharedState.antiRestrict=!sharedState.antiRestrict;
                    const st=sharedState.antiRestrict?"ON":"OFF";log("info",`Anti-restrict ${st}`);
                    api.sendMessage(`Anti-restrict is now ${st}.\n`+(sharedState.antiRestrict?"I will notify you if I get kicked from any group.":"Kick detection disabled."),threadID);return;
                }
                if (cmd==="antichat") {
                    sharedState.antiChat[threadID]=!sharedState.antiChat[threadID];
                    const st=sharedState.antiChat[threadID]?"ON":"OFF";log("info",`Anti-chat ${st} in ${threadID}`);
                    api.sendMessage(`Anti-chat is now ${st} for this chat.\n`+(sharedState.antiChat[threadID]?"Failed message sends will be retried automatically.":"Retry mode disabled."),threadID);return;
                }
                if (cmd==="id") {
                    const replied=event.messageReply;
                    if(!replied){api.sendMessage("❌ Reply to someone's message first, then type !id",threadID);return;}
                    api.sendMessage(`🆔 ID: ${replied.senderID}`,threadID);
                    log("info",`ID fetched: ${replied.senderID} in ${threadID}`);return;
                }
                if (cmd==="status") {
                    const on=sharedState.autoReplyEnabled[threadID],muted=sharedState.mutedThreads[threadID],frozen=frozenThreads[threadID];
                    api.sendMessage(`📊 Status for this chat:\nAuto-reply: ${on?"ON ✅":"OFF 🔴"}${muted?" (muted 🔇)":""}\nFrozen: ${frozen?"YES ❄️":"NO"}`,threadID);return;
                }
                if (cmd==="help") {
                    const status=sharedState.autoReplyEnabled[threadID]?"ON ✅":"OFF 🔴";
                    api.sendMessage(
                        `╔══ COZY BOT PANEL ══╗\nAuto-reply: ${status}\n\n`+
                        `${PREFIX}on / ${PREFIX}off — toggle auto-reply\n${PREFIX}mute / ${PREFIX}unmute — pause/resume replies\n`+
                        `${PREFIX}nn <name> — set group nickname\n${PREFIX}cg <name> — change group name\n`+
                        `${PREFIX}banner [url] — set group photo\n${PREFIX}kick <uid> — remove a member\n`+
                        `${PREFIX}add <uid> — add a member\n${PREFIX}emoji <emoji> — set group emoji\n`+
                        `${PREFIX}color <name> — change chat color\n${PREFIX}seen — mark all as read\n`+
                        `${PREFIX}spam <n> <text> — send message n times\n${PREFIX}info — show group info\n`+
                        `${PREFIX}lock — check protection status\n${PREFIX}freeze / ${PREFIX}unfreeze — freeze group\n`+
                        `${PREFIX}perms <uid> <time> — give temp perms\n${PREFIX}revoke [uid] — remove temp perms\n`+
                        `${PREFIX}say <text> — make bot say anything\n${PREFIX}count — count 1 to 20 fast\n${PREFIX}id — get ID of person you replied to\n`+
                        `${PREFIX}gp <url> — guard profile picture\n${PREFIX}antirestrict — alert when bot is kicked\n`+
                        `${PREFIX}antichat — retry failed sends\n${PREFIX}test — ping bot\n`+
                        `${PREFIX}status — show current status\n${PREFIX}myid — your Facebook ID\n`+
                        `╚════════════════════╝`,threadID
                    );return;
                }
                api.sendMessage(`❓ Unknown command. Type ${PREFIX}help for the list.`,threadID);return;
            }

            if (!sharedState.autoReplyEnabled[threadID]) return;
            if (sharedState.mutedThreads[threadID]) return;
            send("totalReply");
            log("reply",`Auto-reply sent to thread ${threadID}`);
            sendAutoReply(api,threadID);
        }
    });
}

process.on("uncaughtException",(err)=>log("error","Uncaught exception: "+(err.message||err)));
process.on("unhandledRejection",(r)=>log("error","Unhandled rejection: "+(r?.message||r)));

// Listen for shared state updates from parent
process.on("message",(msg)=>{
    if (msg.type==="sharedState") Object.assign(sharedState,msg.data);
});

startBot();
