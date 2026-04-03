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
- Dark navy/blue pro design (#060c17 background, electric blue + cyan accents)
- SVG icons throughout — nav tabs, stat cards, hero, section headers
- Tabs: Dashboard, Loop Queue, Threads, Custom Cmds, Config, Cookie, Commands
- Cookie tab: beautiful "Enter Your Cookie" intro page with 4-step guide card, gradient button
- Stat cards: colored glow effects (blue, cyan, purple, emerald), SVG icons
- Hero section has gradient top border and animated glow

## New Features (v2.2)
- **Cookie Reset**: Changing cookie resets all logs/stats/loop state and restarts workers
- **Login Process Screen**: Animated "LOGGING IN..." → "SUCCESSFULLY LOGGED AS [NAME]" flow
- **PM Loop Fix**: Uses `pmThreads` map to track PM vs group, passes explicit `isGroup` flag to FCA's sendMessage (5th arg)
- **Bot Name in Status**: Bot sends `botName` via IPC on login; shown in dashboard header
- **Message Rate Graph**: Dashboard shows 24-hour hourly message volume bar chart
- **Thread Manager** (Threads tab): Table of all known threads with loop status, quick start/stop loop buttons, per-thread config (delay, react emoji), "Stop All Loops" global action
- **Custom Command Builder** (Custom Cmds tab): Add/remove `!cmd` → reply mappings via dashboard UI; enforced in bot-worker with `{name}` placeholder support
- **Multi-Cookie Manager** (Cookie tab): Manage fbstate.json, fbstate2.json, fbstate3.json as separate slots; each shows bot status
- **Whitelist Mode** (Threads tab): Enable/disable whitelist; add/remove UIDs; enforced in message handler
- **Notification Feed** (Dashboard tab): Shows recent alert events (cookie expired, crashes, etc.)
- **Per-Thread Config**: Override `loopDelay` and `loopReact` per thread ID from dashboard

## Data Files
- `data/custom_commands.json` — array of `{cmd, reply}` custom command pairs
- `data/whitelist.json` — `{enabled: bool, uids: []}` whitelist config
- `data/thread_config.json` — per-thread overrides `{[threadID]: {loopDelay, loopReact}}`
- `data/bot_config.json` — global bot settings
- `data/fbstate.json` — primary bot cookie (slot 1)
- `data/fbstate2.json` — secondary bot cookie (slot 2, optional)
- `data/fbstate3.json` — tertiary bot cookie (slot 3, optional)

## API Endpoints (Dashboard)
- `POST /api/cmds/add` — add custom command
- `POST /api/cmds/remove` — remove custom command by index
- `POST /api/whitelist/toggle` — toggle whitelist on/off
- `POST /api/whitelist/add` — add UID to whitelist
- `POST /api/whitelist/remove` — remove UID from whitelist
- `POST /api/thread/config` — save per-thread loopDelay/loopReact
- `POST /api/thread/startloop` — remote-start loop for a thread
- `POST /api/thread/stoploop` — remote-stop loop for a thread
- `POST /api/thread/stopall` — stop all active loops
- `POST /api/cookie/slot` — save cookie to any fbstate slot
- `GET /api/hourly-stats` — hourly message count array (24 values)
- `GET /api/alerts` — notification feed events

## Lock Banner Fix
- `setGroupBanner` now downloads image as `arraybuffer` then creates a fresh `Readable` stream (fixes stream-already-consumed bug)
- `settingBanner[tid]` flag now stays `true` for 3 seconds AFTER `changeGroupImage` callback to prevent race condition where the bot's own image change event triggers infinite restore loop

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
