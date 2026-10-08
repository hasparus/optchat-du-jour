#!/usr/bin/env bun
// The parity test (SPEC "Parity test"): the fixture replayed through both implementations with the
// same fake compactor must give the same log, byte for byte, and the same tree records, as a set.
// The views part by design (SPEC E22: the reference merges by the first message at every
// message, we by the last message in batches), and so do the compactions' contexts (E24: theirs
// the bare view lines, ours the compaction view, docs/optchat.md §4), which the fake compactor
// therefore ignores; every `optchat view` is only checked to be a well-formed view of the whole
// log, whichever implementation prints it of whichever data dir. Twice: caught up after every
// message, where the compactor calls match in order, and lagging, with the compactor behind the
// log and some of its calls failing and retried (fixture.ts), where the start rules part (E25) and
// the calls match as a multiset. REF is the reference checkout at the pinned commit.
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
import type { Report } from "./fixture.ts";

const ref = Bun.env.REF;
if (!ref) throw new Error("set REF to a checkout of gebeer/shitty-optchat at the commit pinned in .github/workflows/ci.yml");
const here = `${import.meta.dir}/`;
const root = `${dirname(dirname(import.meta.dir))}/`;
const tmp = mkdtempSync(`${tmpdir()}/par-`); // short: socket paths stop at ~107 characters

async function run(argv: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(argv, { env: { ...Bun.env, ...extra }, stderr: "pipe", stdout: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code) throw new Error(`${argv.join(" ")} exited ${code}: ${err}`);
  return { err, out };
}

const Rec = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

// every record of a stream, `drop` keys left out, in the order written (day files by name)
const records = (dir: string, stream: string, drop: readonly string[] = []) => {
  const folder = [dir, "chat", stream].join("/");
  return readdirSync(folder)
    .toSorted()
    .flatMap((name) => readFileSync(`${folder}/${name}`, "utf8").split(/\n/).filter((line) => line !== ""))
    .map((line) => {
      const fields = Object.entries(Schema.decodeUnknownSync(Rec)(line)).filter(([k]) => !drop.includes(k));
      return JSON.stringify(Object.fromEntries(fields));
    });
};

const check = (what: string, a: readonly string[] | string, b: readonly string[] | string) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x === y) {
    console.log(`ok    ${what}`);
    return;
  }
  process.exitCode = 1;
  let k = 0;
  while (x[k] === y[k]) k++;
  const near = (s: string) => s.slice(Math.max(0, k - 80), k + 80);
  console.log(`FAIL  ${what}: first difference at char ${k}\n  ours:   ${near(x)}\n  theirs: ${near(y)}`);
};

const ok = (what: string, holds: boolean, detail = "") => {
  if (!holds) process.exitCode = 1;
  console.log(`${holds ? "ok  " : "FAIL"}  ${what}${holds ? "" : `: ${detail}`}`);
};

// a view as `optchat view` prints it: <chat>, then one id+n|text line per part, tiling [0, T), then </chat>
function tiles(view: string, T: number) {
  const lines = view.trimEnd().split("\n");
  if (lines[0] !== "<chat>" || lines.at(-1) !== "</chat>") return "not inside <chat> tags";
  let at = 0;
  for (const line of lines.slice(1, -1)) {
    const [, id, n] = /^(\d+)\+(\d+)\|/.exec(line) ?? [];
    if (Number(id) !== at || !Number.isInteger(Math.log2(Number(n))) || Number(id) % Number(n) !== 0) return `line ${line.slice(0, 40)} is out of place at ${at}`;
    at += Number(n);
  }
  return at === T ? "" : `it covers ${at} of ${T} messages`;
}

const Printed = Schema.fromJsonString(Schema.Struct({ calls: Schema.Array(Schema.String), split: Schema.Struct({ calls: Schema.Number, nodes: Schema.Number }) }));
const report = (out: string): Report => Schema.decodeUnknownSync(Printed)(out.trim());

// one replay of each implementation into its own data dir, then every comparison
const replay = async (mode: "caught-up" | "lag") => {
  const ours = `${tmp}/${mode}-o`, theirs = `${tmp}/${mode}-r`;
  const args = mode === "lag" ? ["lag"] : [];
  const t0 = performance.now();
  const [o, r] = await Promise.all([run(["bun", `${here}drive-ours.ts`, ours, ...args]), run(["bun", `${here}drive-reference.ts`, theirs, ...args], { REF: ref })]);
  console.log(`${mode}: replayed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const [mine, refs] = [report(o.out), report(r.out)];
  const log = records(ours, "main", ["date"]);
  check(`${mode}: log (dates aside)`, log, records(theirs, "main", ["date"]));
  // The tree: every node, whatever order it was built in. The fake compactor's line depends on
  // the node and its source only, so the two trees are the same set of records.
  const tree = (dir: string) => records(dir, "tree").toSorted();
  check(`${mode}: the tree records, as a set`, tree(ours), tree(theirs));
  console.log(`${mode}: ${mine.calls.length} compactor calls (${mine.calls.filter((c) => !c.endsWith("/1")).length} retries); the views part after ${Math.min(mine.split.calls, refs.split.calls)} calls`);
  // The calls. Caught up, each message's node and then the merges it makes ready, level by level,
  // in both: the same calls in the same order, all of them. Lagging, the order parts by design
  // (docs/optchat.md §4 "The order", SPEC E25): we start a message's node once fewer than 8 view
  // lines before it are unbuilt and a merge once both its halves are, and try a failed call again
  // at the next message; the reference starts a node only when every view line before its end is
  // built, level by level, and retries after a timer. Each node is still called the same number
  // of times (the script fails its tries alike), so the calls agree as a multiset.
  if (mode === "caught-up") check(`${mode}: the compactor calls, in order`, mine.calls, refs.calls);
  else check(`${mode}: the compactor calls, as a multiset`, mine.calls.toSorted(), refs.calls.toSorted());
  // whichever CLI prints whichever dir: a well-formed view of the whole log
  const ourCli = `${root}cli/optchat.ts`, refCli = `${ref}/src/cli.ts`;
  const view = async (cli: string, dir: string) => run(["bun", cli, "view"], { OPTCHAT_DIR: dir });
  for (const [who, cli] of [["our", ourCli], ["their", refCli]] as const)
    for (const [whose, dir] of [["our", ours], ["their", theirs]] as const) {
      const v = await view(cli, dir);
      const broken = tiles(v.out, log.length);
      ok(`${mode}: ${who} view of ${whose} dir tiles the log (${v.out.split("\n").length - 2} lines)`, broken === "", broken);
    }
  // ours prints the view it saved; their dir has none, so ours rebuilds it and says so
  const saved = await view(ourCli, ours), rebuilt = await view(ourCli, theirs);
  ok(`${mode}: our view of our dir is the saved one`, saved.err === "", saved.err);
  ok(`${mode}: our view of their dir is rebuilt from the log, and says so`, rebuilt.err.includes("chat/view.json: missing; the view was rebuilt from the log"), rebuilt.err);
};

try {
  await replay("caught-up");
  await replay("lag");
} finally {
  rmSync(tmp, { force: true, recursive: true });
}
