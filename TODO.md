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

Setup only you can do (docs/mobile.md, "Setup", has each step):

- [ ] Apple Developer Program; the App Store Connect app for `dev.hasparus.optchat` (or yours in `mobile/app.json`); its Apple ID as `ascAppId` in `mobile/eas.json`, committed.
- [ ] An App Store Connect API key (App Manager); keep the `.p8` for the EAS step.
- [ ] An Expo account and access token: the repository secret `EXPO_TOKEN`.
- [ ] `cd mobile && bun install`, then `bun run eas login`, `bun run eas init` (commit `app.json`), `bun run eas credentials -p ios`: build credentials, and the API key for EAS Submit.
- [ ] Run the TestFlight workflow; install from TestFlight.

Then on the phone, which no CI can check:

- [ ] The build compiles and signs on EAS at all (Expo SDK 57, react-native-webview 13.16.1; nothing native was compiled here), and the non-interactive submit finds the key EAS keeps.
- [ ] First launch: the address check passes over Tailscale (`/api/devices` answers 200), and a wrong login gets the 403 message.
- [ ] Keyboard: the composer sits right on top of it, and nothing jumps when it opens or closes. Risk of a double adjustment: KeyboardAvoidingView shrinks the WebView while WKWebView may also inset or scroll its own scroll view for the same keyboard; if the page jumps, drop one (e.g. `scrollEnabled={false}` on the WebView, or no KeyboardAvoidingView). With `hideKeyboardAccessoryView` there is no Done button: check that tapping the chat dismisses the keyboard. Safe areas at the notch and the home indicator.
- [ ] Camera and photo attach from the composer, a video's sound; the permission prompts show their strings, and the page gets the mic and camera with no second WebKit prompt.
- [ ] Back from the background after a few seconds, after a minute and after hours: the link reconnects at once (WKWebView fires `visibilitychange`; past 30 s an "open" socket is replaced), no white page; the failure screen retries by itself.
- [ ] Links in a reply open in the Safari sheet, `mailto:` in Mail; an attachment opens full size.
- [ ] Push notifications, later: APNs from the server for a finished turn (expo-notifications in the app, a `.p8` key on the server).

## Media

- [ ] Caption quality and cost: 50 real photos, Haiku against Sonnet (SPEC Media).
- [ ] Does the double JPEG pass hurt small text in screenshots? Keep PNG for flat images if so (SPEC Media).
