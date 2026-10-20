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
- [ ] Does `claude -p` send thinking text (deltas, the block, or neither) on our models? One real turn, then `chat/reasoning/` (SPEC Reasoning).
- [ ] api-key Anthropic keeps no thinking text on Opus 4.7+/5.x/Haiku 5.5, whose default `thinking.display` is `"omitted"`: decide whether to send `display: "summarized"` (no bill change, but part of the cached prefix), then check one real turn (SPEC Reasoning).

## Subagents (M7a)

- [ ] A real master calls `spawn` only when the user asks for a subagent ("Use subagents only when the user asks for them", prompts/system.txt), writes a task a fresh call can do alone, and never waits or polls for the report (SPEC M7a).
- [ ] A subagent's `claude -p` (`--permission-mode default`, `--allowedTools Read,Glob,Grep,mcp__optchat__zoom,mcp__optchat__date`, `--setting-sources ""`): Edit, Write, WebFetch, WebSearch and `mcp__optchat__spawn` are refused as a tool result, never asked about; Read, Glob, Grep, zoom and date run; TodoWrite runs too (no permission, no file). Try a plain `ls` and a `touch`: recent Claude Code runs Bash commands its classifier takes as read-only without asking, in default mode. If `ls` runs, the wording (the subagent intro in `src/subagents.ts`, SPEC "Subagents") already allows it; to refuse every command instead, a `--settings` deny of `Bash(*)` keeps Bash in `--tools` (the cached prefix byte-identical), where a whole-tool deny may drop it from the request. The fake claude plays the refusals; the real one has not been run (SPEC M7a).
- [ ] Does `--permission-mode default` with `--allowedTools` leave claude's request prefix (tools, system prompt) as a turn's, so a subagent on the turn's model reads the turn's cached view? The open M3 question about the compactor's `default`, measured on a subagent's first call's `cacheRead` (SPEC M7a, E26).
- [ ] Two Opus subagents and a turn at once against the Max 5× limits: watch `usage.jsonl`'s `role: "subagent"` records for a week before raising `SUBAGENTS_AT_ONCE` (SPEC M7a).
- [ ] A subagent on `openai-plan` (the master's chain's Sol): its tool loop's spawn and tell refused, Read through the device runner, its report back (SPEC M7a).

## Artifacts (M8)

- [ ] A real master makes an artifact only when a visual or interactive result helps or the user asks (prompts/system.txt "Artifacts"), passes the validator first time most of the time (a refusal costs a round), edits rather than republishes, puts a request's changes in one `edit_artifact`, and never pastes a page into the chat (SPEC "Artifacts").
- [ ] Claude Code streams an MCP tool call's input as `input_json_delta` under `--include-partial-messages` (the live draft on claude-code needs it; the fake claude does it), and keeps the schema's order (`name` first) when it writes the input.
- [ ] The Responses API on the ChatGPT plan streams `response.function_call_arguments.delta` after `response.output_item.added` (the draft on openai-plan); Anthropic's `partial_json` on api-key.
- [ ] The tool list changed (three tools): the first request on each engine after the deploy rewrites the tools-and-system-prompt cache once; check `cold` in `usage.jsonl` settles after that (SPEC E32).
- [ ] `read_artifact` of a 512 KB page: Claude Code's MCP output limit against `READ_PAGE` (28,000 characters a part), and the model paging with `from`.
- [ ] iOS app (WKWebView): the wrapper and its `sandbox="allow-scripts"` frame load (both are the server's pages, which `loadsInApp` lets in; no `data:` frame), the page runs its scripts, the heartbeat keeps it, a link in a page opens through `window.open` (in the Safari sheet, as the app's other links do, or not at all), WebKit ignores `credentialless` without breaking the frame, and the draft frame (same-origin, no scripts) is patched. Copy through `ClipboardItem` with a promise; download is hidden in the app.
- [ ] The pane's sheet on the phone: full height on vaul, a drag down closes it, the frame scrolls inside it without dragging the sheet, and the keyboard never opens over it.
- [ ] A long page's live draft on the phone: patching up to 512 KB every 150 ms stays smooth.
- [ ] The frame guard on WebKit (Safari, the iOS app's WKWebView): a `srcdoc` frame a page makes is removed before it runs, as on Chromium (the e2e probe with a UDP listener runs on Chromium only), so its WebRTC never sends STUN. Known residual until then.
- [ ] Resource hints an artifact's script adds (`<link rel=dns-prefetch>`, `preconnect`): no CSP governs them, so a host name the page writes into one may be looked up or connected to. Every artifact route says `X-DNS-Prefetch-Control: off`, and the e2e probe sees no TCP connection or request, but its Chromium acts on no hint even on a plain page (checked against a net log), so nothing is measured. Measure on a Chrome that does (headed, or with the predictor on) and, if they leave, drop `link` elements the page adds at insertion, as the frame guard does frames. Known residual until then.
- [ ] `Sec-Fetch-Dest: iframe` on the artifact page and draft loads in WKWebView (Safari sends Fetch Metadata from 16.4; an older one would get 404s and show no artifact).

## ChatGPT plan

- [x] `optchat login openai` end to end: callback, refresh, Keychain (SPEC M3).
- [x] Model ids the token lists: real compactions returned `gpt-6-luna` and `gpt-6.1-sol` (SPEC M3).
- [ ] Which `reasoning.effort` values the plan route accepts: `xhigh`, `max`? A chain entry may ask for any of `low` to `max`, and OpenAI refs are not checked at load (SPEC Compactor calls, Haiku and effort).
- [x] Function tools and `tool_choice` on the plan route (SPEC M5).
- [ ] Our Responses cache fields (from the gist's earlier revision; docs/optchat.md has none): `prompt_cache_breakpoint`, `reasoning.encrypted_content`, `reasoning.context` (SPEC M5).
- [ ] `input_image` and PDFs on the plan route, before `media.planImages` goes on (SPEC Media).
- [ ] `reasoning.summary: "auto"` on the plan route: accepted, and summaries streamed? Until then plan turns keep no reasoning text (SPEC Reasoning).
- [ ] Does prefix caching count against limits at a discount, and stay warm across bursts? (SPEC M3)
- [ ] Does the compactor fit the ChatGPT Pro weekly limit alongside Codex work? (SPEC Usage and cost tracking)
- [x] One real compactor call on the plan route, with `instructions` seen on the wire (SPEC M3)
- [ ] Luna's level-0 quality: retries per node, how much of the user's wording survives (SPEC M3)
- [x] Before another real bake-off, enforce one run-wide authorized-request cap at every transport POST or Claude send. Contender-local policy closes failures after spent usage accounting; fail-fast gates later contenders, while `--no-fail-fast` continues within the remaining cap. V2 running/terminal artifacts persist compact progress and explicit privacy-safe metrics; incomplete runs exit nonzero, scratch data is scoped, and setup validation cannot overwrite source aliases (SPEC M3).
- [ ] The bake-off: `dev/bakeoff.ts` over ~500 real messages for Luna, Sol, Haiku at xhigh, Sonnet and a split; set the level cutoff only after a successful bounded pilot (SPEC M3).

## API keys

- [ ] Real model ids and prices, replacing the placeholders in `optchat.config.ts` (SPEC M5).
- [ ] Budget against the real bill (SPEC M5).
- [ ] Anthropic turns: each request reads everything the one before sent, also after a mid-run message (SPEC M5).

## Machines and network

- [ ] The phone over Tailscale as a PWA: install, reconnect, chat (SPEC M2). The iOS app has its own list below.
- [ ] A live two-machine run over a real tailnet: one chat edits files on both machines (SPEC M4).
- [x] Re-measure latency with real claude after the inline system prompt change, `dev/latency.ts` (SPEC Turn and priming).

## iPhone app (TestFlight)

Setup only you can do (docs/mobile.md, "Setup", has each step):

- [ ] Apple Developer Program; the App Store Connect app for `dev.hasparus.optchat` (or yours in `mobile/app.json`); its Apple ID as `ascAppId` in `mobile/eas.json`, committed.
- [ ] An App Store Connect API key (App Manager); keep the `.p8` for the EAS step.
- [ ] An Expo account; an organization with a robot user (Developer) whose token is the repository secret `EXPO_TOKEN`. It can fetch the App Store Connect key from EAS, so not a personal token.
- [ ] `cd mobile && bun install`, then `bun run eas login`, `bun run eas init --account <organization>` (commit `app.json`), `bun run eas credentials -p ios`: build credentials, and the API key for EAS Submit.
- [ ] Run the TestFlight workflow; install from TestFlight.

Then on the phone, which no CI can check:

- [ ] The robot user's Developer role is enough for a non-interactive build and submit (it must read the stored key); if not, the next role up, never a personal token.
- [ ] The build compiles and signs on EAS at all (Expo SDK 57, react-native-webview 13.16.1; nothing native was compiled here), and the non-interactive submit finds the key EAS keeps.
- [ ] First launch: the address check passes over Tailscale (`/api/devices` answers 200), and a wrong login gets the 403 message.
- [ ] Keyboard: the composer sits right on top of it, and nothing jumps when it opens or closes. Risk of a double adjustment: KeyboardAvoidingView shrinks the WebView while WKWebView may also inset or scroll its own scroll view for the same keyboard; if the page jumps, drop one (e.g. `scrollEnabled={false}` on the WebView, or no KeyboardAvoidingView). With `hideKeyboardAccessoryView` there is no Done button: check that tapping the chat dismisses the keyboard. Safe areas at the notch and the home indicator.
- [ ] "+" → Add context sheet (shadcn's Drawer on vaul 1.1.2, unmaintained since December 2024): "Photos & videos" and "Camera" open the picker from the sheet (the tap's user gesture must reach the hidden input in WKWebView), and the sheet closes; a drag down closes it too.
- [ ] vaul in WKWebView: while a sheet is open the page behind doesn't scroll (vaul's scroll lock), and when it closes the chat is where it was, not jumped to the top (vaul sets `position: fixed` on the body while open and restores the scroll afterwards). The keyboard opened under a sheet doesn't leave the page shifted.
- [ ] Background work (the same drawer): opens from the Devices screen and from the running turn's status line, scrolls inside when long, Stop ends the turn, a held message's take-back puts it back in the composer, and the elapsed time counts on.
- [ ] The composer's glass: backdrop blur renders and stays smooth while scrolling; text over a photo or code block stays readable.
- [ ] VoiceOver: a reply's Copy and Raw, collapsed behind a tap, can still be reached and activated.
- [ ] Camera and photo attach from the composer, a video's sound; the permission prompts show their strings, and the page gets the mic and camera with no second WebKit prompt.
- [ ] Back from the background after a few seconds, after a minute and after hours: the link reconnects at once (WKWebView fires `visibilitychange`; past 30 s an "open" socket is replaced), no white page; the failure screen retries by itself.
- [ ] Links in a reply open in the Safari sheet, `mailto:` in Mail; an attachment opens full size in the sheet, and the app stays on its page (the top frame only ever holds the server's `/`).
- [ ] Push notifications, later: APNs from the server for a finished turn (expo-notifications in the app, a `.p8` key on the server).

## Media

- [ ] Caption quality and cost: 50 real photos, Haiku against Sonnet (SPEC Media).
- [ ] Does the double JPEG pass hurt small text in screenshots? Keep PNG for flat images if so (SPEC Media).
