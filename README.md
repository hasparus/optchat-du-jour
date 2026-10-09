# optchat-du-jour

an implementation of [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449):
one endless chat whose history is its memory, kept as a binary summary tree.
[docs/optchat.md](./docs/optchat.md) is that spec, verbatim; [SPEC.md](./SPEC.md) is our build spec on top of it.

## Features

- A terminal REPL and a phone-first web app (chat, memory browser, usage stats, devices;
  installable as a PWA, or as an iOS app through TestFlight), both clients of one server over a
  WebSocket speaking AG-UI.
- Turns run where the files are: the server hands each `claude` call to a small runner on its
  machine. Your Tailscale login is the only identity.
- You pick the model per message (Claude Code, the ChatGPT plan; an API key with a monthly
  budget is optional). When it hits a limit, the message waits until you pick another. The
  compactor has its own chain per tree level and fails over by itself.
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

## On your phone

The phone reaches the server over Tailscale, at the https address `tailscale serve` publishes
(`https://<machine>.<tailnet>.ts.net`), which must be the server's `server.publicUrl`. Tailscale
must be connected on the phone, and your login in `allowedLogins`.

- **As a PWA**, nothing to build: open that address in Safari, then Share → Add to Home Screen.
- **As an iOS app** (`mobile/`, installed through TestFlight): the same web UI, served by your
  server and shown in the app's WebView, plus a keyboard that resizes the page instead of covering
  it, no Safari bars, and a native place for push notifications later. The app bundles no UI, so
  updating the server updates the app; rebuild only when `mobile/` changes, or every 90 days, when
  a TestFlight build expires. The first launch asks for the server's address; the server icon in
  the header changes it.

The app is built and signed by EAS Build on Expo's Macs and uploaded by EAS Submit, from a GitHub
workflow that runs on Linux: no Mac or Xcode needed. Once (each step in
[docs/mobile.md](./docs/mobile.md#setup), which also says why it's built this way):

1. Apple Developer Program; an App Store Connect app for the bundle id `dev.hasparus.optchat`; its
   Apple ID as `ascAppId` in `mobile/eas.json`.
2. An App Store Connect API key (App Manager); its `.p8` stays on your machine for step 4.
3. An Expo account and a robot user's access token: the repository secret `EXPO_TOKEN`, the only
   one. It can fetch the API key from EAS, so keep it scoped (docs/mobile.md, step 4).
4. `cd mobile && bun install && bun run eas login && bun run eas init --account <organization>`
   (commit `app.json`), then `bun run eas credentials -p ios`: the distribution certificate and
   profile, and the API key for EAS Submit.
5. Actions → TestFlight → Run workflow (or push a tag `ios-v…`); install from TestFlight.

## Develop

```sh
bun run build   # typecheck, and the web UI into web/dist
bun run lint    # oxlint, @hasparus/oxlint-config
bun run lint:effect   # Effect-aware diagnostics (@effect/language-service), server and web
bun run test    # also the web UI's tests (web/, happy-dom); no real model is ever called
bun run parity  # REF=<shitty-optchat checkout>: byte-for-byte against the reference
bun run proofs  # the kernel's laws (needs bend: sh kernel/install-bend.sh, then ~/.bend/bin on PATH)
cd web && bun run e2e   # Playwright: the real server, a fake claude, Chromium at 360 px
cd web && bun run dev   # Vite, proxying /ws and /api to a server on 127.0.0.1:7700
cd mobile && bun install && bun run check   # the iOS app, as far as Linux can check it
bun dev/latency.ts --fake   # turn latency over /ws (or --url ws://127.0.0.1:7700/ws)
```
