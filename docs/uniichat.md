# UniiChat, and what we take from it

[UniiChat](https://github.com/VictorTaelin/uniichat) is Victor Taelin's own OptChat: the code behind docs/optchat.md, open-sourced under Apache-2.0 (Copyright 2026 Higher Order Company). We read it and port ideas, written in our own style; we copy none of its code or text. [NOTICE](../NOTICE) credits what we took.

**Pinned:** `0500bf6` (`0500bf6a8ea4bf0ce047488562022b1b6532cc30`), 2026-10-19. Everything below compares that commit with our main at `4be9d68` (M7a). The comparison was four reports, one each on the memory core, the model engines, agents and devices, and the clients and protocol. This file keeps what they found, and how far we got. M7b (E36–E40) has since ported its subagents' power, waking and resume; the summary below is as of the pin.

## What it has, what we have

The core design is the same on both sides: append-only day files, the 512-byte binary tree, the 64–128 KB sawtooth view with due measured from each pair's last message, 4-line blocks with one mark, and a 16–32 KB compaction view. Its code has moved past the gist in a few places (64 compactor jobs, compactions without tools, stateless size retries, `high` effort, the "small, mechanical job" paragraph), so docs/optchat.md may change.

What UniiChat has that we didn't:

- **Robustness.** A summary the model refuses, or leaves empty, becomes its source, clipped, instead of blocking every later turn. Outages are retried inside the call (8 tries for a turn, every 60 s for ever for a summary), with `retry-after`, `x-should-retry` and idle watchdogs. A WebSocket heartbeat lets a client notice a dead socket. The server strips its keys from the environment before anything runs.
- **Cost.** Single flight keyed on every block prefix, aware of TTLs, for every call. Compactions without tools. Size retries that never send back the long line or its thinking. A prompt paragraph that keeps the compactor brief. A cache-replay test against a fake Anthropic: turns read 98.6% of their input from cache, compactions 96.4%, with gaps under 4 minutes.
- **Scale.** An on-disk slot index, so RAM holds only the view, and long messages logged and zoomed in 30,000-character pages.
- **Product.** Importers for Claude Code, Codex, claude.ai and ChatGPT history. Writing subagents on any open device, and computer use. A chat whose transcript *is* the view, with summaries that open in place. A good terminal UI, an iOS share extension, push notifications, exactly-once client actions.

What we have that it doesn't:

- **Proofs and parity.** The fold kernel in Bend with proved laws, the push-equivalence test, and byte-for-byte parity with the reference. Its only view test is the cache replay.
- **Data.** A reference-compatible data dir, one fsync per line, and a view that is validated and caught up at load.
- **Engines.** Claude Max through the `claude` binary (1-hour cache entries, idle priming, warm processes), the ChatGPT plan through Sign in with ChatGPT, per-level compactor chains with failover, a fail-closed monthly budget, and `usage.jsonl`. UniiChat is API-key only and, self-hosted, caps and logs nothing.
- **Safety.** Read-only subagents with a cap, reports that never start a turn, bounded contexts, a tailnet WhoIs boundary for devices, confined read-only tools, Host and Origin checks.
- **Client.** Steer or queue with take-back, a model and a device per message, resume after a limit, Background work, subagent cards, Plan, Reasoning, Sources, video, Stats.

## The backlog

Each item is **ported** (in our code now, with its E-number in SPEC), **planned**, or **declined** with a reason.

### Ported

| Item | Where | Notes |
| --- | --- | --- |
| A refused or empty summary becomes its source, clipped | E33, `src/compactor.ts`, `src/tree.ts` `clippedText` | After `REFUSALS` (2) answers with no line, not UniiChat's one: a safeguard that refuses once may pass the second time, and a waiting turn loses at most one `WAIT_RETRY`. An empty reply counts only when it ended as it meant to: one cut short by its token limit or the context window is a limit, as UniiChat's "its input's doing" means. A merge clips each half to 255 bytes, so its second half isn't dropped as it is in UniiChat. The tree line says `clipped: true`, so a later pass can rebuild it |
| Transient failures never retried in a hot loop | E33, `src/compactor.ts` `rest` | A logged entry tries a failed call again only once it has rested `WAIT_RETRY`, and the pump tries it again itself once it has rested, between messages too, each failure in a row doubling the rest up to 5 min; a message reaching the session, and a waiting turn's retry, still try at once. UniiChat waits 60 s inside the call instead; we keep failover across plans |
| No provider keys in a spawned `claude` | E34, `src/claude/process.ts` `childEnv` | UniiChat's server removes its own keys from the environment. We drop `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the Bedrock, Vertex and Foundry settings, the base URLs and the default-model overrides from every `claude`, the device runner's included |
| A WebSocket heartbeat | SPEC "Protocol", `server/routes/ws.ts`, `web/src/lib/connection.ts` | The server sends a connection the state every 5 s when nothing else went out (a `STATE_DELTA`, which every client decodes, unlike UniiChat's bare `"+"`); the web link drops a socket silent for 10 s. UniiChat's frames are a view of at most 128 KB; our opening snapshot can be megabytes, so a socket that opened but never delivered a frame goes on the backoff and the next open socket gets a window twice as long, instead of being reopened at once; a hung handshake keeps 10 s, so a dead network is back within about 20 s |
| Subagents with the master's power | E36, `src/subagents.ts`, `src/engines/registry.ts` `subagentPolicy` | UniiChat's agents get shell, read, write and edit on any open device. Ours get the master's permission mode and tools (Bash, Edit, Write, WebFetch, WebSearch on `claude-code`, the device tools on our tool loop, the artifact tools too), on any configured device through the runner a turn there uses (`spawn`'s `device`), in any of its folders (`folder`). Unlike UniiChat's: at most `SUBAGENTS_MAX` (4) at once, every level counted, and the device runner keeps its tailnet WhoIs boundary |
| Subagents that work directly in a folder, with nothing waiting on a merge | E36, E37, `src/worktree.ts` | As UniiChat's do, by default; `isolate: true` adds what UniiChat has no answer for, a git worktree of its own merged back off the folder's working tree when a run ends cleanly, kept with a reason in the report when it can't be |
| A report starts a turn | E39, `src/session.ts` `wakeWith` | UniiChat's report is a `work` message that starts a turn. Ours waits `WAKE_DEBOUNCE` (2 s) so a burst of reports is one turn, never wakes for a run the user stopped or after Stop all, and pauses after `WAKE_LIMIT` (8) woken turns in a row with no user message; `subagents.wake: false` turns it off. A report that comes mid-turn waits for the turn to end rather than entering the running call |
| Subagents go on after a restart | E40, `src/subagents.ts` `restore` | UniiChat tells every agent the server restarted. Ours resume oldest first within the cap, from the side log, at most `RESUMES_MAX` (2) restarts in a row with no call completing; a call cut short by a dropped device link goes on after `LINK_WAIT`, at most `LINK_TRIES` (3) times a run |
| Stop all, for turns and subagents | SPEC "Subagents", `server/routes/ws.ts`, `web/src/chat/background-work.tsx` | One button cancels the turn and stops every subagent, and hushes their reports until the user's next message |
| Retries on our own HTTP engines, with idle watchdogs | E35, `src/engines/retry.ts` | 4 tries rather than 8, since a failover chain or the user's resume stands behind ours. `retry-after`, `retry-after-ms` and `x-should-retry` are heeded, and the pauses have jitter. Whether a failure may pass is decided where it is classified and carried on the error. A try whose text already went out is never asked again. What failed tries cost is carried to whatever ends the call, and openai-plan's 401 renewal is one of the tries. The idle values are UniiChat's: 5 min on Anthropic, 20 min on OpenAI |

### Planned

The first group was left out of the robustness PR on purpose.

| Item | Why it waits |
| --- | --- |
| The compactor's "small, mechanical job" paragraph (`prompt.txt:91-96`), reworded | It changes the system prompt, so the cached prefix of every turn and compaction is written once more. It goes in a separate cache change, measured in the bake-off |
| Compactions without tools, when the compactor's model isn't the turns' | Changes the compactor's prefix and departs from docs/optchat.md §4 and §7 mistake 6. Same cache change, measured first with the cache-replay test below |
| Single flight on every block prefix, with TTLs (`AskAI.keys`, `AskAI.wait`) | `src/engines/inflight.ts` waits only on an exact key. Needed before raising `JOBS` toward UniiChat's 64 |
| Paged `zoom(id, 1, at)` and a bounded leaf input | A 200 KB paste is one leaf and one zoom answer today. Adding `at` changes the cached tool list once |
| Importers: Claude Code, Codex, claude.ai and ChatGPT exports (E12) | Decide where imported messages go (before the chat, not at its end as UniiChat does), how imported AI turns show without breaking E23, and a pausable compaction side |
| Exactly-once client actions | A message sent on a socket that dropped is marked "send it again"; UniiChat resends unacked acts and answers a repeated id once. Needs ids known server-wide |
| The live Memory view in the chat | UniiChat's transcript is the view, with summaries that open in place and fill in live. Ours: the raw log, plus a Memory tab reloaded by hand |
| The terminal UI | Line editing, history, `/help` from the key table, markdown painted in the terminal's own palette |
| The iOS share extension | After an idempotent `POST /api/messages`, which also gives iOS Shortcuts |

Also planned, from the same reports:

| Item | Notes |
| --- | --- |
| A cache-replay test | Our version of `cache.test.ts`: fake Anthropic and Responses caches, gaps up to 2 h, api-key and claude-code layouts and the compactor engines. It turns the cost model into numbers and settles E6 and E26 |
| The REPL's own silence watchdog | Only the web link watches for the heartbeat so far |
| Paged snapshots on `/ws` | The opening and run-end `MESSAGES_SNAPSHOT` hold up to 200 raw entries, megabytes at worst, which no heartbeat can cut into. Bounded by bytes, with the client filling the rest from `/api/messages` pages as it already does for holes, no frame would outlast a beat; the link's growing window covers slow links until then |
| Saying "busy, asking again in N s" | A turn on our tool loop waits through its retries silently |
| Rebuilding clipped nodes | Find the `clipped: true` lines and ask again, for instance after a model change |
| Size retries without the previous reply | A bake-off arm first, against our same-conversation retries |
| Compactor effort `high` rather than `xhigh` | A bake-off contender |
| Budget hardening | Bill a stream cut short by the bytes it streamed; reserve worst-case spend for concurrent calls; read OpenAI's `cache_write_tokens`; a long-context price tier |
| Rate-limit rooms | Under a 429 storm, one request probes while the others wait; chats ahead of imports |
| Small client items | A `?wire=N` version check, Esc or an empty Enter to stop, long pastes folded, diffs for Edit and Write calls, push at the end of a turn, a turn cut by a restart resumed with a note |
| Smaller core items | Write `view.json` only on a batch; later, the slot index so RAM holds only the view |

### Declined

| Item | Why |
| --- | --- |
| Clip at the first refusal | One more try, `WAIT_RETRY` later, costs little and lets a flaky safeguard through (E33) |
| On a refusal, try the next engine in the chain | A refusal isn't a reason to change who pays (E4), and the watcher would report a working plan as down |
| Summaries retried every 60 s for ever, with no failover | Our compactor fails over to another plan now, which is faster for the turn that waits |
| 8 tries up to 128 s for a turn | Behind ours stands the failover chain, or the user's resume |
| 64 compactor jobs | Without single flight on block prefixes it mostly means more cache writes. Revisit after that |
| Fast mode, `service_tier`, a per-chat speed | No plan supports them, and they cost twice as much |
| Its data format: kinds `unii`, `work`, `ai`; act-only lines; `*.index` files; its `view.json` | Our data dir stays the reference's (E23). Its loader also crashes on our `view.json` |
| Group commit with one `syncfs` per batch | Ours, one fsync per line, is stricter, and the volume is small |
| Devices as open terminals, with an unconfined shell, `write` and `edit` on any path | A session cookie becomes remote code execution on every open machine. Ours: a tailnet WhoIs boundary and confined folders |
| Computer use | Not now; if wanted, as a per-device MCP server for a claude-code turn |
| Unbounded agent logs and unbounded `spawn` | Ours cap both: side logs as E30 has them, running subagents at `SUBAGENTS_MAX` (E36) |
| A lease or a lock per folder for subagents | The user chose power over caution: subagents work directly, kept apart by Claude Code's refusal of an edit to stale text and by each call naming the others in the same folder, and `isolate: true` gives a worktree when that isn't enough (E36, E37) |
| Hosted-service machinery: accounts, magic links, billing, per-network rate limits, handover deploys | One user on a tailnet |
| Telemetry to a third party | None |
| Voice through a server-side transcriber | The phone's keyboard dictates. A desktop mic would use our local whisper |
| One model pick per chat, its own markdown parser | Ours are per message (needed for failover and resume), and Streamdown |

## How to re-diff

1. Fetch UniiChat: `git -C <uniichat> fetch origin`, or clone `https://github.com/VictorTaelin/uniichat`. Never inside this repo, and never install its dependencies here.
2. See what changed since the pin: `git -C <uniichat> log --oneline 0500bf6..HEAD`, then `git -C <uniichat> diff 0500bf6..HEAD`. The files behind this backlog are `Memory.ts`, `AskAI.ts`, `Agent.ts`, `Anthropic.ts`, `OpenAI.ts`, `Config.ts`, `Server.ts`, `View.ts`, `Tools.ts`, `Machine.ts`, `Import.ts` and `prompt.txt`.
3. For each change, find the backlog rows that cite it: re-check a ported item whose upstream rule moved, add a row for anything new, and move rows between planned and declined when the reason changed.
4. Update this file: the pinned commit and its date at the top, the summary if it no longer holds, and the backlog. A newly ported idea gets its E-number in SPEC and a line in NOTICE.
