# Cozy Bot — Facebook Messenger Auto-Reply Bot

## What it does
- Logs into Facebook Messenger using cookies (fbstate.json)
- Auto-replies with random messages from a configurable pool
- Full command system prefixed with `!` (developer-only for most commands)
- Dot (`.`) trigger toggles the loop in any chat — group OR PM
- Web dashboard at port 5000 for real-time management

## Developer
- **FB ID:** 61585831139336
- **Prefix:** `!`

## Dashboard (Cozy Bot Panel)
- Branded as "Cozy Bot Panel" (not CZB)
- Warm purple color theme
- SVG icons in nav tabs (no emojis)
- Tabs: Dashboard, Loop Queue, Config, Session, Commands

## PM Loop Fix
- Bot-worker now accepts both `"message"` and `"message_reply"` event types
- ws3-fca can route PM messages as either type via MQTT; previous code filtered out `message_reply` events causing silent drops of the dot trigger in PMs

## Commands
### Loop
- `. (dot)` — toggle loop ON/OFF in any chat (group or PM)
- `!stop` — force-stop the loop
- `!status` — show loop + auto-respond status

### Auto-Respond (groups only)
- `!on` / `!off` — enable/disable auto-respond
- `!mute` / `!unmute` — pause/resume auto-respond
- `!broadcast <text>` — send to all active auto-respond threads

### Group Management
- `!nn <name>`, `!cg <name>`, `!banner [url]`
- `!kick <uid>`, `!add <uid>`, `!emoji`, `!color`
- `!freeze` / `!unfreeze`, `!lock`
- `!perms <uid> <time>`, `!revoke [uid]`

### Utilities
- `!say`, `!vm` (TTS), `!spam`, `!seen`, `!count`
- `!info`, `!id`, `!myid`, `!test`, `!help`
- `!gp`, `!antirestrict`, `!antichat`

### Fun / Unexpected
- `!flip` — coin flip
- `!roll [sides]` — dice roll
- `!8ball <q>` — magic 8 ball
- `!pick a | b | c` — random picker
- `!reverse <text>` — reverse text
- `!shout <text>` — ALL CAPS spaced out
- `!mock <text>` — aLtErNaTiNg cAsE
- `!clap <text>` — clap between words
- `!timer <sec>` — countdown ping
- `!repeat <n> <text>` — stack message n times

## Tech Stack
- Node.js (plain JS)
- ws3-fca — Facebook Messenger API (MQTT-based)
- Multi-process: main index.js spawns bot-worker.js per fbstate file
- Plain HTTP dashboard (no frameworks)
- Data: `data/fbstate.json`, `data/custom_replies.json`, `data/image_replies.json`, `data/bot_config.json`

## Files
- `src/index.js` — main process, spawns workers, runs dashboard
- `src/bot-worker.js` — bot logic, event handling, all commands
- `src/dashboard.js` — web dashboard HTML + HTTP server
- `src/replies.js` — built-in reply pool and image URLs
- `data/` — persistent state and config
- `ws3-fca/` — bundled Facebook API library
