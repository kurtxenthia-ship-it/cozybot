"use strict";

const { fork } = require("child_process");
const fs   = require("fs");
const path = require("path");
const { startDashboard, addLog, state } = require("./dashboard");

const DEVELOPER_ID = "61585831139336";
const EXTRA_ADMINS = ["61580437366762", "61586419022838"];
const DATA_DIR     = path.join(__dirname, "../data");
const WORKER_PATH  = path.join(__dirname, "bot-worker.js");

process.on("uncaughtException",  err => { try { addLog("error","Uncaught: "+(err.message||err)); } catch(_){} });
process.on("unhandledRejection", r   => { try { addLog("error","Rejection: "+(r?.message||r)); } catch(_){} });

state.developerID = DEVELOPER_ID;

startDashboard(process.env.PORT || 5000);

const sharedState = {
    loopEnabled:        {},
    autoRespondEnabled: {},
    mutedThreads:       {},
    nicknameMap:        {},
    antiRestrict:       false,
    antiChat:           {},
};

function broadcastSharedState(workers) {
    for (const w of workers) {
        try { w.send({ type:"sharedState", data:sharedState }); } catch(_){}
    }
}

function startAllBots() {
    let files;
    try {
        files = fs.readdirSync(DATA_DIR)
            .filter(f => /^fbstate.*\.json$/i.test(f))
            .sort();
    } catch(e) {
        addLog("error","Cannot read data/ directory: "+e.message);
        process.exit(1);
    }
    if (!files.length) {
        addLog("error","No fbstate*.json files found in data/.");
        process.exit(1);
    }
    addLog("info",`Found ${files.length} bot account(s): ${files.join(", ")}`);

    const workers = [];

    files.forEach((file, i) => {
        const fbstatePath = path.join(DATA_DIR, file);
        const label       = `Bot ${i+1}`;
        const botState    = { label, loggedIn:false, reconnecting:false, nextReconnectIn:0, expired:false };
        state.bots.push(botState);

        function spawnWorker() {
            const child = fork(WORKER_PATH, [fbstatePath, label, DEVELOPER_ID, ...EXTRA_ADMINS], { silent:false });
            workers[i] = child;

            child.on("message", msg => {
                switch (msg.type) {
                    case "log":
                        addLog(msg.level||"info", msg.message||"");
                        break;
                    case "status":
                        if (msg.loggedIn        !== undefined) botState.loggedIn        = msg.loggedIn;
                        if (msg.reconnecting    !== undefined) botState.reconnecting    = msg.reconnecting;
                        if (msg.nextReconnectIn !== undefined) botState.nextReconnectIn = msg.nextReconnectIn;
                        if (msg.expired         !== undefined) botState.expired         = msg.expired;
                        break;
                    case "stateUpdate":
                        if (msg.loopEnabled)        sharedState.loopEnabled        = msg.loopEnabled;
                        if (msg.autoRespondEnabled) sharedState.autoRespondEnabled = msg.autoRespondEnabled;
                        if (msg.mutedThreads)       sharedState.mutedThreads       = msg.mutedThreads;
                        // sync dashboard
                        state.loopEnabled        = sharedState.loopEnabled;
                        state.autoRespondEnabled = sharedState.autoRespondEnabled;
                        state.mutedThreads       = sharedState.mutedThreads;
                        broadcastSharedState(workers);
                        break;
                    case "totalReply":
                        state.totalRepliesSent++;
                        break;
                }
            });

            child.on("exit", (code) => {
                botState.loggedIn = false;
                if (!botState.expired) {
                    addLog("warn",`[${label}] Worker exited (code ${code}), restarting in 10s...`);
                    botState.reconnecting = true;
                    setTimeout(()=>{ botState.reconnecting=false; spawnWorker(); }, 10000);
                } else {
                    addLog("error",`[${label}] Session expired. Update the cookie from the dashboard.`);
                }
            });

            child.on("error", err => addLog("error",`[${label}] Worker error: ${err.message}`));
        }

        setTimeout(spawnWorker, i * 4000);
    });
}

startAllBots();
