// The same replay through the reference (REF: its checkout at the pinned commit), so both data
// dirs come from identical inputs: caught up, or lagging (`lag`) with fixture.ts's script. Only
// the reference's own openChat options are used (summarize, jobs, retryMs); nothing in its
// checkout is changed.
import { nodes } from "../../src/tree.ts";
import { fakeSummary, fixture, type FixtureMsg, gate, replayLagging, type Report, RETRY_MS, watch } from "./fixture.ts";

const [dir, mode, ref] = [process.argv[2], process.argv[3], process.env.REF];
if (!dir || !ref) throw new Error("usage: REF=<shitty-optchat checkout> drive-reference.ts <data dir> [lag]");

type Chat = { mem: { root: unknown[]; tree: Map<string, unknown>; view: { l: number }[] }; log(k: string, body: string): void; close(): void };
type Job = Parameters<typeof fakeSummary>[0];
type Options = { jobs: number; summarize: (job: Job) => Promise<string>; retryMs?: number };
// SAFETY: openChat's signature as the pinned reference commit declares it in src/chat.ts; the import
// is by path at run time, so there is nothing to type-check it against.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const { openChat } = (await import(`${ref}/src/chat.ts`)) as {
  openChat: (dir: string, o: Options) => Promise<{ chat: Chat }>;
};

// the reference keys its tree by "l:i"
const caughtUpIn = (chat: Chat) => () => nodes(chat.mem.root.length).every((c) => chat.mem.tree.has(`${c.l}:${c.i}`));

const watching = (chat: Chat, calls: readonly string[]) => watch({ calls: () => calls.length, nodes: () => chat.mem.tree.size, view: () => chat.mem.view });
const print = (r: Report) => {
  console.log(JSON.stringify(r));
};

if (mode === "lag") {
  const g = gate();
  const { chat } = await openChat(dir, { jobs: 1, retryMs: RETRY_MS, summarize: g.call }); // its failures go to its default report, which says nothing
  const w = watching(chat, g.calls);
  const log = async (m: FixtureMsg) => {
    chat.log(m.kind, m.text);
  };
  await replayLagging({ caughtUp: caughtUpIn(chat), gate: g, log, look: w.look });
  print({ calls: g.calls, split: w.split() });
  chat.close();
} else {
  const calls: string[] = [];
  const summarize = async (job: Job) => {
    calls.push(`${job.l}:${job.i}/1`);
    return fakeSummary(job);
  };
  const { chat } = await openChat(dir, { jobs: 1, summarize });
  const caughtUp = caughtUpIn(chat), w = watching(chat, calls);
  for (const m of fixture()) {
    chat.log(m.kind, m.text);
    w.look();
    while (!caughtUp()) await Bun.sleep(1);
    w.look();
  }
  print({ calls, split: w.split() });
  chat.close();
}
