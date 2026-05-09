<img src="resources/bubblebuddy.png" alt="BubbleBuddy" width="420">

# BubbleBuddy

![Node.js](https://img.shields.io/badge/node-%3E%3D25.9.0-339933?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.33.0-F69220?logo=pnpm&logoColor=white)
![Effect v4](https://img.shields.io/badge/Effect-v4-6B46C1)
![tsgo](https://img.shields.io/badge/typecheck-tsgo-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-personal%20WIP-8A2BE2)

BubbleBuddy is a fun Discord companion that lives in your servers. It gives Discord communities a shared AI buddy that remembers each channel's conversation separately. It is powered by [Pi](https://github.com/earendil-works/pi), built with [Effect](https://effect.website/) v4, and can optionally use agentic coding abilities through a [Gondolin](https://github.com/earendil-works/gondolin) Virtual Machine.

## What BubbleBuddy does

BubbleBuddy gives each Discord channel its own Pi-backed assistant session. Mention the bot, or ping-reply to one of its messages, and it continues the conversation for that channel. If the channel needs a clean slate, run `/new` to discard the current session and start fresh on the next interaction.

The bot profile is configurable, with `profiles/friendly.md` included as the default starting point. Model selection lives in `bubblebuddy.json` and uses Pi's built-in model/provider names, with provider authentication coming from your system Pi configuration. Optional MCP servers and Gondolin workspace support can also be configured there.

The runtime is structured as an Effect v4 application, with `discord.js` handling the Discord API integration and a small custom adapter bridging the Pi SDK into Effect.

## Setup

### Requirements

- Node.js `>=25.9.0`
- pnpm `10.33.0`
- A Discord application + bot token
- Access to whichever Pi model provider you configure

### Discord application

Create a Discord application and bot in the Discord Developer Portal.

BubbleBuddy's Discord client uses these gateway intents:

- `Guilds`
- `GuildMessages`
- `MessageContent`

Enable the privileged **Message Content Intent** for the bot, then invite it to your server:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=563089540369472
```

Replace `YOUR_CLIENT_ID` with the application ID from your Discord application. The permissions value includes message/reply basics such as viewing channels, sending messages, reading message history, embeds, attachments, reactions, external emoji/stickers, polls, mentions, and application commands.

BubbleBuddy currently only supports guild text channels.

### Local setup

BubbleBuddy is intended to be run from source for now.

```sh
pnpm install
cp .env.example .env
cp bubblebuddy.json.example bubblebuddy.json
```

Edit `.env` and set:

```env
DISCORD_TOKEN=your-discord-bot-token
```

Edit `bubblebuddy.json` for your Pi model/profile settings. The example file is the best starting point; it shows model selection, the included friendly profile, storage location, thinking level, and optional MCP server configuration. Some example MCP servers work without API keys.

Review `enableAgenticWorkspace` before running. When enabled, BubbleBuddy starts a Gondolin-backed workspace for channel sessions and exposes additional agentic capabilities.

## Running

Start BubbleBuddy in development mode:

```sh
pnpm run dev
```

Or run without watch mode:

```sh
pnpm run start
```

For checks, tests, formatting, linting, and typechecking scripts, see `package.json`.

## Discord commands

BubbleBuddy registers these slash commands:

- `/new` — discard this channel's current session; the next interaction starts fresh.
- `/compact` — manually compact the current channel session.
- `/status` — show current channel/session status.
- `/thinking` — toggle thinking messages for the channel.

## Status

BubbleBuddy is a personal project and still evolving. The current shape is a Discord companion with channel-scoped Pi sessions and optional agentic workspace support.

Agentic workspace support uses Gondolin and should be enabled only after reviewing the configured tools and workspace behavior. In particular, file upload behavior has not been fully audited yet.
