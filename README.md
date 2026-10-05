# optchat-du-jour

Our own [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
A fresh view every turn. [SPEC.md](./SPEC.md) is the build spec.

## Features

- **Gist-exact memory.** The log, tree, view and `optchat view` output are byte-for-byte
  compatible with [shitty-optchat](https://github.com/gebeer/shitty-optchat)'s files, checked in CI.
- **One server, many clients.** A terminal REPL and a phone-first web app (chat, memory browser,
  usage stats, devices; installable as a PWA) share one WebSocket speaking AG-UI events, and
  every client sees a turn live.
- **Turns on any machine.** Each turn's `claude` runs where the files are, through a small device
  runner on the tailnet. Tailscale is the only auth.
- **Engine failover.** Claude Code, the ChatGPT plan, then an API key with a monthly budget,
  without losing a message. The compactor's engine is chosen per tree level.
- **A proven kernel.** The view fold is written in [Bend 2](https://github.com/bendlang/bend),
  its laws (tiling, sizes, merge order, what the pump may offer) proved in CI.
- **Fast turns.** No wait for cache priming, a warm `claude` per device, and `zoom`/`date` over
  MCP on a WebSocket.
- **Pictures and short videos.** Attach, paste, drop or shoot them in the web app. The log keeps a
  captioned marker line per attachment; engines that can see get the real images, now and on `zoom`.
- **Usage tracking.** Every model call lands in `usage.jsonl` (engine, cache reads, cold/warm,
  failovers, dollars), charted in the web app.

## Run

You need Bun, ffmpeg (for video), the `claude` CLI logged in on each machine that runs turns, and Tailscale for the
phone and other machines (the server listens on 127.0.0.1 only;
`tailscale serve --bg --https=443 http://127.0.0.1:7700` publishes it). Edit `optchat.config.ts`
first: `devices`, `defaultDevice`, `allowedLogins` (your Tailscale login; an empty list refuses
everything that comes through `tailscale serve`) and `server.publicUrl` if turns run on another
machine. The ChatGPT plan and API keys are optional: `bun cli/optchat.ts login openai`, `bun cli/optchat.ts key anthropic|openai`.

```sh
bun install
bun run build                               # once: the web app into web/dist, which the server serves
bun server/main.ts                          # data in ~/.optchat; the web app at http://127.0.0.1:7700
bun cli/optchat.ts                          # the REPL (OPTCHAT_URL to point elsewhere)
OPTCHAT_DEVICE=macbook bun device/main.ts   # a device runner, named as in optchat.config.ts
```

## Develop

```sh
bun run build   # typecheck, and the web UI into web/dist
bun run lint    # oxlint, @hasparus/oxlint-config
bun run test    # also the web UI's tests (web/, happy-dom); no real model is ever called
bun run parity  # REF=<shitty-optchat checkout>: byte-for-byte against the reference
bun run proofs  # the kernel's laws (needs bend: sh kernel/install-bend.sh, then ~/.bend/bin on PATH)
cd web && bun run e2e   # Playwright: the real server, a fake claude, Chromium at 360 px
cd web && bun run dev   # Vite, proxying /ws and /api to a server on 127.0.0.1:7700
bun dev/latency.ts --fake   # turn latency over /ws (or --url ws://127.0.0.1:7700/ws)
```
