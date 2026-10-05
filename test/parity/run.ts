#!/usr/bin/env bun
// The parity test (SPEC "Parity test"): the fixture replayed through both implementations with the
// same fake compactor must give the same log, the same tree, and the same `optchat view`, byte for
// byte, whichever implementation prints it. Twice: caught up after every message, and lagging,
// with the compactor behind the log and some of its calls failing and retried (fixture.ts). REF is
// the reference checkout at the pinned commit.
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";

const ref = Bun.env.REF;
if (!ref) throw new Error("set REF to a checkout of gebeer/shitty-optchat at the commit pinned in .github/workflows/ci.yml");
const here = `${import.meta.dir}/`;
const root = `${dirname(dirname(import.meta.dir))}/`;
const tmp = mkdtempSync(`${tmpdir()}/par-`); // short: socket paths stop at ~107 characters

async function run(argv: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(argv, { env: { ...Bun.env, ...extra }, stderr: "pipe", stdout: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code) throw new Error(`${argv.join(" ")} exited ${code}: ${err}`);
  return out;
}

const Rec = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

// every record of a stream, `drop` keys left out, in a canonical order
const records = (dir: string, stream: string, drop: readonly string[] = []) => {
  const folder = [dir, "chat", stream].join("/");
  return readdirSync(folder)
    .flatMap((name) => readFileSync(`${folder}/${name}`, "utf8").split(/\n/).filter((line) => line !== ""))
    .map((line) => {
      const fields = Object.entries(Schema.decodeUnknownSync(Rec)(line)).filter(([k]) => !drop.includes(k));
      return JSON.stringify(Object.fromEntries(fields));
    })
    .sort();
};

const check = (what: string, a: string[] | string, b: string[] | string) => {
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

// one replay of each implementation into its own data dir, then every comparison
const replay = async (mode: "caught-up" | "lag") => {
  const ours = `${tmp}/${mode}-o`, theirs = `${tmp}/${mode}-r`;
  const args = mode === "lag" ? ["lag"] : [];
  const t0 = performance.now();
  const [ourCalls, theirCalls] = await Promise.all([run(["bun", `${here}drive-ours.ts`, ours, ...args]), run(["bun", `${here}drive-reference.ts`, theirs, ...args], { REF: ref })]);
  console.log(`${mode}: replayed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (mode === "lag") {
    const calls = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(ourCalls.trim());
    console.log(`${mode}: ${calls.length} compactor calls, ${calls.filter((c) => !c.endsWith("/1")).length} of them retries`);
    check(`${mode}: the compactor calls, in order`, ourCalls.trim(), theirCalls.trim());
  }
  const view = async (cli: string, dir: string) => run(["bun", cli, "view"], { OPTCHAT_DIR: dir });
  const ourCli = `${root}cli/optchat.ts`, refCli = `${ref}/src/cli.ts`;
  const v = await view(refCli, theirs);
  console.log(`${mode}: view: ${v.split("\n").length - 2} lines, ${v.length} chars`);
  check(`${mode}: log (dates aside)`, records(ours, "main", ["date"]), records(theirs, "main", ["date"]));
  check(`${mode}: tree`, records(ours, "tree"), records(theirs, "tree"));
  check(`${mode}: our view of our dir = their view of theirs`, await view(ourCli, ours), v);
  check(`${mode}: their view of our dir = their view of theirs`, await view(refCli, ours), v);
  check(`${mode}: our view of their dir = their view of theirs`, await view(ourCli, theirs), v);
};

try {
  await replay("caught-up");
  await replay("lag");
} finally {
  rmSync(tmp, { force: true, recursive: true });
}
