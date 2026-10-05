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
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
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
