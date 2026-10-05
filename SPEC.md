# optchat-du-jour build spec

Oct 5, 2026 · Piotr Monwid-Olechnowicz (hasparus)

## Purpose and sources

We build optchat-du-jour, our own OptChat: Victor Taelin's endless chat whose history is its memory, kept as a binary summary tree. It runs on the Mac Mini and serves the MacBook and the phone over Tailscale. The gist is the source of truth. shitty-optchat is the reference implementation we mirror module for module, without copying its code. This spec lists what we keep from it, what we change, and why.

What we add on top of the reference:

- A web UI (React + shadcn) with chat, memory browser and stats, next to a terminal client.
- Several devices: the Mac Mini owns memory; turns can run on the MacBook.
- Engines matched to the plans we already pay for: Claude Max for main turns, ChatGPT Pro for the compactor, an API key as overflow.

Sources (read these before building):

- [OptChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), Victor Taelin. Cited as "gist §N".
- [shitty-optchat](https://github.com/gebeer/shitty-optchat) and its [SPEC.md](https://github.com/gebeer/shitty-optchat/blob/main/SPEC.md), gebeer. The reference implementation, cited as "ref §N". No license file: read, don't copy.
- [pi-optchat](https://github.com/jonaslsaa/pi-optchat), Jonas Silva, MIT. Has the four prompt strings verbatim and a second implementation to compare against.
- [Intrepidus](https://github.com/AJSuddu15243/Intrepidus). Per-member streams in one git repo; the model for our offline mode.
- [hermes-optchat](https://github.com/ottobunge/hermes-optchat). Ideas worth borrowing: media in a content-addressed sidecar, fail closed when the view can't settle.
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) and [Sign in with ChatGPT](https://flaviocopes.com/sign-in-with-chatgpt/): the rules for using each subscription.
- [Bend 2](https://github.com/bendlang/bend) for the fold kernel (E14) and [Effect](https://effect.website) for everything else (E13).
- [AG-UI](https://docs.ag-ui.com) for the WebSocket's events, and [shadcn chat components](https://ui.shadcn.com/docs/changelog/2026-06-chat-components) and [AI Elements](https://elements.ai-sdk.dev/docs) for the web UI (E15). [TanStack AI's connection adapters](https://tanstack.com/ai/latest/docs/chat/connection-adapters) were the plan for the client's state; see M2.

## Relationship to the reference implementation

The core matches shitty-optchat 1-1: same modules, same constants, same on-disk format, same turn mechanics. We write every line ourselves from its SPEC, not from its source. Its data dir and ours must be interchangeable, so its `optchat view` can read our memory and vice versa.

Rules:

- Everything the reference measured (ref §14) is taken as given until our own runs disagree. Re-run its probes after any Claude Code upgrade.
- Its deviations from the gist (D1–D10, ref §11) apply unless this spec overrides them. Ours are numbered E1, E2, … and listed under Deviations.
- The pure kernel is written in Bend 2 with proved laws and compiled to JavaScript (E14): `id+n` addressing, `fit`, refold and the pump's rule-3 order. It never sees text, only sizes as integers.
- Effect is the runtime for everything with I/O, time or concurrency (E13), and owns all text: rendering, cutting, logging.
- Tests follow ref §10: few, each a real failure scenario, with a fake `claude` and a fake compactor. No model calls in `bun test`: a preload (`test/preload.ts`) makes `claude` a stub that refuses to run unless a test names a fake, and points the secrets store at an empty file, so a test that forgets a fake fails instead of reaching a real model or key. The web UI's end-to-end server runs the fake `claude` with an empty secrets store too.

**Bend laws (`LAWS.bend`).** The compiler demands a proof of each on every edit:

1. The view tiles messages 0 to T with no gap and no overlap.
2. Every part `(l, i)` starts at `i · 2^l` and covers `2^l` messages.
3. `fit` merges only an adjacent sibling pair whose parent is built, and never splits a part.
4. After `fit`, the view's size is at most `VIEW`, or no pair can be merged.
5. Rule 3 never offers a node whose children are unbuilt, nor one beyond the first unbuilt view line.

The parity test runs the compiled kernel against the reference, which also guards against bugs in Bend's young compiler. If the M0 spike shows the JS output can't be called cleanly from TypeScript, the kernel is written in TypeScript and the laws become property tests.

**How Effect maps onto the reference.**

| Reference mechanism | With Effect |
| --- | --- |
| Child registry, exit and signal hooks, SIGTERM then SIGKILL after `KILL_GRACE` (ref §5.2) | Each `claude` process is a scoped resource; its finalizer kills it with a 5 s timeout. Closing the server's scope closes all of them |
| `AbortSignal` passed through `settle`, turns and priming | Fiber interruption: cancel from any client, Ctrl-C, or a device disconnect interrupts the turn fiber |
| Pump with `JOBS` slots and a fixed 10 s retry | A semaphore of 8 permits; retry with `Schedule.spaced("10 seconds")`, no backoff, as gist §4.1 requires |
| Priming chain on one promise, debounce timer | A single-permit queue and a debounced stream of view changes |
| Engine failover | Typed errors (`UsageLimit`, `DeviceOffline`, `Refusal`, `ModelError`); `orElse` only on the first two |
| Hand-checked JSON records and messages | `Schema` for log and tree records, `usage.jsonl`, WebSocket messages and the config |
| Timer-based tests | `TestClock` for retries, priming age and debounce |

Packages: `effect`, `@effect/platform` with its Bun adapter for the HTTP and WebSocket server and for spawning processes. Pin versions in M0 and use whatever the current major provides; don't mix in a second HTTP framework.

Module map (ours on the right; unchanged unless noted):

| Reference file | Ours | Change |
| --- | --- | --- |
| `config.ts` | `src/config.ts` | Loads `optchat.config.ts`: engines, per-level compactor models, cache TTLs, devices |
| `tree.ts`, `view.ts` | `kernel/*.bend` + `src/view.ts` | Addressing, fit and rule 3 in Bend with proved laws (E14); rendering and cutting stay in TypeScript. Parity-tested |
| `store.ts` | same | Data dir holds one stream per device (E3) |
| `compactor.ts` | same | Pump unchanged; jobs carry their level so the engine can be picked per level (E5) |
| `summarize.ts` | `src/summarize/` | One file per engine: `claude-code.ts`, `openai-plan.ts`, `api-key.ts` |
| `claude.ts` | same | Can spawn through a device runner instead of locally (E7) |
| `chat.ts`, `prime.ts`, `turn.ts` | same | Turn engine behind an interface; failover chain (E4) |
| `mcp.ts` | same | Served over HTTP on the tailnet, not stdio (E8) |
| `repl.ts` | `cli/repl.ts` | Becomes a client of the server's WebSocket API |
| `persist.ts` | same | Also pushes to a private remote (E10) |
| `browse.ts`, `usage.ts` | `web/` | Memory browser and stats move to the web UI; `usage.jsonl` gains fields (E11) |
| `import.ts` | same | Plus importers for Claude Code, Codex and ChatGPT history, modelled on pi-optchat |
| — | `server/` | New: Bun.serve, WebSocket API, Tailscale identity check |
| — | `device/` | New: the device runner on each machine |

**Parity test.** A script replays a fixture log through both implementations with the same deterministic fake compactor, then compares the reference's `optchat view` output with ours, byte for byte. It runs in CI against a pinned reference commit.

## System shape

One server process on the Mac Mini owns memory; everything else is a client or a runner. Memory has a single writer, as the gist and the reference require.

- **Mac Mini, `optchat-server`** (launchd): log, tree, view, compactor pump, turn loop, priming, HTTP + WebSocket API, zoom/date MCP endpoint, and the built web UI as static files.
- **Every other machine, `optchat-device`** (launchd): spawns `claude -p` there when the server asks, streams its events back. The Mini needs none: the server spawns its own device's `claude` directly.
- **Clients:** the web UI (phone, MacBook, Mini) and the terminal REPL. Both speak the same WebSocket API.
- **Model engines:** Claude through the `claude` binary on a device; OpenAI through the Responses API with the ChatGPT plan token; an API key as overflow.

```
Clients                       Mac Mini                                   MacBook
┌────────────────┐           ┌────────────────────────────────────┐     ┌──────────────────────┐
│ Phone (web UI) │──┐        │ optchat-server                     │     │ optchat-device       │
├────────────────┤  │  /ws   │  log, tree, view, compactor pump   │spawn│  runs claude -p here │
│ MacBook browser│──┼───────▶│  turn loop, priming, /ws, /mcp     │────▶│                      │──┐
├────────────────┤  │        │  web UI as static files            │     └──────────────────────┘  │
│ Terminal REPL  │──┘        └──┬───────────────┬──────────┬──────┘                               │
└────────────────┘              │               │ spawn    │ compaction                           │
 WebSocket over the tailnet     ▼               ▼          ▼             Model engines            │
                         ┌──────────┐  ┌────────────────┐  ┌──────────────────────────────┐       │
                         │ data dir │  │ claude -p      │  │ ChatGPT Pro (Luna, Sol)      │       │
                         │ git,     │  │ on the Mini    │─▶│ Claude Max (Opus via claude) │◀──────┘
                         │ pushed   │  │ (local runner) │  │ API key (overflow, budget)   │
                         └──────────┘  └────────────────┘  └──────────────────────────────┘
```

Clients talk only to the server; the server spawns each turn's `claude -p` itself when the turn is on the Mini, or through the device runner of the machine it is on, and sends compactor calls to the ChatGPT plan.

Data directory on the Mini (its own git repo, as in the reference):

```
~/.optchat/
  streams/
    mini/                 one reference-compatible data dir per writer
      chat/main/YYYY-MM-DD.jsonl
      chat/tree/YYYY-MM-DD.jsonl
      lock
    macbook/              only in offline mode (milestone M6)
  instructions.md         the user's own instructions (gist §7.2)
  usage.jsonl             one line per model call
  assets/                 content-addressed media, later
```

`OPTCHAT_DIR=~/.optchat/streams/mini` points the reference's CLI at our memory for parity checks.

## Constants and configuration

The gist's constants stay fixed; everything new is configuration. Sizes are UTF-8 bytes, cache marks are characters.

| Constant | Value | From |
| --- | --- | --- |
| `NODE` | 512 bytes | gist §1 |
| `VIEW` | 128,000 bytes | gist §1 |
| `JOBS` | 8 compactor jobs at once | gist §1 |
| `TRIES` | 5 size retries | gist §1 |
| `RETRY` | 10 s, fixed, forever | gist §1 |
| `CAP` | 30,000 chars of logged tool output | gist §1 |
| `MARKS` | 50,000 / 80,000 / 100,000 chars | gist §1 |
| `PRIME_MAX_AGE` | 270 s with 5 min TTL; 3,300 s with 1 h TTL | ref §2, adjusted for E6 |
| `PRIME_TIMEOUT`, `PRIME_IDLE`, `KILL_GRACE` | 30 s, 1 s, 5 s | ref §2 |
| `WARM_MAX_AGE`, `WARM_RETRY`, `WARM_TRIES` | 30 min, 2 s, 3 | ours (E18) |
| `CALL_TIMEOUT` | 5 min per compactor call | ref §7 |

Configuration lives in `optchat.config.ts`, typed, in the repo:

```ts
export default {
  master: {
    chain: ["claude-code:opus", "openai-plan:gpt-6-sol", "api-key:anthropic/opus"],
    effort: "high",
    permissionMode: "bypassPermissions", // ref D9
  },
  compactor: {
    byLevel: [
      { from: 0, chain: ["openai-plan:gpt-6-luna", "api-key:openai/gpt-6-luna"] },
      { from: 3, chain: ["openai-plan:gpt-6-sol", "claude-code:sonnet"] },
    ],
    effort: "medium",
  },
  cache: { claudeCodeTtl: "1h", primeTtl: "1h", apiKeyTtls: ["1h", "5m", "5m", "5m"] },
  devices: {
    mini: { url: "http://optchat-mini:7710", folders: ["~/repos", "~/notes"] },
    macbook: { url: "http://optchat-macbook:7710", folders: ["~/repos"] },
  },
  defaultDevice: "mini",
  allowedLogins: ["<my tailscale login>"],
  server: { host: "127.0.0.1", port: 7700, publicUrl: "https://<mini>.<tailnet>.ts.net" },
};
```

The compactor level cutoff (3) is a starting guess; the bake-off in milestone M3 sets it.

## Storage, tree, view and compactor ordering

Implement gist §2–§6 exactly as ref §3 does, including its "as built" decisions. Nothing here changes except where the files live.

- **Records:** `main` is `{i, kind, text, size, date}` with `kind` one of `user|talk|tool|echo|note`; `tree` is `{l, i, text, size}`. A level-`l` node covers 2^l messages from `i * 2^l`.
- **Writes:** one write plus `fsync` per line, files split by local day, ids global. On load, skip and report damaged lines and add a missing final newline. Only the lock holder repairs.
- **Lock:** a unix socket per stream for the process lifetime; a refused connection means stale and taken over. Keep paths under ~107 characters.
- **Free nodes:** level 0 is `kind + ": " + text` if it fits in `NODE`; higher levels are `childA + "\n" + childB` if that fits. Written to `tree` like any node; no model call.
- **Pump:** gist rule 3, at most `JOBS` jobs, fixed 10 s retry, only the first failure of a node reported. The job's context is snapshotted when it starts.
- **View:** append `(0, i)`, then `fit()` while over `VIEW`, merging the most-due built pair: `due = (T − start) / 2^(l+2)`, ties to the leftmost. Never split. Refold from message 0 on load. Size counts node text bytes only.
- **Render:** `<chat>\n` + `id+n|text` lines with newlines turned into spaces + `\n</chat>`. Unbuilt lines show `(not summarized yet: zoom it)`.
- **`settle(signal)`:** resolves when every view line is built. A turn waits on it before rendering (gist §6).

**Streams (E3).** Each writer gets `streams/<device>/` with its own `chat/`, lock and pump. In v1 only `mini` exists. In offline mode (M6) each stream's owner compacts only its own tree, and every view appends the other streams' folded views read-only as `<chat who="macbook">` blocks, as Intrepidus does.

## Engines

Every model call goes through one of three engines, chosen per role from a failover chain (E4). Because each turn starts fresh from the view, any engine can take any turn; memory doesn't care who wrote what.

```ts
interface TurnEngine {
  run(input: { view: string; texts: string[]; device: string; signal: AbortSignal },
      out: TurnEvents): Promise<TurnResult>;   // TurnEvents: talk, tool, echo, replay, usage
  steer(text: string): void;                    // mid-run message
  prime?(view: string): Promise<void>;
}
interface CompactEngine {
  summarize(job: Job): Promise<string>;        // job: context lines, step block, level
}
```

(With Effect these become services returning `Effect`s; interruption replaces `signal`.)

| Engine | Auth | Used for | Notes |
| --- | --- | --- | --- |
| `claude-code` | My Claude Max login, in the unmodified `claude` binary on each device | Main turns (Opus, high effort); spare compactor capacity (Sonnet, medium) | Exactly the reference's mechanics (ref §4–§7). Never read or reuse its OAuth token elsewhere |
| `openai-plan` | Sign in with ChatGPT, "Use your ChatGPT plan" scope, ChatGPT Pro | Compactor (Luna, Sol); master fallback (Sol) | OAuth 2.0 + PKCE; the first sign-in sends `client_id=dynamic_agent_client` and gets this install's own client id back, which is saved and used from then on; Responses API with `stream: true`, `store: false` |
| `api-key` | Anthropic and OpenAI keys with a monthly budget | Overflow only | Our own cache marks and TTLs (`cache.apiKeyTtls`) |

**Failover.** Move to the next engine in the chain on a usage or rate limit, on `429 subscription_sharing_usage_limit_exceeded` from OpenAI (also when it ends a stream as `response.failed`), when `openai-plan` is signed out or not eligible (`403 subscription_sharing_user_not_eligible`, or a 401 that one token refresh doesn't cure), or when the device is offline. Never on a refusal or a model error: those are reported, as in ref §5.2. Each failover is logged to `usage.jsonl` and shown in the UI.

**Mid-run messages on `openai-plan`.** The reference relies on Claude Code delivering stdin messages between tool calls. On the Responses API we run our own tool loop, so a steered message is appended after the current tool results, before the next request.

**Tools on non-Claude engines.** Claude Code brings Bash, Read, Edit, Write, Glob, Grep, WebFetch and WebSearch. A Sol turn gets the same set, implemented by the device runner, plus zoom and date. Its first version (M5) ships read-only tools only, so a fallback turn can answer but not change files.

**Failover mid-turn.** The user's messages are logged before any engine runs, so a failover can't lose them; the rule is about what the next engine is given. It gets the same view and the same new texts, whatever the first engine got done. If the first engine had already logged entries (text, tool calls, results, mid-run messages it took) when its limit hit, they stay in the log, once, and the next engine's opening message carries them after the texts, under a note that another engine began the turn and stopped, so it carries on instead of repeating the work. Mid-run messages the first engine never took go to the next one as its own mid-run messages. The `info` notice says how many entries were handed on. If the last engine fails too, the untaken messages are logged unanswered with the notice, as for any failed turn (E16).

## Turn and priming

The `claude-code` turn is ref §4–§6 unchanged, except for the cache TTL (E6), where the process runs (E7), that it never waits for priming (E17), and that its process may have been started ahead (E18).

1. Wait for `settle()`; on cancel, log the queued texts as unanswered `user` messages.
2. Render the view **before** logging the new messages.
3. Stop any priming still in flight, without waiting for it; never prime first (E17).
4. Log each queued text as `user`, then spawn the master on the chosen device: the base flags of ref §4 plus `--mcp-config` and `--replay-user-messages`. On the Mini this is usually the warm process started for exactly this spawn (E18).
5. Send one user message: the view cut into up to 4 blocks at 50k / 80k / 100k characters, **no cache marks**, then the texts joined by a blank line.
6. Map stream events to the log as in ref §5.3: text → `talk`, tool_use → `tool`, tool_result → `echo` (capped at `CAP`), later replays → `user`. Never log thinking.
7. Kill the process at the first `result`; requeue mid-run messages that were never replayed. Commit the data dir. The session reports `idle` only once the commit is done, and a message that arrives while the loop winds down starts it again.

As built, where we differ from ref §5.2:

- A refusal or an `is_error` result ends the turn like a crash: mid-run messages the call never took are logged as unanswered `user` messages, where the reference requeues them after any `result`. A refused or failed call says nothing about the next one, and the user sees the messages and the error together; the chain (E4) decides whether another engine takes over.
- A cancel before the run starts (while waiting for summaries) logs the queued texts unanswered. There is no wait for priming to cancel (E17).
- A blank message is ignored: it starts no turn and logs no empty `user` entry.
- Every message waits in one inbox (`src/session.ts`) until it is logged, with the id its client sent it with, and has one owner at any moment: queued for the next turn, or offered to the running call. A call reads what it is offered from its own queue and reports each message it took (claude-code: its replay; our tool loop: when it joins the next request), and the session logs it then and acks that client id; what the call never took is queued again when it ends, on the call's device unless it was sent for another. A failover's next link is offered the untaken ones first, and is given what the turn logged so far (`earlier`) read from the log. Acks never match by text, so two clients sending the same text each get their own entry.
- After the loop stops on an error (the log refuses, a defect), the messages it stopped on wait for a newer one, so a defect can't restart it forever; a message that comes in while the loop winds down is newer and starts it again.

The system prompt is MASTER + VIEW_DOC + `instructions.md`, written once at startup, byte-identical across calls and devices: no dates, cwd or git status (gist §7.2). MASTER keeps the reference's D5 and D10 edits until subagents land (M7).

**Priming.** As ref §6: a call with the master's exact flags plus `DISABLE_PROMPT_CACHING=1`, carrying the same view blocks with our own marks, killed at `message_start`. It runs only while the session is idle: in the background 1 s after the view settles, and when a web client connects, since a message usually follows. That idle priming is what makes turns warm. A turn never waits for it (E17), where ref §6 and gist §8 have the turn await it:

- The same view was primed within `PRIME_MAX_AGE`: the turn reads it from the cache.
- A priming is in flight: the turn starts at once and the priming is stopped (its fiber interrupted, its `claude` killed; it logs no usage and reports no failure). Its request would race the turn's own, which writes the same prefix anyway, so letting it finish would write the view twice; killed before `message_start`, and often before its request leaves `claude`, it costs less or nothing (whether a request killed after it was sent counts against the plan is still open, see M1 below). The next idle priming writes the marks for the next view.
- Nothing was primed: the turn just runs, and its own request writes the cache, with Claude Code's mark at its end rather than ours at the view's cut points; the idle priming after the turn writes those for the next view.

Measured on claude 2.1.289 with Sonnet and a small view: a turn sent while its view was being primed showed "priming" for 2.6 s (a fresh `claude -p`: ~1.3 s to boot, ~1.2 s to `message_start`) before its own ~2.0 s to the first text. Waiting can't shorten the time to the first token; it only spares one cache write, which on the plan is quota, not latency. So the session has no "priming" phase any more: a turn is `waiting` (for summaries) or `running`.

**Warm processes (E18).** Most of a turn's first second is `claude` booting: spawned and sent a message at once, it reaches `system/init` in ~1.3 s; started ahead and idle on stdin, in ~0.1 s. So the Mini's Runner (`src/claude/warm.ts`) keeps one process started ahead for each of the next two spawns, the master's turn and its priming (which differ only by `DISABLE_PROMPT_CACHING=1`). The engine names them when the session starts and whenever it goes idle. A spawn byte-identical in args, env and cwd gets the warm process and a replacement starts at once in the background; any other spawn starts fresh. The rules:

- At most one process per spawn, and only for the two spawns named last. The session names those of the first engine in the master's chain, on the default device; a failover link's turn, a turn on another device and one in another folder start fresh. When the two spawns change (the lead's model or system prompt file, the device's MCP transport), the stale processes close.
- One that dies while idle is noticed (its output closes), never handed out, and replaced after `WARM_RETRY`, at most `WARM_TRIES` times in a row, so a broken `claude` doesn't restart forever; one that fails to start counts the same. A spawn that starts it fresh again gives it `WARM_TRIES` more.
- Each spawn has a keeper fiber that starts its process, holds it in a one-process slot and waits until it is taken, dies or grows old. A caller takes it out of the slot and ties it to its own scope in one uninterruptible step, so an interrupted caller can't leave it running.
- One older than `WARM_MAX_AGE` is replaced, so no turn runs on the login, settings and feature flags a process read hours ago. Claude Code may also update itself between a process's start and its use; that turn runs on the version it started with, which is accepted (a version change costs one cache rewrite anyway, ref §16.8).
- Every warm process belongs to a scope under the server's: shutting down kills them all, like any running turn.
- Other devices (RemoteRunner), the compactor (8 jobs at once, not worth it) and the API engines spawn on demand.

Each idle `claude -p` holds about 200 MB, so the Mini keeps ~400 MB for this. It also opens its MCP connection to `/mcp` at boot, so a turn doesn't wait for that either. Measured with `dev/latency.ts` (same machine, 3 turns each, 8 s idle between them): the median time from send to the first assistant text went from 1,990 ms to 1,160 ms, and to `RUN_FINISHED` from 3,125 ms to 2,218 ms.

**Cache TTL (E6).** The reference forces 5-minute entries (`CLAUDE_CODE_PROMPT_CACHE_TTL=5m`) to follow gist §8. On the subscription we keep Claude Code's default 1-hour marks instead, and priming writes `ttl: "1h"` marks. Every mark in a request then has the same TTL, which avoids Anthropic's ordering error (1-hour entries must precede 5-minute ones). Reason: on the plan there's no per-token bill, and phone chats with gaps over 5 minutes would otherwise rewrite the whole view on almost every turn. The variable is set per spawned process; my normal Claude Code settings stay untouched.

## Compactor calls

The compactor's input and retries follow gist §4.2–§4.4 and ref §7 on every engine; only the transport changes (E5). The level of the node picks the engine chain.

**Input, all engines.** System prompt = `compact.txt` (gist §4.4, verbatim). Context = `<chat>` + the bare view lines (no ids) up to the node's stretch + `</chat>`, cut at the same 50k / 80k / 100k marks as the master. Step block = "For scale, this line is exactly 512 bytes:" + `SCALE` + the instruction + the message or the two child lines.

**Size retries.** In the same conversation: "That line is N bytes; the limit is 512. It must end where it is cut here:" + the line cut at 512 bytes + `| ← LIMIT`. Up to `TRIES`; keep the shortest try.

**`SCALE`.** Our own hand-written line of exactly 512 bytes, tagged `user:` / `talk:` / `tool:` / `echo:`, about a plausible session. Not copied from either implementation. A test checks its length.

Per engine:

- **`claude-code`:** exactly ref §7 (layout A, `--safe-mode`, `DISABLE_PROMPT_CACHING=1`, our 4 marks). TTL follows E6.
- **`openai-plan`:** Responses API, one request per try, the full input re-sent each time (`store: false`). No cache marks: OpenAI caches stable prefixes automatically, so keeping context blocks byte-stable is what matters. The route rejects `system` messages, so `compact.txt` goes into `instructions`, as OpenAI's docs for the route say. Each try is one user message of input-text parts (the context pieces, then the step), and a retry appends the previous answer as an `assistant` message and the retry text as a new user message.
- **`api-key`:** Anthropic gets layout A with our marks and `cache.apiKeyTtls`; OpenAI is the same as `openai-plan`.

**Bake-off (M3).** Before fixing the level cutoff, replay ~500 real messages through Luna, Sol and Sonnet compactors and compare:

| Measure | How |
| --- | --- |
| Retries per node | Mean and p95 tries until ≤ 512 bytes |
| Cost per message | From `usage.jsonl`, in dollars or plan share |
| User's words kept | How often a quoted user sentence survives 2 and 3 levels up |
| Findability | Questions generated from raw messages; an agent with only that tree and zoom must find the answers |

## zoom and date over MCP

The server exposes `zoom` and `date` as an MCP server at `/mcp` on the tailnet, so a `claude -p` on any device reaches the same memory (E8, replacing the reference's stdio server, D8).

- **Transport:** a WebSocket by default, one JSON-RPC 2.0 message per text frame each way (`GET /mcp` that upgrades); also one message per `POST /mcp`. Claude Code documents only `stdio`, `sse` and `http` for `--mcp-config`, but its config schema also takes `{"type": "ws", "url", "headers"?}`, and it connects with subprotocol `mcp` and no `Origin` (probed on 2.1.289: connected, and a real turn called `zoom` over it). A warm process (E18) opens the socket at boot and keeps it, so a turn's tool calls go over a connection already open. Because the type is undocumented, each device falls back by itself, and while on ws watches every `claude` there (priming usually comes first) for one of these: its `system/init` lists `optchat` as `failed`, or leaves it out (2.1.289 skips an entry whose type it doesn't know, with a warning on stderr only when that is a terminal); or it ends before any `system/init` because its config was rejected (Claude Code checks `--mcp-config` against its schema as it starts and exits with `Error: Invalid MCP configuration:` on stderr; 2.1.42 does that for any entry its schema refuses); or it ends before `system/init` twice in a row for any reason. `pending` and `needs-auth` say nothing about the type and change nothing. That device's calls then use the `http` form, the user is told once (in words that allow for the other cause of `failed`, a server it couldn't reach), and its warm processes (E18) are started again with the new config. `server.mcpTransport: "http"` turns ws off. Which transport is used changes nothing the model is sent, so not the cache either.

- **Behaviour:** exactly ref §9 and gist §7.1, with the gist's tool descriptions verbatim. `zoom(id, n)` validates integers, `n` a power of 2, `id % n == 0`, `id + n ≤ T`, the node built; otherwise `No line id+n.` `zoom(id, 1)` returns `id+0|kind: text` in full and works for any existing message. `date(id)` returns local time as `2026-10-04 14:03`, or `No message N.`
- **Read-only:** answers from the server's in-memory tree; never takes the lock.
- **Cache stability:** the `--mcp-config` JSON is the same for a device's priming and real turns. The server name stays `optchat`, so the tool names (`mcp__optchat__zoom`, `mcp__optchat__date`) and the cached tool list are the same on every device; only the URL differs, and the URL isn't sent to the model.
- **Auth:** a `claude` on another device calls `/mcp` at `server.publicUrl`, that is through `tailscale serve`, which hides the caller's address and adds its owner's login. So WhoIs plays no part: the guard is the secret key in the URL (made at startup, sent only inside `--mcp-config`) plus the `allowedLogins` check every route has. Over either transport: the WebSocket's upgrade request passes the same Host, Origin and login checks as any request (`server/auth.ts`) and needs the same key. A `claude` on the Mini calls the loopback URL with the same key. Without `server.publicUrl` the server refuses turns on other devices rather than hand them a loopback URL and its key.
- **Offline mode (M6):** gains `who`, plus `grep(regex, who)`, as in Intrepidus.

## Multi-machine

One chat, one memory, two pairs of hands: the Mini keeps memory and the turn loop, and runs each turn's `claude -p` on whichever machine has the files (E7). The MacBook needs only `claude` logged in and the device runner.

**Device runner (`device/`).** A small Bun daemon, launchd-managed, listening on the tailnet only.

- `GET /spawn`, a WebSocket whose first frame carries the args, env and cwd; then stdin goes in and the stream-json events come out, and a last frame says how `claude` exited (`src/claude/wire.ts`). It refuses a cwd outside the configured folders, after resolving symlinks and `..`, and any env but `CLAUDE_CODE_PROMPT_CACHE_TTL` and `DISABLE_PROMPT_CACHING`, the two a turn and its priming set. It only ever runs the `claude` binary, never a shell, but the caller chooses its arguments: these checks keep turns alike across devices and are not a sandbox. The boundary is who may call: only the server's device (`OPTCHAT_SERVER_DEVICE`, else `defaultDevice`), by Tailscale WhoIs.
- Kills children on disconnect, on SIGTERM and after `KILL_GRACE`, mirroring the reference's child registry (ref §5.2). Each `claude` runs in its own process group, so the kill reaches the commands it started. A daemon killed with SIGKILL (launchd stops it with SIGTERM) leaves its running children behind, for the same reason; not prevented.
- Listens on the machine's `tailscale ip -4` address only. MagicDNS also answers AAAA, so the server resolves a device's name to IPv4 before connecting.
- Writes nothing of its own; the master's tools change files on that machine, nothing else.
- `POST /tool` runs one read-only tool (Read, Glob, Grep) for a turn on an engine with its own tool loop (M5): a `ToolCall` in, a `ToolReply` out, let in on the same terms as `/spawn` (no `Origin`, a trusted node). Every path is resolved (`~`, `..`, symlinks) and must land in the folders; Glob patterns may not climb out; output is capped at 100k characters and each call at 30 s. Grep's pattern is the model's and a JavaScript regex can backtrack without end, so the search itself runs in a Worker (`src/tools/grep-worker.ts`) that is terminated when the call times out or is interrupted; the server's event loop is never the one blocked. No shell and no write. The server's own device runs the same code (`src/tools/files.ts`) in-process.
- `GET /health` returns the `claude` version, so the server can warn when devices differ (a version change invalidates the cache once, ref §16.8). `/api/devices` shows each device as online, offline, or refused (it answered 403: its callers or the server's node name are misconfigured).

**Routing.** Each turn picks a device: an explicit picker in the UI, a `/on macbook` prefix, or the default device. The choice is stored as an extra `device` field on that turn's log entries, which readers ignore, as pi-optchat does with its `origin` field. The user's text is never changed; the tool calls' paths already show the compactor where work happened.

**Device offline.** The turn fails fast with a clear notice in the UI and in the log; the failover chain may then run it on another engine with read-only tools. Never queue silently. The server remembers an unreachable device for 5 s, so a priming and the turn right after it wait for it once and report it once.

**Offline mode (M6).** If the Mini is unreachable, the MacBook runs a local server on `streams/macbook/` and pushes to the shared git remote. The Mini pulls before each turn and shows that stream read-only. Two streams means two chats until the user merges them; that is accepted, as in Intrepidus.

## Server, WebSocket API and CLI

The reference's session object (`createSession` in ref `turn.ts`) moves into the server unchanged; the REPL and the web UI become two clients of one WebSocket API (E1).

**Server.** `Bun.serve` on `127.0.0.1:7700`, published to the tailnet by `tailscale serve`. Routes: `/ws` (the API), `/mcp` (zoom and date), `/api/*` (read-only JSON for the browser and stats), `/` (the built web UI).

**Protocol: AG-UI events (E15).** The WebSocket carries AG-UI protocol events, a standard any AG-UI client can read. Both ends are ours: the server in Effect, the web UI's session store over the same events (see Web UI). Any number of clients watch the same server-owned turn. The state the events carry and the JSON of `/api/*` are schemas in `src/wire.ts`, a module with no node imports that the web UI bundles too.

| What happens | AG-UI event | Notes |
| --- | --- | --- |
| Client connects or reconnects | `MESSAGES_SNAPSHOT` + `STATE_SNAPSHOT` | The last window of log entries and the current state; mid-run also `RUN_STARTED` and the reply streamed so far, so a client that joins mid-reply gets all of it |
| A turn starts | `RUN_STARTED` | `threadId` = stream name (`mini`), `runId` = the turn's first `user` entry |
| A `user` entry is logged (also mid-run, also from another client) | `MESSAGES_SNAPSHOT` delta or a user text message | So every client sees every message |
| Live reply text, then the `talk` entry | `TEXT_MESSAGE_START` / `CONTENT` / `END` | Message id = the entry's log index `i` |
| A `tool` entry | `TOOL_CALL_START` / `ARGS` / `END` | Tool name and JSON input |
| An `echo` entry | `TOOL_CALL_RESULT` | The capped text, as logged |
| Waiting for summaries, running, device, engine, view size | `STATE_DELTA` | One shared state object |
| Usage records, failovers, errors, refusals, device offline | `CUSTOM` (`usage`, `info`) | Shown in the status line and the stats screen |
| Thinking | `CUSTOM` (`thinking`) | Token count only; thinking text is never sent |
| The turn ends | `RUN_FINISHED` or `RUN_ERROR`, then `MESSAGES_SNAPSHOT` | Exactly one per `RUN_STARTED`, also on a cancel (`RUN_ERROR` "cancelled"), before anything else is logged; the open reply is closed first. The snapshot resyncs every client to the log, so a reply cut off before its `talk` entry disappears before its index goes to the next entry |
| Client sends a message | a `RunAgentInput` frame | Starts a turn, or becomes a mid-run message when a turn is running; a blank text is ignored. Only user messages whose ids the connection has not sent before are taken (a client may resend the whole history); ids that are log indexes name entries and are never new |
| A client's message is logged, or cannot be | `CUSTOM` (`ack`: `{clientId, messageId, error}`) | Before the user entry it names; `messageId` null and `error` set when the log refused it (it stays queued for the next message, and is acked again with its index when that logs it). A client tells its own messages by this, not by their text |
| Client cancels | `{"type":"abort"}` | Same as Ctrl-C in ref §10; a client sends it only while connected, so a stale one never cancels the next turn |

The log stays the source of truth. A client's state is only a view of it, rebuilt from `MESSAGES_SNAPSHOT` on every reconnect and after every run, so there is no replay protocol.

**CLI.** `optchat` is the reference's REPL (ref §10: bracketed paste, Ctrl-C and Ctrl-Z paths, plain scrollback) talking to the server over `/ws`. `optchat view`, `stats`, `browse` and `import-*` stay local commands that read the data dir without the lock, as in the reference.

## Web UI

A phone-first single-page app in `web/`: Vite + React 19 + Tailwind 4, built into static files the server serves (E2). One page with tabs, no router framework. It is installable as a PWA, so it opens like an app from the home screen.

The chat is built from three layers, all shadcn-registry code copied into the repo:

| Layer | What | Pieces we use |
| --- | --- | --- |
| State and transport | Our own session store over the `/ws` link, reading AG-UI events (E15) | `web/src/lib/log.ts`: the log's entries by log index plus the one reply or tool call streaming in, filled from snapshots, live events and `/api/messages` pages alike; `session.ts` around it (state, markers, the queue) |
| Layout and scrolling | shadcn's official chat components (June 2026) | `MessageScroller` (anchors on user rows, prepends older history, `scrollToMessage`), `Message`, `Bubble`, `Marker` for tool lines, status and day separators |
| Rich parts | AI Elements, with its few AI SDK type imports swapped for our own types | `MessageResponse` (streaming markdown via Streamdown), `Tool`, `Terminal`, `Code Block`, `Prompt Input`, `Queue` (unsent mid-run messages), `Context` (view size against 128 KB) |

Skipped on purpose: AI Elements' `Conversation` (`MessageScroller` handles prepending and jumping) and `Reasoning` (we never log thinking). The AI SDK itself is not a dependency.

Screens:

1. **Chat.** The log in a `MessageScroller`: `user` and `talk` entries as messages, `talk` rendered by `MessageResponse`; `tool` and `echo` entries as collapsed `Tool` / `Terminal` rows; status as `Marker` rows. The composer is AI Elements' `Prompt Input` with send, cancel and a device picker; messages sent mid-run sit in a `Queue` until the turn takes them, and a message the server's `ack` says it could not log stays there marked "not logged" with the error. Only a recent window of the log is loaded; older entries prepend on scroll.
2. **Memory.** What the model sees: the view as `id+n|text` lines with their range, dates and size, plus a `Context` meter against 128 KB. Tapping a line zooms into its two children, down to the full message; "show in chat" calls `scrollToMessage(i)`. This replaces the reference's `optchat browse` page.
3. **Stats.** From `usage.jsonl`, with shadcn charts: calls, tokens, cache hit rate and cold versus warm turns per day and week, split by role and engine; API-key spend against its budget; failovers. This replaces `optchat stats`.
4. **Devices.** Which machines are online, their `claude` version, their folders.

Rules:

- Show what the log holds and nothing more: no thinking text, and markdown rendering never hides what the model actually wrote (a raw-text toggle per message; a tool's input as logged). Every row is keyed by its log index, from the first streamed event to the snapshot that confirms it.
- Model output never makes the phone fetch anything: images in a reply are not loaded (their alt text shows instead).
- On a phone, Enter in the composer is a new line and the send button sends; on a keyboard, Enter sends. What the user typed is sent as typed.
- Opening the app triggers a background prime (see Turn and priming).
- Dark and light themes; works at 360 px wide.
- UI tests replay scripted conversations as AG-UI events with no model or network (`web/src/test/fixture.ts`, a fake server behind the link's socket). `@shadcn/helpers/tanstack-ai` was the plan, but it scripts replies to a client's own request (and pins `@tanstack/ai` 0.40), while our server pushes snapshots and turns other clients started. End-to-end tests run the real server with the fake `claude` (`web/e2e`).

## Tailscale, auth and operations

Nothing listens on a public interface; the tailnet is the only way in (E9).

- **Publishing:** `tailscale serve --bg --https=443 http://127.0.0.1:7700` on the Mini gives `https://<mini>.<tailnet>.ts.net` with a valid certificate. Device runners listen on their tailnet address only.
- **User auth:** `tailscale serve` adds identity headers (`Tailscale-User-Login`) to each request. The server accepts a request only if that login is in `allowedLogins` and the request came through serve on loopback; anything else gets 403.
- **Browsers:** `/ws` drives a master with `bypassPermissions`, so a web page must not reach it from someone's browser (cross-site WebSocket hijacking, DNS rebinding, or a page on the phone riding the user's own serve identity). Every route checks `Host` (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` or the host of `server.publicUrl`) and, when an `Origin` is sent, that it is the server's own origin; CLI clients send none. The threat model is written out in `server/auth.ts`.
- **Machine auth:** a device runner asks Tailscale's local WhoIs which node is calling and compares its full MagicDNS name with the other configured devices' (the URL's host plus this tailnet's suffix, so a device URL must use a name, not an IP address). Answers are cached per address for 10 s, and at most 4 WhoIs calls run at once. Before that it refuses any request with an `Origin` header: a page in a browser on an allowed machine is that machine's node too, and the server's runner sends none. `/mcp` is covered under zoom and date. No tokens to rotate.
- **Processes:** one launchd agent on the Mini (`optchat-server`) and one on the MacBook (`optchat-device`), each with `KeepAlive`, logs in `~/Library/Logs/optchat/`. The Mini's energy settings keep it awake.
- **Permissions:** the master runs with `bypassPermissions` (ref D9). The device's folder allowlist only sets the working directory; it does not confine `claude`, whose Bash can reach anything that user can. The boundary is who may call the runner: the other configured devices' nodes, and no browser.
- **Persistence:** the data dir is its own git repo, committed after every turn as in ref §10, and pushed to a private remote (E10). The push is the backup and, in M6, the sync. The session turns idle once the commit is made; the push runs in the background, one at a time, and a failing push is reported once until one goes through again.
- **Secrets:** the ChatGPT plan token and API keys live in the macOS Keychain (`security`, service `optchat`), never in the repo or the data dir. Off macOS (Linux, dev) they go to `~/.config/optchat/secrets.json`, mode 0600. `$OPTCHAT_SECRETS` names such a file instead, on any machine; the tests point it at an empty one.

## Usage and cost tracking

Every model call that reports usage appends one line to `usage.jsonl`, as in the reference, with more fields (E11); a failed call gets its line too when the engine says what it cost. A call that fails before it reports any usage (an HTTP 429 or 5xx, a network error, no access token) gets no line: it shows only as a report, and a failover it causes as the next engine's `failoverFrom`. Two weeks of these lines decide the plan questions below.

```json
{"date":"2026-10-05T04:46:00Z","role":"turn|prime|compact|subagent","engine":"claude-code",
 "auth":"claude-max|chatgpt-pro|api-key","model":"opus","device":"mini","level":null,
 "usage":{"input":0,"cacheRead":0,"cacheWrite":0,"output":0},
 "cold":false,"attempt":1,"failoverFrom":null,"ms":0}
```

- `cold` is true when the call read less than half the view from the cache. For a turn it is judged on the first request's usage (`message_start`), the one that reads the view; the token counts are the whole call's. Compactor records carry the device they ran on (the server's own machine).
- `level` is set for compactor calls, so the per-level split can be costed.
- API-key calls also get a dollar figure from a price table in config; the server stops using the key when its monthly budget is spent and says so in the UI.

Expected spend, as a baseline to check against (estimates from the reference's measured token counts, not our runs):

| Role | Engine | Expected |
| --- | --- | --- |
| Main turns | Claude Max 5× | Inside the plan; the ~40k-token view on every turn is the main draw on its limits |
| Compactor, levels 0–2 | ChatGPT Pro, Luna | Inside the plan; about 1.5–2 calls per logged message |
| Compactor, levels 3+ | ChatGPT Pro, Sol | Inside the plan; about a quarter of all merges |
| Overflow | API key | Capped at the $20 a month freed by cancelling Cursor |

Decisions the data should settle after two weeks: whether Max 5× is enough for main turns, whether the compactor fits the ChatGPT Pro weekly limit alongside Codex work, and whether the 1-hour TTL lowers cold turns as expected.

## Deviations

Our changes on top of the reference's D1–D10, which all still apply except D8 (replaced by E8). Keep this list current, as the reference does.

| # | Change | Reference / gist says | Reason |
| --- | --- | --- | --- |
| E1 | A server owns the session; REPL and web UI are clients of one WebSocket API | REPL owns the session (ref §10) | Phone and MacBook access |
| E2 | Memory browser and stats in the web UI | `optchat browse` HTML, `optchat stats` tables | Same data, usable on a phone |
| E3 | One data dir per writer under `streams/<device>/` | One data dir | Offline mode later without a migration |
| E4 | Turn engine behind an interface with a failover chain | `claude -p` only (D1) | Use all paid plans; keep chatting when one is exhausted |
| E5 | Compactor engine chosen per tree level; Luna and Sol on the ChatGPT plan | Sonnet, medium effort, via `claude -p` (ref §7) | Compaction is most of the cost; low levels are mostly tool noise |
| E6 | 1-hour cache entries on the subscription; priming marks `ttl: "1h"` | 5-minute entries only (gist §8, ref §4) | No per-token bill on the plan; phone chats with gaps would mostly be cold |
| E7 | `claude -p` runs on the device that has the files, through a device runner | Local process (ref §5) | MacBook repos with one shared memory |
| E8 | zoom and date over MCP on the tailnet, a WebSocket by default (Claude Code's undocumented `ws` type), HTTP per device as the fallback | stdio MCP (D8) | Reachable from every device; one connection a warm process opens at boot instead of a request per call |
| E9 | Tailscale identity is the only auth | Local terminal only | One user, private network |
| E10 | Data repo pushed to a private remote after each commit | Local git only | Backup; sync in offline mode |
| E11 | Extra fields in `usage.jsonl`, one line per call that reports usage | `{date, kind, model, usage}` | Cost per role, engine, level, cold or warm |
| E12 | Importers for Claude Code, Codex and ChatGPT history | OptMem import only | Seed memory with past work, as pi-optchat does |
| E13 | Effect for I/O, concurrency, cancellation and schemas | Bun built-ins and `node:` only, no dependencies (ref §15) | Structured cancellation and process cleanup replace the reference's hand-built hooks; typed failover |
| E14 | Fold kernel in Bend 2, compiled to JavaScript, with proved laws | TypeScript, tested only on synthetic merges (ref §16.8) | The fold is where OptChat's subtle bugs live; proofs on every edit instead of a few tests |
| E15 | The WebSocket speaks AG-UI events; the web UI is our own session store over them, with shadcn chat components and AI Elements | Terminal output only (ref §10) | A standard protocol for multi-client turns and offline UI fixtures; TanStack AI's client didn't fit a server-owned log (M2), so the store over the same events is ours |
| E16 | Non-Claude master turns run our own tool loop with read-only tools (Read, Glob, Grep on the device; zoom and date from memory); a failover mid-turn hands the next engine what the first logged | `claude -p` and its tools only (D1) | A fallback turn can answer from files and memory without being able to change them; nothing logged is repeated or lost |
| E17 | A turn never waits for priming: it stops one in flight and never primes first; priming runs only while idle | The turn awaits `prime(view)` (ref §6, gist §8) | Measured: the wait (2.6 s on a fresh `claude`) never shortens the time to the first token; it only spares one cache write, i.e. plan quota |
| E18 | One warm `claude` per expected spawn (the master's turn and priming on the Mini), handed out only to a byte-identical spawn | A fresh process per call (ref §5) | `claude`'s boot is ~1.3 s of each turn; measured median time to first text 1,990 → 1,160 ms |

## Milestones

Each milestone ends with `bun test` green, the parity test passing, and a short note in this doc of what was measured. M0–M2 follow the reference's own build order (ref §12); the rest is ours.

1. **M0, core parity.** Repo, Effect setup, schemas, and a one-day spike calling Bend's JS output from TypeScript. Store, tree, view, pump with a fake compactor; OptMem import; `view` CLI. Done when the parity test matches the reference byte for byte on a fixture log.
   - *Measured (2026-10-05, Bend 2.0.35, Bun 1.4.2, effect 4.0.1).* `bend kernel.bend -o kernel.mjs` gives an ES module whose default export Bun calls directly: constructors cross as `{$: "Name", …}`, Nats go in as numbers and come back as bigints, and Base's arithmetic compiles to native operations. Non-tail recursion over a list overflows the JS stack between 20k and 40k elements, so every walk over a view or a log is tail-recursive (a test runs a 100k-line view). All ten laws in `kernel/LAWS.bend` check, also under `--verdict`; their vocabulary (siblings, merge, size, start, width, built-before) is defined from Base, not from the kernel's own functions. `test/kernel.test.ts` checks the kernel against a literal model of gist §4.1/§5.2 on seeded random runs, and the parity fixture (900 messages, 764 view lines) gives the same log, tree and `optchat view` bytes from both CLIs on both data dirs. Refold of a fully built tree: 0.10 s at 2,300 messages, 0.84 s at 20k, 3.6 s at 60k (the reference reports 20 ms at 2,300); 100k messages with nothing to merge: 0.15 s, since refold skips `fit` when the view is within budget or nothing in it can merge. One `fit` takes 1.2–1.6 ms and one rule-3 pass 3–54 ms. At 100k messages one pump kick costs about 290 ms of synchronous work (`offers` 117 ms, `first` 44 ms, `buildFree`'s scan for free nodes 125 ms), and the startup refold of a fully built tree 6.3 s; both are rebuilt from scratch on every call. An OptMem import writes every note, builds the free nodes, then folds the view once: 10k notes in 5.6 s, one fsync per line included (refitting after each note took 47 s).
2. **M1, Claude turns on the Mini.** `claude-code` compactor and turn, priming, HTTP MCP, the REPL talking to a local server. Re-run the reference's probes (ref §14 P1–P8) on our Claude Code version, plus one for E6: 1-hour marks on real turns and priming, no ordering errors. Done when I chat from the terminal for a day on real work.
3. **M2, server and web UI.** AG-UI events over the WebSocket, the Vite app with chat, memory and stats screens, Tailscale serve, launchd, git push. Started with a one-day spike: two browsers on one turn, one sending a mid-run message, through TanStack AI's WebSocket adapter (it didn't fit; see the open question). Done when I chat from the phone.
   - *Built (2026-10-05, @ag-ui/core 1.0.0, React 19.3, Vite 8, Tailwind 4.3).* `web/`: the four screens, a PWA, dark and light, checked at 360 px. The first build ran TanStack AI's `useChat` over our own connection adapter; review found that its message model can't hold a server-owned log (see the open question), so the chat now reads our own session store (`web/src/lib/log.ts`, `session.ts`) over the same AG-UI events, and `@tanstack/ai*` are gone. A reconnect after the window moved past the older pages a phone had loaded fetches the hole between them (up to 500 entries; past that the older pages are dropped), so the chat never shows a gap. Shiki (Streamdown's code highlighting and the tool input's Code Block) loads with the first code block, from `assets/lazy/` like every chunk only an `import()` reaches; the shell the service worker precaches went from 1.4 MB to 1.07 MB. End-to-end tests start one server per test, so none leans on another's log. Gaps: no day separators (snapshot messages carry no dates), the Terminal drops ANSI escapes instead of colouring them, a note logged mid-run shows as a user message until the run's snapshot, and the Devices screen shows the config only until the device runner (M4).
4. **M3, ChatGPT-plan compactor.** `openai-plan` engine, per-level chains, the bake-off. Done when the level cutoff is set from bake-off data.
   - *Built (2026-10-05), not yet measured.* `optchat login openai` runs Sign in with ChatGPT: PKCE (S256), `state` and `nonce`, a one-shot callback on `http://127.0.0.1:1455/auth/callback`, the code exchanged with the client id the callback names, the ID token's issuer, audience, expiry and nonce checked (its signature is not: it comes straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 allows); a callback with another `state` gets a 400 and the sign-in waits on. The Keychain holds one small JSON secret: the refresh token, the issued client id, this machine's `ext_agent_host_id` and the account's subject and email, well under the 4,096-byte line `security -i` reads (a test checks it with 2 KB JWTs). Access and ID tokens stay in memory: a process refreshes when it first needs a token, two minutes before expiry and once on a 401, one refresh at a time since each rotates the refresh token; a refreshed ID token must name the same account. If the rotated refresh token can't be saved, the process keeps it in memory and says so. Nothing saved, or a refresh token refused (400 `invalid_grant`, 401), moves the compactor to the next engine; a token endpoint that fails, a store or secret that can't be read is a reported model error, not a failover. Every endpoint, the port and the client id are configurable (`openai` in `optchat.config.ts`). `src/openai/responses.ts` streams the Responses API and reads the SSE events with Schema: text deltas, `response.completed` with usage (cached tokens become `cacheRead`, so `cold` works as for Claude), `response.failed`, `response.incomplete`, `error`, refusal deltas. `src/summarize/openai-plan.ts` is the compactor; `src/summarize/step.ts` holds what both compactors send (context pieces, step, retry text, cut, shortest try) and the size retries themselves; each engine adds only its transport, and every try with known usage gets its `usage.jsonl` line, failed ones included; a try that fails before it reports usage (HTTP 429 or 5xx, the network, the token) gets none. A failover is reported once when an engine goes down and once when a call started after that answers on it again (a call already in flight proves nothing); the compactor also lists the engines down right now, with why, for clients that connect later. The session state carries that list as `down` (from `makeSummarize`'s `down`, given to `makeSession` as `compactorDown`), and each such notice publishes the state again, so a client that connects after a failover still sees that compaction fell back, and why. `optchat.config.ts` now runs Luna below level 3 and Sol from 3, each falling over to `claude-code:sonnet`, so nothing changes until the login. `dev/bakeoff.ts` replays messages from a data dir or an OptMem `LOG.txt` through each chain into its own temp data dir and reports tries per node (mean, p95: every model call logged for the node, size retries, failed calls and calls after a failover included), nodes left unbuilt at its deadline (2 hours per contender by default), calls and tokens per message, failovers, nodes over 512 bytes, user's words kept (the share of the user's sentences of four words or more that still have four words in a row verbatim in their node at levels 0, 2 and 3, plus the mean share of such runs kept), and findability (fill-in-the-blank questions from the user's sentences, answered from the view and zoom; the answerer in the box is a lexical descent with no model, and a model-backed answerer takes the same type). All of it is tested offline against fake OAuth and Responses servers and fake compactors. Still to do: the real login, one real compactor call to confirm the route's shape, then the bake-off over ~500 real messages for Luna, Sol, Sonnet and a split, and the cutoff from its numbers.
5. **M4, MacBook as a device.** Device runner, routing, the device screen. Done when one chat edits files on both machines.
   - *Built (2026-10-05).* `device/` is the runner: one WebSocket per process (`GET /spawn`, a handshake being a GET; the spawn request is the first frame), JSON frames tagged `Spawn`/`Stdin` in and `Spawned`/`Refused`/`Line`/`Exit` out. A process lives as long as its socket: a disconnect, the daemon's SIGTERM or the end of the request kill its process group, SIGTERM then SIGKILL after `KILL_GRACE` (tested with a child that ignores SIGTERM, and through `device/main.ts` under SIGTERM). The runner and the local runner start `claude` through one `spawnProcess` (`src/claude/process.ts`), so exit codes, signals and stderr read the same from both. Machine auth: the runner listens on `tailscale ip -4`, refuses requests with an `Origin`, and asks `tailscale whois --json` for each caller (cached, bounded), letting in nodes whose full MagicDNS name is another configured device's; `OPTCHAT_DEVICE_TRUST=loopback` lets in local callers only, for development. `RemoteRunner` (`src/claude/remote.ts`) feeds the same `makeClaude` as the local runner. Everything up to the `Spawned` frame (no runner, a refusal, a socket dropped, no answer in 15 s) is `DeviceOffline`, so the chain can fail over, and an unreachable device is remembered for 5 s; a connection lost after that ends the turn with a `ModelError`, since the turn may have changed files by then. The server's own device keeps the local runner; for others, `--system-prompt-file` is sent inline as `--system-prompt` (same bytes, same cache key), the cwd goes unexpanded so `~` is the device's home, and `--mcp-config` points at `server.publicUrl` with the same secret key (E8); without `publicUrl`, turns on other devices are refused. `/api/devices` asks each `/health` with a 2 s timeout, reports online, offline or refused, and posts an `info` once per set of differing `claude` versions among online devices. launchd templates are in `deploy/`. Not done: the web UI's device screen (the `/api/devices` data is there), and a live two-machine run over a real tailnet. Follow-up: pass `--system-prompt` inline on every device, the Mini too, so "same bytes" holds by construction rather than by inlining a file.
6. **M5, failover.** Master chain to Sol with our own tool loop (read-only tools first), API-key overflow with a budget. Done when exhausting the Claude limit in a test switches engines without losing a message.
   - *Built (2026-10-05), not yet measured.* `src/turn/loop.ts` is our own tool loop, shared by `openai-plan` (`src/turn/openai-plan.ts`) and `api-key` (`src/turn/api-key.ts`) as the master: the same system prompt text as `claude-code` (`instructions` on the Responses API, `system` on Anthropic), one user message of the view blocks and the new texts, the read-only tools (Read, Glob, Grep on the turn's device, through its runner's `POST /tool` or in-process; zoom and date answered from memory with the gist's descriptions) as function definitions, text deltas streamed live, text logged as `talk`, calls as `tool` "name json", results as `echo` capped at `CAP` (the model sees the same capped text), one usage record per request with `failoverFrom`. Mid-run messages offered to the call join after the current tool results, logged as `user` when taken; the turn ends at the first reply with no calls, and the 40th request (`TOOL_ROUNDS`) is sent with tool choice `none`. The Responses client gained function tools and an API-key bearer instead of a second client. `api-key` is Anthropic's Messages API (raw HTTP through Effect's client, like the rest; thinking blocks sent back with their signatures, effort as `output_config.effort`) or OpenAI's Responses API with a key, both as master and as compactor; keys come from Secrets (`optchat key anthropic|openai`). Anthropic's marks go on the first user message's stable blocks (the view, or a compactor's context pieces), one TTL each from `cache.apiKeyTtls`, which the config refuses unless every `1h` comes before any `5m` (at most 4). Prices per model ($/MTok for input, output, cache read, cache write per TTL; Anthropic's `usage.cache_creation` splits writes by TTL, and an unsplit write is priced at the dearer rate) give each record its `dollars`; a monthly budget sums this local month's api-key dollars from `usage.jsonl` once, keeps the sum in memory, and from the call that finds it spent fails every api-key call with `UsageLimit` and one `info` ("API-key budget for 2026-10 spent: $x of $y"). No `apiKey` block, no price for the model, no key, a signed-out plan: each is a `UsageLimit`, so the chain moves on and ends with a notice. `optchat.config.ts` runs `claude-code:opus` → `openai-plan:gpt-6.1-sol` → `api-key:anthropic/claude-opus-5-5`, $20 a month, with placeholder prices to verify. Tested offline: the done-criterion through the real server (a spent Claude plan on the MacBook device → openai-plan streams a reply after a Read through the device runner; the message answered once; `failoverFrom` in `usage.jsonl`; the `info` on the client), a mid-run message joining before the next request, a limit after partial output handing it on, the tools' folder boundary, and the api-key marks, prices and budget against a fake Messages API. Still to measure with real accounts: whether the plan route accepts function tools and `tool_choice` as the public Responses API does (and whether Sol needs its reasoning items sent back between rounds; with `store: false` we send none), the real Sol and Opus 5.5 model ids, real prices, cache hit rates on api-key turns, and how a real Claude Code reports a spent plan mid-turn (we match `usage limit` in the result text). Not done: write tools (Bash, Edit, Write), WebFetch and WebSearch on non-Claude engines; the budget check is not atomic across the compactor's 8 parallel jobs, so a month can overshoot by a few calls.
7. **M5.5, capability gateway.** The master gets the user's real capabilities (project repos, Cloudflare, PostHog, Gmail, …) through one code-mode gateway, preferably [Executor](https://executor.sh/), instead of one MCP server per capability. Reasons: dozens of MCP servers would put hundreds of tool schemas in every turn and change the cached prefix whenever the set changes (E6), while behind a gateway the master sees a fixed few tools (search, execute) plus our own `zoom` and `date`; a script filters big results (PostHog queries, Cloudflare listings) before the model reads them; and every engine gets the same capabilities (E4) — `claude` through `--mcp-config` with the binary unmodified, our own tool loop (M5) through the same two tools — so a failover changes the model, not what it can do. Memory and file tools (`zoom`, `date`, Read, Glob, Grep) stay direct tools: each step there depends on reasoning about the last result, so a script would not save rounds; code mode pays where the steps are mechanical (many tools, big structured results, fan-out). Starts with a spike: does Executor self-host on the Mini, how is its sandbox isolated, where does it keep credentials (Keychain, never the data dir). Guardrails before any production capability: per-server allowlists, read-only by default, destructive operations (deletes, deploys) behind an explicit flag, and every executed script logged next to `usage.jsonl`. Done when a turn on each engine answers a PostHog and a Cloudflare question through the gateway, and `usage.jsonl` shows requests per turn and tokens per turn against direct MCP.
8. **M6, offline mode.** Streams per device, pull and push around turns, read-only `<chat who=…>` views, `who` on zoom and date, `grep`.
9. **M7, subagents.** Gist §9 `spawn` and `tell`; restore MASTER's subagent paragraph, which drops D5. D10 stays: background shell tasks still die with the turn.

Later, unscheduled: layout B for the compactor (ref §7), media in a content-addressed sidecar (as hermes-optchat), and the importers (E12).

Follow-ups after M5 (held back so the M1–M5 branches merge cleanly):

- An engine-ref registry: one place that turns `engine:model` into a turn or compactor engine, instead of the parsing in `server/app.ts` and `src/summarize/`.
- Split `server/app.ts` into route modules (`/ws`, `/mcp`, `/api/*`, static files).

## Open questions and things to measure

Each of these is checked in the milestone named; a result that breaks the design stops work, as in ref §15.

- [x] **Repo name.** Decided: optchat-du-jour. A fresh view every turn.
- [x] **M0:** can Bend 2's JavaScript output be imported and called cleanly from TypeScript under Bun? Yes (see M0's note); the kernel stays in Bend.
- [ ] **M1:** do 1-hour marks hold on real turns and priming without ordering errors, and do they cut cold turns as expected? (Alternative: start faithful at 5 minutes and switch only once the numbers show cold turns.)
- [ ] **M1:** is a view primed from the Mini read by a turn on the MacBook? Same account and Claude Code version should give the same cache key; unmeasured.
- [ ] **M1:** whether a priming request killed at `message_start` counts against plan limits (ref §14 F6 was inconclusive for billing).
- [ ] **M1:** the pump's cost at large T (M0's note: ~290 ms per kick and a 6.3 s startup refold at 100k). Plan: a per-level cursor for `offers` and the free-node pass, so a kick looks only past what it already saw, or keeping the kernel's view list in `mem` instead of rebuilding it for every call.
- [x] **M2:** does TanStack AI's WebSocket adapter really let several clients watch one server-owned run and send mid-run messages? Not as shipped (`@tanstack/ai-client` 0.36.1): `webSocket()` opens its socket only inside `send()`, so a client that only watches never connects, and a close without durable offsets fails the subscription instead of reconnecting. `useChat`'s `sendMessage` also queues a message while a run streams (so a mid-run message would wait for the run to end instead of being steered into it) and shows it under a client id next to the server's logged copy. `useChat({ live: true })` over our own `SubscribeConnectionAdapter` got further (it connects at once, reconnects, rebuilds from each `MESSAGES_SNAPSHOT`), but its message model doesn't keep our ids: its stream processor attaches a `TOOL_CALL_START` to the assistant message in progress and renames pending messages, so a row's id drifted mid-turn (a tool row's open state reset, "show in chat" landed on the wrong row), and its window couldn't be merged with older pages without losing the stretch between them. What ships: our own link (`web/src/lib/connection.ts`) and session store over the same AG-UI events, keyed by log index; messages and aborts go straight to the socket, and the composer keeps its own unlogged messages in the Queue until the server's `ack` for their id.
- [x] **M2:** do AI Elements' components work cleanly once their AI SDK type imports are replaced (tool states, message roles)? Yes, after cutting them down: Tool takes our three states (running, done, ended), Context counts bytes instead of tokens (no tokenlens) in a popover a phone can open, Prompt Input keeps text only, Message keeps MessageResponse and the action buttons (shadcn's chat components do the layout). The registry's `ansi-to-react` didn't survive Vite's CommonJS interop and was dropped.
- [x] **M3:** where `compact.txt` goes on the ChatGPT-plan route, which rejects `system` messages: `instructions`, or the first user block? `instructions`: OpenAI's docs for the route say so ("Messages with the `system` role are rejected. Use `instructions` instead"), and they also rule out `temperature`, `top_p`, `max_output_tokens`, `metadata`, `truncation`, `user` and `previous_response_id`. Not yet seen on the wire with a real token.
- [ ] **M3:** whether OpenAI's automatic prefix caching counts against plan limits at a discount; and whether it stays warm across compactor bursts.
- [x] **M3:** does pi-ai already ship a ChatGPT-plan provider we can read for the OAuth details (Pi was a launch partner)? Yes, by others' account (orbi-build/orbi#1510): pi 0.99.1's `openai` provider has an "OpenAI (ChatGPT subscription)" OAuth mode on `https://api.openai.com/v1`, with dynamic client registration, PKCE and serialized refreshes, and it strips `max_output_tokens`, `temperature` and `prompt_cache_retention`. We didn't need its source: OpenAI publishes the flow (developers.openai.com/siwc/token-sharing-open-source). It differs from Codex CLI's older login, which uses a fixed client id and `chatgpt.com/backend-api/codex/responses` with a `chatgpt-account-id` header; the new route needs only the bearer token as far as the docs say.
- [ ] **M3:** which model ids the plan token offers (the docs say to list them with the token first); we configured `gpt-6-luna` and `gpt-6.1-sol` from OpenAI's docs and examples. Also whether the route accepts `reasoning.effort` (we send the compactor's `effort`; the docs don't list it among the rejected fields).
- [ ] **M3:** Luna's quality on level 0: retries per node, and how much of the user's own wording survives.
- [ ] **M2:** is Max 5× enough for main turns? Decide after two weeks of `usage.jsonl`, together with cancelling Cursor.
- [ ] **Policy:** Anthropic expects subscription use to be ordinary, individual use of Claude Code. A personal harness on my own machines driving the unmodified binary fits that reading, but continuous background compaction would not, which is one more reason the compactor runs on the ChatGPT plan and touches the Claude plan only as a fallback.
