# optchat-du-jour

an implementation of [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
[SPEC.md](./SPEC.md) is the build spec.

## Features

- A terminal REPL and a phone-first web app (chat, memory browser, usage stats, devices;
  installable as a PWA), both clients of one server over a WebSocket speaking AG-UI.
- Turns run where the files are: the server hands each `claude` call to a small runner on its
  machine. Your Tailscale login is the only identity.
- You pick the model per message (Claude Code, the ChatGPT plan, an API key with a monthly
  budget). When it hits a limit, the message waits until you pick another. The compactor has its
  own chain per tree level and fails over by itself.
- A message sent while a turn runs joins it or waits for the next turn (a setting, and a button
  for the other way); one still waiting can be taken back. Drafts survive a reload.
- The view fold is a [Bend 2](https://github.com/bendlang/bend) kernel, with proofs of its tiling,
  sizes, fit's merges and the pump's offers.
- A turn never waits for cache priming. On the server's machine an idle `claude` is already
  started, so the turn skips its boot. `zoom` and `date` go over MCP on a WebSocket.
- Pictures and short videos from the web app. The log keeps one captioned marker line per
  attachment; models that take images get the images, in the turn and from `zoom`.
- `usage.jsonl` records every model call (engine, cache reads, cold/warm, failovers, dollars), and
  the web app charts it.

## Run

You need Bun, ffmpeg (for video), the `claude` CLI logged in on each machine that runs turns,
and Tailscale. The server listens on 127.0.0.1; `tailscale serve --bg --https=443 http://127.0.0.1:7700`
publishes it. First edit `optchat.config.ts`: `devices`, `defaultDevice`, `allowedLogins` (your
Tailscale login; an empty list refuses everyone) and, if turns run on another machine,
`server.publicUrl`.

```sh
bun install
bun link                  # puts `optchat` on PATH (~/.bun/bin), pointing at this checkout
bun run build             # once: the web app into web/dist, which the server serves
optchat server            # data in ~/.optchat; the web app at http://127.0.0.1:7700
optchat                   # the REPL (OPTCHAT_URL to point elsewhere)
optchat device macbook    # a device runner, named as in optchat.config.ts
```

The other engines are optional: `optchat login openai` for the ChatGPT plan,
`optchat key anthropic|openai` for API keys. Pick the model for your messages in the web app's
composer or with `/model` in the REPL (`/resume` after a limit); `/steer` and `/queue` set what a
message sent mid-run does.

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
