# cozy-bot — Facebook Messenger Auto-Reply Bot

## What it does
- Logs into Facebook Messenger using cookies (fbstate.json)
- Auto-replies to any incoming message with a random message from a list of 40
- Has command support (prefix `!`) — only the developer (cozy) can use commands
- Protects nicknames set by `!nn` — restores them if anyone changes them

## Developer
- **Name:** cozy
- **FB ID:** 61585831139336
- **Prefix:** `!`

## Commands (developer only)
- `!nn <nickname>` — sets that nickname for everyone in the group, and protects it
- `!help` — lists all commands

## Editing your 40 auto-reply messages
Edit `src/replies.js` — replace each `"word1"` ... `"word40"` with your own messages.

## Adding your Facebook session
Put your `data/fbstate.json` (c3c cookie format) in the `data/` folder.

## Tech stack
- Node.js (plain JS, no TypeScript)
- `@xaviabot/fca-unofficial` — Facebook Messenger API
- `nodemon` for auto-restart in dev

## Running
```sh
yarn start:dev   # development (auto-restart on file change)
yarn start       # production
```
