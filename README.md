<img src="assets/brand/bubblebuddy.png" alt="BubbleBuddy" width="420">

# BubbleBuddy

![Node.js](https://img.shields.io/badge/node-%3E%3D25.9.0-339933?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.33.0-F69220?logo=pnpm&logoColor=white)
![Effect v4](https://img.shields.io/badge/Effect-v4-6B46C1)
![tsgo](https://img.shields.io/badge/typecheck-tsgo-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-personal%20WIP-8A2BE2)

BubbleBuddy is a fun Discord companion that lives in your servers. It gives Discord communities a shared AI buddy that remembers each channel's conversation separately. It is powered by [Pi](https://github.com/earendil-works/pi), built with [Effect](https://effect.website/) v4, and can optionally use agentic coding abilities through a [Gondolin](https://github.com/earendil-works/gondolin) Virtual Machine.

## Features

- Channel-scoped Pi-backed assistant sessions. Use any model or provider supported by Pi.
- Mention-based and ping-reply interaction support.
- [Slash commands](#slash-command-reference) for managing channel sessions.
- [MCP server support](#mcp-server-definitions).
- Sandboxed agentic workspace. When enabled, the assistant can use tools to interact with a Gondolin VM, giving it access to project files and coding capabilities without exposing host credentials or environment variables.

## Setup

### Requirements

- Node.js `>=25.9.0`
- pnpm `>=10.33.0`
- A Discord account
- Access to whichever Pi model provider you configure

### Discord bot setup

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
cp packages/bubblebuddy/.env.example packages/bubblebuddy/.env
```

Edit `packages/bubblebuddy/.env` and set:

```env
DISCORD_TOKEN=your-discord-bot-token
```

## Configuration

### App home directory

Configuration and state, including the database, sessions, and workspaces, is stored under the directory set by the `BUBBLEBUDDY_HOME` environment variable.

If `BUBBLEBUDDY_HOME` is unset, BubbleBuddy uses the platform-standard application data path:

- Linux: `~/.local/share/bubblebuddy`
- macOS: `~/Library/Application Support/BubbleBuddy`
- Windows: `%APPDATA%/BubbleBuddy`

### First-run configuration

The `$BUBBLEBUDDY_HOME/bubblebuddy.json` configuration file will be generated on the first run. Edit the file with your Pi `modelProvider` and `modelId` to get started. Provider authentication comes from your system Pi configuration.

### `bubblebuddy.json` reference

| Key | Description | Default |
| --- | --- | --- |
| `botProfileFile` | Bot profile to load. Use `"default"` for the bundled friendly profile, an absolute path, or a path relative to `BUBBLEBUDDY_HOME`. | `"default"` |
| `modelProvider` | Pi model provider to use. Must be changed. | `"YOUR_PROVIDER"` |
| `modelId` | Pi model ID to use. Must be changed. | `"YOUR_MODEL"` |
| `enableAgenticWorkspace` | Enables the Gondolin-backed workspace and additional agentic capabilities. | `true` |
| `thinkingLevel` | Thinking level passed to Pi. Valid values are `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, and `"xhigh"`. Some models only accept a subset or do not support thinking. | `"minimal"` |
| `channelIdleTimeoutMs` | How long idle channel sessions stay loaded before eviction. | `1800000` (30 minutes) |
| `mcpServers` | MCP server definitions made available to Pi sessions. | `{}` |

### MCP server definitions

`mcpServers` is an object keyed by server name. Each value is either an HTTP/SSE server definition or a local command server definition.

HTTP/SSE server definition:

| Key | Description | Required |
| --- | --- | --- |
| `url` | MCP server URL. | Yes |
| `bearerTokenEnv` | Environment variable containing the bearer token to send when connecting. | No |

Local command server definition:

| Key | Description | Required |
| --- | --- | --- |
| `command` | Command to start the MCP server. | Yes |
| `args` | Arguments passed to `command`. | No |
| `env` | Additional environment variables for the MCP server process. | No |

## Running BubbleBuddy

Start BubbleBuddy in development mode:

```sh
pnpm run dev
```

Or run without watch mode:

```sh
pnpm run start
```

For checks, tests, formatting, linting, and typechecking scripts, see `package.json`.

## Slash command reference

BubbleBuddy registers these slash commands:

- `/new` — discard this channel's current session; the next interaction starts fresh.
- `/compact` — manually compact the current channel session.
- `/status` — show current channel/session status.
- `/thinking` — toggle thinking messages for the channel.

## Project status and safety notes

BubbleBuddy is a personal project and still evolving. The current shape is a Discord companion with channel-scoped Pi sessions and optional agentic workspace support.

Agentic workspace support uses Gondolin and should be enabled only after reviewing the configured tools and workspace behavior. In particular, file upload behavior has not been fully audited yet.
