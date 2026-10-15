# optchat-du-jour

An implementation of [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
[docs/optchat.md](./docs/optchat.md) is that spec; [SPEC.md](./SPEC.md) is our build spec on top of it.

## Features

- A terminal REPL and a phone-first web app (chat, memory, usage stats, devices), installable as a
  PWA or as an iOS app.
- Turns run where the files are: each device runs its own `claude`. Your Tailscale login is the
  only identity.
- You pick the model per message: Claude Code, the ChatGPT plan, or an optional API key. When one
  hits a limit, the message waits until you pick another.
- A message sent mid-turn joins the turn or waits for the next one. Drafts survive a reload.
- Photos and short videos, captioned into the log.
- Every model call is recorded in `usage.jsonl` and charted in the web app.

## Run

You need Bun, ffmpeg (for video), the `claude` CLI logged in on each machine that runs turns, and
Tailscale. Edit `optchat.config.ts` first: `devices`, `defaultDevice`, `allowedLogins` (your
Tailscale login; an empty list refuses everyone) and `server.publicUrl`, the
`https://<machine>.<tailnet>.ts.net` address `tailscale serve` gives you.

```sh
bun install
bun link                  # puts `optchat` on PATH
bun run build             # the web app, which the server serves
optchat server            # data in ~/.optchat, web app at http://127.0.0.1:7700
optchat                   # the REPL
optchat device macbook    # a device runner, named as in optchat.config.ts
tailscale serve --bg --https=443 http://127.0.0.1:7700
```

Optional engines: `optchat login openai` for the ChatGPT plan, `optchat key anthropic|openai` for
API keys.

## On your phone

Connect Tailscale on the phone, open `https://<machine>.<tailnet>.ts.net` in Safari, then Share →
Add to Home Screen. For the iOS app through TestFlight, see [docs/mobile.md](./docs/mobile.md).

## Develop

```sh
bun run build         # typecheck, and the web app into web/dist
bun run lint          # oxlint
bun run lint:effect   # Effect diagnostics
bun run lint:design   # Impeccable's design detector over web/
bun run test          # never calls a real model
bun run parity        # REF=<shitty-optchat checkout>
bun run proofs        # the Bend kernel's laws (needs bend: sh kernel/install-bend.sh)
cd web && bun run e2e # Playwright against the real server and a fake claude
cd web && bun run dev    # /stories.html: UI with no data yet (the Subagent pattern), dev only
cd mobile && bun install && bun run check
```

The Impeccable skill is vendored in `.claude/skills/impeccable`; its `PROVENANCE.md` says what it
does at run time and how to update it.
