"use strict";

const { fork } = require("child_process");
const fs   = require("fs");
const path = require("path");
const { startDashboard, addLog, state } = require("./dashboard");

const DEVELOPER_ID = "61585831139336";
const DATA_DIR     = path.join(__dirname, "../data");
const WORKER_PATH  = path.join(__dirname, "bot-worker.js");

process.on("uncaughtException",  (err) => { try { addLog("error","Uncaught exception: "+(err.message||err)); } catch(_) {} });
process.on("unhandledRejection", (r)   => { try { addLog("error","Unhandled rejection: "+(r?.message||r)); } catch(_) {} });

state.developerID = DEVELOPER_ID;

// ── Dashboard ───────────────────────────────────────────────────────────────
startDashboard(5000);

// ── Per-bot shared state (synced across workers) ────────────────────────────
const sharedState = {
    autoReplyEnabled: {},
    mutedThreads: {},
    nicknameMap: {},
    antiRestrict: false,
    antiChat: {},
};

function broadcastSharedState(workers) {
    for (const w of workers) {
        try { w.send({ type: "sharedState", data: sharedState }); } catch(_) {}
    }
}

// ── Spawn one worker per fbstate file ──────────────────────────────────────
function startAllBots() {
    let files;
    try {
        files = fs.readdirSync(DATA_DIR)
            .filter(f => /^fbstate.*\.json$/i.test(f))
            .sort();
    } catch (e) {
        addLog("error","Cannot read data/ directory: "+e.message);
        process.exit(1);
    }

    if (files.length === 0) {
        addLog("error","No fbstate*.json files found in data/. Add at least one.");
        process.exit(1);
    }

    addLog("info", `Found ${files.length} bot account(s): ${files.join(", ")}`);

    const workers = [];

    files.forEach((file, i) => {
        const fbstatePath = path.join(DATA_DIR, file);
        const label       = `Bot ${i + 1}`;
        const botState    = { label, loggedIn: false, reconnecting: false, nextReconnectIn: 0, expired: false };
        state.bots.push(botState);

        function spawnWorker() {
            const child = fork(WORKER_PATH, [fbstatePath, label, DEVELOPER_ID], {
                silent: false,
            });

            workers[i] = child;

            child.on("message", (msg) => {
                switch (msg.type) {
                    case "log":
                        addLog(msg.level || "info", msg.message || "");
                        break;

                    case "status":
                        if (msg.loggedIn   !== undefined) botState.loggedIn   = msg.loggedIn;
                        if (msg.reconnecting !== undefined) botState.reconnecting = msg.reconnecting;
                        if (msg.nextReconnectIn !== undefined) botState.nextReconnectIn = msg.nextReconnectIn;
                        if (msg.expired    !== undefined) botState.expired    = msg.expired;
                        break;

                    case "stateUpdate":
                        if (msg.autoReplyEnabled) sharedState.autoReplyEnabled = msg.autoReplyEnabled;
                        if (msg.mutedThreads)     sharedState.mutedThreads     = msg.mutedThreads;
                        // Sync dashboard state
                        state.autoReplyEnabled = sharedState.autoReplyEnabled;
                        state.mutedThreads     = sharedState.mutedThreads;
                        broadcastSharedState(workers);
                        break;

                    case "totalReply":
                        state.totalRepliesSent++;
                        break;
                }
            });

            child.on("exit", (code, signal) => {
                botState.loggedIn = false;
                if (!botState.expired) {
                    addLog("warn", `[${label}] Worker exited (code ${code}), restarting in 10s...`);
                    botState.reconnecting = true;
                    setTimeout(() => {
                        botState.reconnecting = false;
                        spawnWorker();
                    }, 10000);
                } else {
                    addLog("error", `[${label}] Session expired. Provide a fresh fbstate file to restart this bot.`);
                }
            });

            child.on("error", (err) => {
                addLog("error", `[${label}] Worker process error: ${err.message}`);
            });
        }

        // Stagger startup by 4s per bot so FB doesn't see simultaneous logins
        setTimeout(spawnWorker, i * 4000);
    });
}

startAllBots();
