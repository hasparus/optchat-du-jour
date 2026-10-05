#!/usr/bin/env bun
// The parity test (SPEC "Parity test"): the fixture replayed through both implementations with the
// same fake compactor must give the same log, the same tree, and the same `optchat view`, byte for
// byte, whichever implementation prints it. REF is the reference checkout at the pinned commit.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Schema } from "effect";

const ref = Bun.env.REF;
if (!ref) throw new Error("set REF to a checkout of gebeer/shitty-optchat at the commit pinned in .github/workflows/ci.yml");
const root = new URL("../..", import.meta.url).pathname;
const here = new URL(".", import.meta.url).pathname;
const tmp = mkdtempSync(`${tmpdir()}/par-`); // short: socket paths stop at ~107 characters
const ours = `${tmp}/o`, theirs = `${tmp}/r`;

async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(args, { env: { ...Bun.env, ...env }, stderr: "pipe", stdout: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code) throw new Error(`${args.join(" ")} exited ${code}: ${err}`);
  return out;
}

const Rec = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

// every record of a stream, `drop` keys left out, in a canonical order
const records = (dir: string, stream: string, drop: readonly string[] = []) =>
  readdirSync(`${dir}/chat/${stream}`)
    .flatMap((f) => readFileSync(`${dir}/chat/${stream}/${f}`, "utf8").split("\n").filter(Boolean))
    .map((line) => {
      const fields = Object.entries(Schema.decodeUnknownSync(Rec)(line)).filter(([k]) => !drop.includes(k));
      return JSON.stringify(Object.fromEntries(fields));
    })
    .sort();

const check = (what: string, a: string[] | string, b: string[] | string) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x === y) {
    console.log(`ok    ${what}`);
    return;
  }
  process.exitCode = 1;
  let k = 0;
  while (x[k] === y[k]) k++;
  console.log(`FAIL  ${what}: first difference at char ${k}\n  ours:   ${x.slice(Math.max(0, k - 80), k + 80)}\n  theirs: ${y.slice(Math.max(0, k - 80), k + 80)}`);
};

try {
  const t0 = performance.now();
  await Promise.all([
    run(["bun", `${here}drive-ours.ts`, ours]),
    run(["bun", `${here}drive-reference.ts`, theirs], { REF: ref }),
  ]);
  console.log(`replayed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const view = async (cli: string, dir: string) => run(["bun", cli, "view"], { OPTCHAT_DIR: dir });
  const ourCli = `${root}cli/optchat.ts`, refCli = `${ref}/src/cli.ts`;
  const v = await view(refCli, theirs);
  console.log(`view: ${v.split("\n").length - 2} lines, ${v.length} chars`);
  check("log (dates aside)", records(ours, "main", ["date"]), records(theirs, "main", ["date"]));
  check("tree", records(ours, "tree"), records(theirs, "tree"));
  check("our view of our dir = their view of theirs", await view(ourCli, ours), v);
  check("their view of our dir = their view of theirs", await view(refCli, ours), v);
  check("our view of their dir = their view of theirs", await view(ourCli, theirs), v);
} finally {
  rmSync(tmp, { force: true, recursive: true });
}
