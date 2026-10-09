# TODO: checks that need real accounts

Everything is built and tested against fakes. Each check below needs a real login, key, machine or money. Details and the reasoning are in SPEC.md ("Open questions and things to measure" and the Milestones notes).

## Claude Code (Max plan)

- [ ] Re-run ref §14 P1–P8 on our Claude Code version (SPEC M1).
- [ ] 1-hour marks on real turns and priming: no ordering errors, cold turns cut (SPEC E6, M1).
- [ ] A view primed on the Mini, read by a turn on the MacBook: same cache key? (SPEC M1)
- [ ] Does a priming request killed at `message_start` count against limits? (SPEC M1, ref §14 F6)
- [ ] How a real Claude Code reports a spent plan mid-turn; we match `usage limit` in the result text (SPEC M5).
- [ ] The `claudeEfforts` table (`src/config.ts`) against `claude --model <id> --effort <level>` on the installed CLI: which models take which efforts (SPEC Haiku and effort).
- [ ] A `zoom` image seen by the model in the same turn, at image cost (SPEC Media).
- [ ] Does `claude -p` take PDF `document` blocks in a stream-json user message? (SPEC Media)
- [ ] Is Max 5× enough? Decide after two weeks of `usage.jsonl` (SPEC M2).

## ChatGPT plan

- [ ] `optchat login openai` end to end: callback, refresh, Keychain (SPEC M3).
- [ ] Model ids the token lists; are `gpt-6-luna` and `gpt-6.1-sol` right? Does the route take `reasoning.effort`? (SPEC M3)
- [ ] Which `reasoning.effort` values the plan route accepts: `xhigh`, `max`? A chain entry may ask for any of `low` to `max`, and OpenAI refs are not checked at load (SPEC Compactor calls, Haiku and effort).
- [ ] Function tools and `tool_choice` on the plan route (SPEC M5).
- [ ] Our Responses cache fields (from the gist's earlier revision; docs/optchat.md has none): `prompt_cache_breakpoint`, `reasoning.encrypted_content`, `reasoning.context` (SPEC M5).
- [ ] `input_image` and PDFs on the plan route, before `media.planImages` goes on (SPEC Media).
- [ ] Does prefix caching count against limits at a discount, and stay warm across bursts? (SPEC M3)
- [ ] Does the compactor fit the ChatGPT Pro weekly limit alongside Codex work? (SPEC Usage and cost tracking)
- [ ] One real compactor call on the plan route, with `instructions` seen on the wire (SPEC M3)
- [ ] Luna's level-0 quality: retries per node, how much of the user's wording survives (SPEC M3)
- [ ] The bake-off: `dev/bakeoff.ts` over ~500 real messages for Luna, Sol, Haiku at xhigh, Sonnet and a split; set the level cutoff (SPEC M3).

## API keys

- [ ] Real model ids and prices, replacing the placeholders in `optchat.config.ts` (SPEC M5).
- [ ] Budget against the real bill (SPEC M5).
- [ ] Anthropic turns: each request reads everything the one before sent, also after a mid-run message (SPEC M5).

## Machines and network

- [ ] The phone over Tailscale as a PWA: install, reconnect, chat (SPEC M2). The iOS app has its own list below.
- [ ] A live two-machine run over a real tailnet: one chat edits files on both machines (SPEC M4).
- [ ] Re-measure latency with real claude after the inline system prompt change, `dev/latency.ts` (SPEC Turn and priming).

## iPhone app (TestFlight)

Setup only you can do (README "On your phone" has each step):

- [ ] Apple Developer Program; the bundle id (`dev.hasparus.optchat`, or yours in `mobile/app.json`) and the App Store Connect app record.
- [ ] An App Store Connect API key (App Manager): secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`; variables `ASC_APP_ID`, `APPLE_TEAM_ID` (and `APPLE_TEAM_TYPE` for a company team).
- [ ] An Expo account and access token: secret `EXPO_TOKEN`.
- [ ] `cd mobile && bunx eas init`, commit `app.json`; `bunx eas credentials -p ios` for the distribution certificate and profile.
- [ ] Run the TestFlight workflow; install from TestFlight.

Then on the phone, which no CI can check:

- [ ] The build compiles and signs on EAS at all (Expo SDK 57, react-native-webview 13.16.1; nothing native was compiled here).
- [ ] First launch: the address check passes over Tailscale (`/api/devices` answers 200), and a wrong login gets the 403 message.
- [ ] Keyboard: the composer sits right on top of it, nothing jumps when it closes; safe areas at the notch and the home indicator.
- [ ] Camera and photo attach from the composer, a video's sound; the permission prompts show their strings.
- [ ] Back from the background after minutes and after hours: the link reconnects at once (`optchat:wake`), no white page.
- [ ] Links in a reply open in the Safari sheet; an attachment opens full size.
- [ ] Push notifications, later: APNs from the server for a finished turn (expo-notifications in the app, a `.p8` key on the server).

## Media

- [ ] Caption quality and cost: 50 real photos, Haiku against Sonnet (SPEC Media).
- [ ] Does the double JPEG pass hurt small text in screenshots? Keep PNG for flat images if so (SPEC Media).
