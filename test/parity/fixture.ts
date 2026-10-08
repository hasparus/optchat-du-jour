// The parity fixture: a deterministic stream of messages shaped like a coding session, and a
// deterministic fake compactor whose lines depend on everything a real one sees (the context,
// the level, the source), so a difference anywhere upstream shows in the view.
export type Kind = "echo" | "talk" | "tool" | "user";
export type FixtureMsg = { readonly kind: Kind; readonly text: string };
export type Job = { readonly ctx: readonly string[]; readonly i: number; readonly l: number } & (
  | { readonly a: string; readonly b: string }
  | { readonly msg: { readonly kind: string; readonly text: string } }
);

const WORDS = ["view", "fold", "zoom", "merge", "store", "lock", "fsync", "pump", "kernel", "läuft", "naïve", "日本", "test", "commit"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function words(r: () => number, n: number) {
  const picked: string[] = [];
  while (picked.length < n) picked.push(WORDS[Math.floor(r() * WORDS.length)] ?? "");
  return picked.join(" ");
}

export function fixture(count = 900, seed = 42): FixtureMsg[] {
  const out: FixtureMsg[] = [], r = rng(seed);
  while (out.length < count) {
    out.push({ kind: "user", text: words(r, 1 + Math.floor(r() * (r() < 0.2 ? 400 : 30))) });
    const tools = Math.floor(r() * 4);
    for (let t = 0; t < tools; t++) {
      out.push({ kind: "tool", text: `Bash {"command":"${words(r, 2 + Math.floor(r() * 6))}"}` });
      const big = r() < 0.1 ? 3000 : 60;
      out.push({ kind: "echo", text: `${words(r, 1 + Math.floor(r() * big))}${r() < 0.3 ? "\nline two\r\nline three" : ""}` });
    }
    out.push({ kind: "talk", text: words(r, 3 + Math.floor(r() * 80)) });
  }
  return out.slice(0, count);
}

const hex = (s: string) => Bun.hash(s).toString(16).padStart(16, "0");

export function fakeSummary(job: Job): string {
  const source = "msg" in job ? `${job.msg.kind}: ${job.msg.text}` : `${job.a}\n${job.b}`;
  const h = hex(`${job.l}|${job.i}|${job.ctx.join("\n")}|${source}`);
  const r = rng(Number.parseInt(h.slice(0, 8), 16));
  const tag = "msg" in job ? job.msg.kind : "work";
  return `${tag}: ${job.l}+${job.i} ${h} ${words(r, 20 + Math.floor(r() * 50))}${r() < 0.2 ? "\nsecond line" : ""}`;
}

// The lagging replay (SPEC "Parity test"): the compactor runs behind the log, as it does in a real
// session, instead of catching up after every message. Messages go in batches without waiting;
// between batches the driver lets a few compactor calls finish, one at a time, and a call fails
// when `failsOn` says so for its node and attempt, then rests RETRY_MS before its retry. Each
// driver passes `gate().call` as its compactor (one job at a time) and releases calls with
// `release`, which waits on the pump's state, never on the clock.
export const RETRY_MS = 2;
export type Lag = { readonly batch: readonly FixtureMsg[]; readonly calls: number };

// long enough that the view is well over budget, so fit merges while the compactor lags
export function lagging(count = 1400, seed = 7): Lag[] {
  const all = fixture(count, seed), r = rng(seed), out: Lag[] = [];
  for (let at = 0; at < all.length; ) {
    const n = 1 + Math.floor(r() * 12);
    out.push({ batch: all.slice(at, at + n), calls: Math.floor(r() * 10) });
    at += n;
  }
  return out;
}

// about one call in five fails the first time, one in twenty the second, none after that
export function failsOn(l: number, i: number, attempt: number): boolean {
  if (attempt > 2) return false;
  const roll = Number.parseInt(hex(`${l}|${i}|${attempt}`).slice(0, 8), 16) / 2 ** 32;
  return roll < (attempt === 1 ? 0.2 : 0.25);
}

// The compactor both drivers run: each call waits until the driver releases it, then answers
// fakeSummary(job) or fails as scripted. `waiting` is the call in flight, if any; `calls` names
// every call in order ("l:i/attempt"), which the two implementations must agree on too.
export function gate() {
  const tries = new Map<string, number>();
  const calls: string[] = [];
  let waiting: { readonly job: Job; readonly go: () => void } | null = null;
  const call = async (job: Job) =>
    new Promise<string>((resolve, reject) => {
      if (waiting !== null) throw new Error("two compactor calls at once: the drivers run one job at a time");
      const key = `${job.l}:${job.i}`;
      const attempt = (tries.get(key) ?? 0) + 1;
      tries.set(key, attempt);
      calls.push(`${key}/${attempt}`);
      waiting = {
        go: () => {
          waiting = null;
          if (failsOn(job.l, job.i, attempt)) reject(new Error(`scripted failure of ${key}, attempt ${attempt}`));
          else resolve(fakeSummary(job));
        },
        job,
      };
    });
  return { call, calls, waiting: () => waiting };
}

// The state the driver acts in: a compactor call in flight, or nothing left to build. With one
// job at a time both pumps start nothing else while a call runs or a failed node rests (it holds
// the slot), so logging or releasing now gives both implementations the same state to decide
// from, whatever the machine's load. Never a fixed sleep: a pump that hasn't started its next call
// yet, or a retry timer that hasn't fired, is simply waited for. A pump that does neither for a
// minute is hung, and fails the replay.
export async function settled(g: ReturnType<typeof gate>, caughtUp: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (g.waiting() === null && !caughtUp()) {
    if (Date.now() > deadline) throw new Error("the compactor neither called nor caught up for 60 s");
    await Bun.sleep(1);
  }
}

// Let the call in flight finish (false when there is none: everything is built), then wait until
// the next one is in flight or everything is built.
export async function release(g: ReturnType<typeof gate>, caughtUp: () => boolean): Promise<boolean> {
  await settled(g, caughtUp);
  const w = g.waiting();
  if (w === null) return false;
  w.go();
  await settled(g, caughtUp);
  return true;
}

// Where the two replays part (SPEC "Parity test"): the reference still merges by the first
// message at every message and node (E22), we by the last message in batches, so the views, and
// with them the compactor's contexts, summaries and rule 3's order, agree only until the first
// merge in either view. Before it every view is all level-0 lines, the same in both. `look` is
// called after each step a driver takes; `split` is how many calls had started and nodes been
// built at the last look that saw no merge yet.
export type Split = { readonly calls: number; readonly nodes: number };
export function watch(o: { readonly view: () => readonly { readonly l: number }[]; readonly nodes: () => number; readonly calls: () => number }) {
  let split: Split = { calls: 0, nodes: 0 }, merged = false;
  const look = () => {
    if (merged) return;
    if (o.view().some((c) => c.l > 0)) merged = true;
    else split = { calls: o.calls(), nodes: o.nodes() };
  };
  return { look, split: () => split };
}

// what a driver prints: every call in order ("l:i/attempt"), and where the views parted
export type Report = { readonly calls: readonly string[]; readonly split: Split };

// the lagging replay itself, for either implementation
export async function replayLagging(o: {
  readonly log: (m: FixtureMsg) => Promise<void>;
  readonly caughtUp: () => boolean;
  readonly gate: ReturnType<typeof gate>;
  readonly look: () => void;
}) {
  for (const step of lagging()) {
    await settled(o.gate, o.caughtUp);
    o.look();
    for (const m of step.batch) {
      await o.log(m);
      o.look();
    }
    for (let c = 0; c < step.calls; c++) {
      const more = await release(o.gate, o.caughtUp);
      o.look();
      if (!more) break;
    }
  }
  while (await release(o.gate, o.caughtUp)) o.look();
}
