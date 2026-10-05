// The read-only tools of an engine with its own loop (SPEC "Engines", tools on non-Claude engines;
// M5): they stay inside the device's folders whatever the path says (outside, `..`, a symlink),
// none of them writes, and the device runner serves them only to callers it trusts, never to a
// browser. No model, no network beyond 127.0.0.1.
import { BunServices } from "@effect/platform-bun";
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { deviceLayer } from "../device/runner.ts";
import { toolBox } from "../src/tools/box.ts";
import { makeFileTools } from "../src/tools/files.ts";
import { newMem } from "../src/tree.ts";
import { freePort } from "./ports.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(`${tmpdir()}/ot-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const ECHO = new URL("echo-claude.ts", import.meta.url).pathname;

test("Read, Glob and Grep stay inside the folders through .., symlinks and absolute paths; nothing writes", async () => {
  const inside = tmp(), outside = tmp();
  mkdirSync(`${inside}/src`);
  writeFileSync(`${inside}/src/a.txt`, "alpha\nbeta\n");
  writeFileSync(`${outside}/secret.txt`, "the secret\n");
  symlinkSync(outside, `${inside}/escape`);
  symlinkSync(`${outside}/secret.txt`, `${inside}/link.txt`);

  const run = await Effect.runPromise(makeFileTools([inside]).pipe(Effect.provide(BunServices.layer)));
  const call = async (name: string, input: Record<string, string>) => Effect.runPromise(run(name, input));

  expect(await call("Read", { file_path: "src/a.txt" })).toBe("     1\talpha\n     2\tbeta");
  for (const path of [`${outside}/secret.txt`, "escape/secret.txt", "link.txt", `../${basename(outside)}/secret.txt`, `${inside}/src/../../${basename(outside)}/secret.txt`])
    expect(await call("Read", { file_path: path })).toMatch(/^Error: .* is outside this device's folders$/);

  const listed = await call("Glob", { pattern: "**/*" });
  expect(listed).toContain(`${inside}/src/a.txt`);
  expect(listed).not.toContain("secret");
  expect(await call("Glob", { pattern: "../*" })).toStartWith("Error: the pattern ../* must be relative");
  expect(await call("Glob", { path: outside, pattern: "*" })).toStartWith("Error: ");
  expect(await call("Grep", { pattern: "secret" })).toBe("No matches found");
  expect(await call("Grep", { output_mode: "content", pattern: "^b" })).toBe(`${inside}/src/a.txt:2:beta`);
  // a file ending in a newline has two lines, not a third empty one, even for a pattern that matches ""
  expect(await call("Grep", { output_mode: "count", path: "src", pattern: "^" })).toBe(`${inside}/src/a.txt:2`);

  for (const name of ["Write", "Edit", "Bash"]) expect(await call(name, { command: "touch x", file_path: "x" })).toStartWith(`Error: there is no tool named ${name}`);
  const box = toolBox({ device: "mini", files: run, folders: [inside], mem: newMem() });
  expect(box.defs.map((d) => d.name)).toEqual(["Read", "Glob", "Grep", "zoom", "date"]);
});

test("a Grep pattern that backtracks without end times out, and the server stays responsive meanwhile", async () => {
  const folder = tmp();
  // (a+)+$ takes exponential time on a's ending in b: about half a second a line at 28 a's, so
  // 300 lines are minutes (a single longer line is cut short by the engine's own backtrack limit)
  writeFileSync(`${folder}/evil.txt`, `${"a".repeat(28)}b\n`.repeat(300));
  writeFileSync(`${folder}/fine.txt`, "needle\n");
  const run = await Effect.runPromise(makeFileTools([folder], { timeout: "1 second" }).pipe(Effect.provide(BunServices.layer)));

  // the event loop keeps ticking while the search spins in its own thread
  let last = performance.now(), worst = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  const reply = await Effect.runPromise(run("Grep", { path: `${folder}/evil.txt`, pattern: "(a+)+$" }));
  const took = performance.now() - started;
  clearInterval(tick);

  expect(reply).toBe("Error: Grep took longer than 1s");
  expect(took).toBeLessThan(3000);
  expect(worst).toBeLessThan(500);

  // the next search starts afresh, and a plain one in the same folder is answered
  expect(await Effect.runPromise(run("Grep", { pattern: "needle" }))).toBe(`${folder}/fine.txt`);
  expect(await Effect.runPromise(run("Grep", { pattern: "(" }))).toStartWith("Error: bad pattern");
});

test("the device runner's POST /tool answers a trusted caller and refuses a browser", async () => {
  const folder = tmp();
  writeFileSync(`${folder}/notes.txt`, "hello\n");
  const port = freePort();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(deviceLayer({ claude: ECHO, folders: [folder], host: "127.0.0.1", name: "macbook", port, trust: { _tag: "loopback" } }));
        const post = (headers: Record<string, string>) =>
          Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${port}/tool`, {
              body: JSON.stringify({ input: { file_path: `${folder}/notes.txt` }, name: "Read" }),
              headers: { "content-type": "application/json", ...headers },
              method: "POST",
            });
            return { status: response.status, text: await response.text() };
          });
        expect(yield* post({})).toEqual({ status: 200, text: JSON.stringify({ output: "     1\thello" }) });
        expect((yield* post({ origin: "https://evil.example" })).status).toBe(403);
      }),
    ),
  );
});
