# MC.DISCORD

ShineMC Discord bot with a Minecraft chat bridge, server status board, kill leaderboard, and PvP tier list.

## Setup

Install dependencies and provide these environment variables before starting the bot:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DATABASE_URL` | Yes | PostgreSQL connection URL |
| `STATUS_CHANNEL_ID` | Yes | Channel for the live status board |
| `CHAT_CHANNEL_ID` | Yes | Channel bridged to Minecraft chat |
| `JAVA_IP` | No | Java server address (defaults to `beast.roviotech.bond`) |
| `JAVA_PORT` | No | Java server port (defaults to `19138`) |
| `PE_IP` | No | Bedrock server address (defaults to `JAVA_IP`) |
| `PE_PORT` | No | Bedrock server port (defaults to `19138`) |
| `BOT_USERNAME` | No | Minecraft bot username (defaults to `ShineMC_Bot`) |

```sh
npm install
npm start
```

Enable the **Message Content Intent** for the Discord application. The bot needs permission to read and send messages, embed links, and add reactions in the configured channels. Administrator-only commands are `!setkills`, `!removekills`, `!settier`, and `!removetier`; `!board` and `!status` are available to everyone.