# optchat-du-jour

Our own [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
A fresh view every turn. [SPEC.md](./SPEC.md) is the build spec.

## How it differs

The core is the gist's, matching [shitty-optchat](https://github.com/gebeer/shitty-optchat) byte for
byte on disk: same log, tree, view and `optchat view` output (a parity test checks this in CI).
Around that core:

- **A server, not a REPL.** One server owns the chat. The terminal REPL and a phone-first web
  app (chat, memory browser, usage stats, devices; installable as a PWA) are clients of one
  WebSocket speaking AG-UI events. Several clients can watch the same turn live.
- **Several machines.** The chat lives on one machine; each turn's `claude` runs on whichever
  machine has the files, through a small device runner on the tailnet. Tailscale is the only auth.
- **Several engines.** Turns fail over from Claude Code to the ChatGPT plan to an API key (with a
  monthly budget) without losing a message. The compactor picks its engine per tree level and
  can run on the ChatGPT plan instead of the Claude plan.
- **A proven kernel.** The view fold is written in [Bend 2](https://github.com/bendlang/bend)
  with its laws (tiling, sizes, merge order, what the pump may offer) proved and checked in CI.
- **Faster turns.** Turns never wait for cache priming, a warm `claude` process is ready for the
  next turn, and `zoom`/`date` reach the memory over MCP on a WebSocket.
- **Everything measured.** Every model call lands in `usage.jsonl` (engine, cache reads,
  cold/warm, failovers, dollars) and the web app charts it.

All deviations from the gist and the reference, with reasons, are in SPEC's Deviations table.

## Run

You need Bun, the `claude` CLI logged in on each machine that runs turns, and Tailscale for the
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
