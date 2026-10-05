// The same replay through the reference (REF: its checkout at the pinned commit), so both data
// dirs come from identical inputs.
import { fakeSummary, fixture } from "./fixture.ts";

const [dir, ref] = [process.argv[2], process.env.REF];
if (!dir || !ref) throw new Error("usage: REF=<shitty-optchat checkout> drive-reference.ts <data dir>");

type Chat = { close: () => void; log: (kind: string, text: string) => void; mem: { root: unknown[]; tree: Map<string, unknown> }; };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the reference has no types we can import by path
const { openChat } = (await import(`${ref}/src/chat.ts`)) as {
  openChat: (dir: string, o: object) => Promise<{ chat: Chat }>;
};
const { chat } = await openChat(dir, { jobs: 1, summarize: async (job: Parameters<typeof fakeSummary>[0]) => fakeSummary(job) });

const done = (T: number) => {
  for (let l = 0; 2 ** l <= T; l++) for (let i = 0; (i + 1) * 2 ** l <= T; i++) if (!chat.mem.tree.has(`${l}:${i}`)) return false;
  return true;
};
for (const m of fixture()) {
  chat.log(m.kind, m.text);
  while (!done(chat.mem.root.length)) await Bun.sleep(1);
}
chat.close();
