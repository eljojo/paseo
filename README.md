<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

<p align="center">One interface for all your coding agents.</p>

<p align="center">
  <img src="https://paseo.sh/paseo-mockup.png" alt="Paseo app screenshot" width="100%">
</p>

---

Run agents in parallel on your own machines. Ship from your phone or your desk.

- **Self-hosted** — Agents run on your machine with your full dev environment. Use your tools, your configs, and your skills.
- **Multi-provider** — Claude Code, Codex, and OpenCode through the same interface. Pick the right model for each job.
- **Voice control** — Dictate tasks or talk through problems in voice mode. Hands-free when you need it.
- **Cross-device** — iOS, Android, desktop, web, and CLI. Start work at your desk, check in from your phone, script it from the terminal.

## Getting Started

Download the desktop app from [paseo.sh](https://paseo.sh) or the [GitHub releases page](https://github.com/getpaseo/paseo/releases) — it bundles the daemon so there's nothing else to install.

### Headless / server mode

To run the daemon on a remote or headless machine:

```bash
npm install -g @getpaseo/cli
paseo
```

Then connect from the desktop app, mobile app, or CLI.

For full setup and configuration, see:
- [Docs](https://paseo.sh/docs)
- [Configuration reference](https://paseo.sh/docs/configuration)

## Development

Quick monorepo package map:
- `packages/server`: Paseo daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Tauri desktop app
- `packages/relay`: Relay package for remote connectivity
- `packages/website`: Marketing site and documentation (`paseo.sh`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:website

# repo-wide checks
npm run typecheck
```

## License

MIT
