// From fx0 tests/core.test.mjs and tests/design-draft.test.mjs (Apache-2.0, © Vercel, modified).
// Artifacts (SPEC "Artifacts", E31): fx0's validator, CSP and bootstrap (ported from fx0's
// tests/core.test.mjs), the edit's exact replacements, names, the store's versions and atomic
// writes and their commit, read_artifact by version, a subagent's as the master's (E36), the
// live draft's decoders, and the log's stubs: neither the main log nor the tree ever holds the HTML.
import { afterAll, expect, test } from "bun:test";
import { Effect, Predicate, PubSub, Schema, type Scope } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createContext, runInContext, Script } from "node:vm";
import { editsIn, fieldExtractor, makeDrafts, nameIn, type DraftOut } from "../src/artifacts/draft.ts";
import { heartbeat, noWebRtc } from "../src/artifacts/bootstrap.ts";
import { frameGuard, noScripts } from "../src/artifacts/frame-guard.ts";
import { ARTIFACT_EMBEDDED_CSP, artifactBootstrap, inline, MAX_ARTIFACT_BYTES, prepareArtifactHtml, validateArtifactHtml } from "../src/artifacts/html.ts";
import { applyEdits, ARTIFACT_NAME, ARTIFACTS_UNCOMMITTED, artifactsLeftOut, badName, openArtifacts } from "../src/artifacts/store.ts";
import { readStyle, STYLES } from "../src/artifacts/styles.ts";
import { ARTIFACT_TOOL_DEFS, loggedText, makeArtifactTools, stubEcho, stubToolEntry } from "../src/artifacts/tools.ts";
import { openChat } from "../src/chat.ts";
import { type Caller, TOOLS } from "../src/mcp.ts";
import { makePersist } from "../src/persist.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import type { StoreError } from "../src/store.ts";
import type { TurnEngine, TurnEvents } from "../src/turn/engine.ts";
import { allBuilt } from "../src/view.ts";
import { ArtifactInfo, kb, savedVersion, SUBAGENT_NAME } from "../src/wire.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-art-`);
  dirs.push(d);
  return d;
};
const run = async <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body));

const SAFE =
  '<!doctype html><html><head><style>body{color:red}</style></head><body><a href="#details">Details</a><img alt="dot" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><h1 id="details">Hello</h1></body></html>';
const page = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const invalid = (html: string, error: string) => {
  expect(validateArtifactHtml(html)).toEqual({ error, ok: false });
};

// ---- fx0's validator, CSP and bootstrap ----

test("validation accepts inline CSS, JavaScript, Canvas, data assets, fragments and https links", () => {
  expect(validateArtifactHtml(SAFE)).toEqual({ bytes: Buffer.byteLength(SAFE), ok: true });
  const interactive = page(
    '<canvas id="scene"></canvas><button onclick="cancelAnimationFrame(window.frame)">Pause</button><script>const canvas=document.querySelector("#scene"); const context=canvas.getContext("2d"); context.fillRect(0,0,10,10); window.frame=requestAnimationFrame(() => {}); const example="<iframe src=https://example.com></iframe>";</script>',
  );
  expect(validateArtifactHtml(interactive)).toEqual({ bytes: Buffer.byteLength(interactive), ok: true });
  const cited = page('<p>Source: <a href="https://vercel.com/blog">Vercel blog</a></p>');
  expect(validateArtifactHtml(cited).ok).toBe(true);
  expect(prepareArtifactHtml(cited, ARTIFACT_EMBEDDED_CSP, "ready-token")).toMatch(/parent\.postMessage\(\{ token, type: "open", url \}, "\*"\)/);
  const prepared = prepareArtifactHtml(interactive);
  expect(prepared).toMatch(/^<!doctype html><script>/i);
  expect(prepared.indexOf("RTCPeerConnection")).toBeLessThan(prepared.indexOf("const canvas"));
  const embedded = prepareArtifactHtml(interactive, ARTIFACT_EMBEDDED_CSP, "ready-token");
  expect(embedded).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/i);
  expect(embedded).toMatch(/parent\.postMessage/);
  expect(embedded).toMatch(/ready-token/);
  expect(embedded.indexOf("RTCPeerConnection")).toBeLessThan(embedded.indexOf("const canvas"));
  // the CSP goes in before any of the page's own markup, its quotes escaped
  expect(embedded).toContain(`content="${ARTIFACT_EMBEDDED_CSP.replaceAll("'", "'")}"`);
  expect(embedded.indexOf("Content-Security-Policy")).toBeLessThan(embedded.indexOf("<html>"));
});

test("validation rejects external scripts and scripted navigation", () => {
  invalid(page('<script src="https://example.com/app.js"></script>'), "artifact scripts must be inline");
  invalid(page('<a href="javascript:alert(1)">Run</a>'), "artifact must not use scripted URLs");
  invalid(page('<a href="jav&#x61;script:alert(1)">Run</a>'), "artifact must not use scripted URLs");
});

test("validation rejects duplicate attributes before browser parsing can diverge", () => {
  invalid(page('<a href="https://example.com" href="#safe">Leave</a>'), "artifact must not repeat the href attribute");
  invalid(page("", '<meta http-equiv="refresh" http-equiv="x" content="0;url=https://example.com">'), "artifact must not repeat the http-equiv attribute");
  invalid(page('<img src="https://example.com/a.png" src="data:image/gif;base64,AA==" alt="">'), "artifact must not repeat the src attribute");
});

test("validation rejects comments, meta refresh, base, links, forms and the prohibited tags", () => {
  invalid(page('<!--><meta http-equiv="refresh" content="0;url=/escaped">-->'), "artifact must not contain HTML comments");
  invalid(page("<!probe>"), "artifact must not contain markup declarations");
  invalid(page("<?probe>"), "artifact must not contain markup declarations");
  invalid(page("", '<meta http-equiv="refresh" content="0;url=https://example.com">'), "artifact must not contain meta refresh");
  invalid(page("", '<meta http-equiv="r&#x65;fresh" content="0;url=https://example.com">'), "artifact must not contain meta refresh");
  invalid(page("", '<base href="https://example.com/">'), "artifact must not contain <base> elements");
  invalid(page('<a href="http://example.com">Leave</a>'), "artifact href values must be local fragments, https links, or compatible embedded data: URLs");
  invalid(page('<link rel="stylesheet" href="https://example.com/a.css">'), "artifact href values must be local fragments, https links, or compatible embedded data: URLs");
  invalid(page('<form action="/submit"><button>Send</button></form>'), "artifact must not contain forms");
  invalid(page('<iframe src="data:text/html,x"></iframe>'), "artifact must not contain <iframe> elements");
  invalid(page('<object data="x"></object>'), "artifact must not contain <object> elements");
  invalid(page('<embed src="x">'), "artifact must not contain <embed> elements");
});

test("validation rejects external assets and action values", () => {
  invalid(page('<img src="https://example.com/image.png" alt="">'), "artifact src values must use a compatible embedded data: URL");
  invalid(page('<img srcset="https://example.com/image.png 2x" alt="">'), "artifact srcset values must contain one embedded data:image URL");
  invalid(page('<img srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, https://example.com/image.png 2x" alt="">'), "artifact srcset values must contain one embedded data:image URL");
  invalid(page('<video poster="https://example.com/p.png"></video>'), "artifact poster values must use an embedded data:image URL");
  invalid(page('<button formaction="/submit">Send</button>'), "artifact must not contain formaction attributes");
});

test("the CSP allows isolated inline scripts and denies ambient capabilities", () => {
  expect(ARTIFACT_EMBEDDED_CSP).toMatch(/script-src 'unsafe-inline'/);
  expect(ARTIFACT_EMBEDDED_CSP).toMatch(/default-src 'none'/);
  expect(ARTIFACT_EMBEDDED_CSP).toMatch(/connect-src 'none'/);
  expect(ARTIFACT_EMBEDDED_CSP).toMatch(/worker-src 'none'/);
  expect(ARTIFACT_EMBEDDED_CSP).toMatch(/style-src 'unsafe-inline'/);
  expect(ARTIFACT_EMBEDDED_CSP).not.toMatch(/allow-same-origin|https?:|style-src[^;]*\*/);
});

test("validation rejects fragments and oversized documents", () => {
  invalid("<main>fragment</main>", "artifact must start with <!doctype html>");
  invalid(`<!doctype html><html><head></head><body>${"x".repeat(MAX_ARTIFACT_BYTES)}</body></html>`, "artifact exceeds 512 KiB");
  invalid("<!doctype html><html><head></head><body></body><body></body></html>", "artifact must contain exactly one <body> element");
});

// ---- the edit's exact replacements, names ----

test("an edit replaces text that matches exactly once; no match or more than one is an error and changes nothing", () => {
  expect(applyEdits("<p>a</p><p>b</p>", [{ new: "<p>A</p>", old: "<p>a</p>" }, { new: "B", old: ">b<".slice(1, 2) }])).toEqual({ html: "<p>A</p><p>B</p>" });
  expect(applyEdits("<p>a</p>", [{ new: "x", old: "<p>z</p>" }])).toEqual({ error: "edit 1: old matched 0 times; it must match exactly once (nothing was saved)" });
  expect(applyEdits("<p>a</p><p>a</p>", [{ new: "x", old: "<p>a</p>" }])).toEqual({ error: "edit 1: old matched 2 times; it must match exactly once (nothing was saved)" });
  // later edits see the text as the earlier ones left it
  expect(applyEdits("ab", [{ new: "cc", old: "a" }, { new: "d", old: "cc" }])).toEqual({ html: "db" });
  expect(applyEdits("ab", [{ new: "x", old: "" }])).toEqual({ error: "edit 1: old must be a non-empty string" });
  expect(applyEdits("ab", [])).toEqual({ error: "edits must contain 1 to 20 replacements" });
  // a replacement's `$&` is text, not a pattern
  expect(applyEdits("ab", [{ new: "$&$&", old: "a" }])).toEqual({ html: "$&$&b" });
});

test("names: a subagent's, a letter, then up to 31 letters, digits, - or _; nothing that could be a path", () => {
  expect(ARTIFACT_NAME).toBe(SUBAGENT_NAME);
  for (const ok of ["landing", "L", "a-b_c9", `a${"b".repeat(31)}`]) expect(badName(ok)).toBeNull();
  for (const bad of ["", "9lives", "-x", "../etc", "a/b", "a.b", "a b", `a${"b".repeat(32)}`, "x\u0000", "style/linear"]) expect(badName(bad)).not.toBeNull();
});

// ---- the store ----

const report = (seen: string[]) => (m: string) => Effect.sync(() => void seen.push(m));

test("the store keeps a version per publish and edit, written atomically, and reads any of them", async () => {
  const dir = tmp();
  await run(
    Effect.gen(function* () {
      const store = yield* openArtifacts(dir, { report: report([]) });
      const v1 = page("<h1>One</h1>");
      const first = yield* store.publish("landing", v1);
      expect(first).toMatchObject({ changed: true, name: "landing", ok: true, version: { by: "publish", v: 1 } });
      // the same HTML again is no new version
      expect(yield* store.publish("landing", v1)).toMatchObject({ changed: false, ok: true, version: { v: 1 } });
      expect(yield* store.edit("landing", [{ new: "Two", old: "One" }])).toMatchObject({ changed: true, ok: true, version: { by: "edit", v: 2 } });
      // an edit that doesn't match saves nothing
      expect(yield* store.edit("landing", [{ new: "x", old: "One" }])).toEqual({ error: "edit 1: old matched 0 times; it must match exactly once (nothing was saved)", ok: false });
      // an invalid page saves nothing, and says why
      expect(yield* store.publish("landing", "<p>no</p>")).toEqual({ error: "artifact must start with <!doctype html>", ok: false });
      // another spelling of the same name is refused
      expect(yield* store.publish("Landing", v1)).toEqual({ error: "there is an artifact named landing: use that name", ok: false });
      expect(yield* store.edit("nope", [{ new: "x", old: "y" }])).toEqual({ error: "there is no artifact named nope: publish_artifact makes one", ok: false });
      expect((yield* store.read("landing", 1))?.html).toBe(v1);
      expect((yield* store.read("LANDING"))?.html).toBe(page("<h1>Two</h1>"));
      expect(yield* store.read("landing", 3)).toBeNull();
      expect(yield* store.read("../landing")).toBeNull();
    }),
  );
  const folder = `${dir}/artifacts/landing`;
  expect(readdirSync(folder).toSorted()).toEqual(["artifact.json", "v1.html", "v2.html"]); // no temp file left behind
  const meta = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactInfo))(readFileSync(`${folder}/artifact.json`, "utf8"));
  expect(meta.versions.map((v) => [v.v, v.by])).toEqual([
    [1, "publish"],
    [2, "edit"],
  ]);
  // nothing on disk names a log index: the echo says which call made which version
  expect(readFileSync(`${folder}/artifact.json`, "utf8")).not.toContain('"i"');
  // a restart reads it again
  await run(
    Effect.gen(function* () {
      const store = yield* openArtifacts(dir, { report: report([]) });
      expect(store.list().map((a) => [a.name, a.versions.length])).toEqual([["landing", 2]]);
      expect((yield* store.read("landing", 2))?.html).toBe(page("<h1>Two</h1>"));
    }),
  );
});

test("the artifacts are committed with the data dir, unless artifacts.commit is off", async () => {
  const home = tmp();
  await run(
    Effect.gen(function* () {
      const store = yield* openArtifacts(`${home}/streams/mini`, { report: report([]) });
      yield* store.publish("chart", page("<p>1</p>"));
      const persist = yield* makePersist(report([]));
      expect(yield* persist(home, "turn")).toBeNull();
    }),
  );
  const files = spawnSync("git", ["ls-files"], { cwd: home, encoding: "utf8" }).stdout;
  expect(files).toContain("streams/mini/artifacts/chart/v1.html");
  expect(files).toContain("streams/mini/artifacts/chart/artifact.json");
  expect(artifactsLeftOut(true)).toEqual([]);
  expect(artifactsLeftOut(false)).toEqual([ARTIFACTS_UNCOMMITTED]);

  const other = tmp();
  await run(
    Effect.gen(function* () {
      const store = yield* openArtifacts(`${other}/streams/mini`, { report: report([]) });
      yield* store.publish("chart", page("<p>1</p>"));
      const persist = yield* makePersist(report([]), () => artifactsLeftOut(false));
      expect(yield* persist(other, "turn")).toBeNull();
    }),
  );
  expect(spawnSync("git", ["ls-files"], { cwd: other, encoding: "utf8" }).stdout).not.toContain("artifacts/");
  expect(existsSync(`${other}/streams/mini/artifacts/chart/v1.html`)).toBe(true); // kept on disk
});

// ---- the tools ----

const call = (tools: ReturnType<typeof makeArtifactTools>, caller: Caller, tool: "publish_artifact" | "edit_artifact" | "read_artifact", args: Readonly<Record<string, Schema.Json>>) =>
  tools.tools(caller).call(tool, args);

test("the tools: publish, edit and read_artifact by version; a subagent has all three as the master has (E36)", async () => {
  const dir = tmp();
  const told: string[] = [];
  await run(
    Effect.gen(function* () {
      const artifacts = yield* openArtifacts(dir, { report: report([]) });
      const tools = makeArtifactTools({ artifacts, changed: (name, v) => Effect.sync(() => void told.push(`${name} v${v.v}`)) });
      expect(yield* call(tools, "master", "publish_artifact", { html: page("<h1>Hi</h1>"), name: "card" })).toEqual({ error: false, text: "Published card (0.1 KB) [v1]" });
      expect(yield* call(tools, "master", "edit_artifact", { edits: [{ new: "Bye", old: "Hi" }], name: "card" })).toEqual({ error: false, text: "Edited card (0.1 KB) [v2]" });
      const v1 = yield* call(tools, "master", "read_artifact", { name: "card", version: 1 });
      expect(v1.error).toBe(false);
      expect(v1.text).toMatch(/^card v1 of 2 \(0\.1 KB, \d{4}-\d\d-\d\d \d\d:\d\d\):\n<!doctype html>/);
      expect(v1.text).toContain("<h1>Hi</h1>");
      expect((yield* call(tools, "master", "read_artifact", { name: "card" })).text).toContain("<h1>Bye</h1>");
      expect(yield* call(tools, "master", "read_artifact", { name: "card", version: 7 })).toEqual({ error: true, text: "read_artifact: card has no version 7; it has v1 to v2" });
      expect(yield* call(tools, "master", "read_artifact", { name: "nope" })).toEqual({ error: true, text: "read_artifact: there is no artifact named nope" });
      // a rejection the model can fix comes back as a tool error saying why
      expect(yield* call(tools, "master", "publish_artifact", { html: page('<iframe src="x"></iframe>'), name: "card" })).toEqual({ error: true, text: "publish_artifact: artifact must not contain <iframe> elements" });
      expect(yield* call(tools, "master", "publish_artifact", { name: "card" })).toEqual({ error: true, text: "publish_artifact needs name and html, both strings." });
      // a subagent reads, publishes and edits as the master does (E36)
      const scout: Caller = { agent: "Scout" };
      expect((yield* call(tools, scout, "read_artifact", { name: "card", version: 2 })).text).toContain("<h1>Bye</h1>");
      expect(yield* call(tools, scout, "publish_artifact", { html: page("<p>x</p>"), name: "scouted" })).toEqual({ error: false, text: "Published scouted (0.1 KB) [v1]" });
      expect(yield* call(tools, scout, "edit_artifact", { edits: [{ new: "<p>y</p>", old: "<p>x</p>" }], name: "scouted" })).toEqual({ error: false, text: "Edited scouted (0.1 KB) [v2]" });
      expect(artifacts.info("card")?.versions.length).toBe(2);
      expect(artifacts.info("scouted")?.versions.length).toBe(2);
      // a long page comes a part at a time
      const long = page(`<p>${"z".repeat(70_000)}</p>`);
      yield* call(tools, "master", "publish_artifact", { html: long, name: "long" });
      const first = yield* call(tools, "master", "read_artifact", { name: "long" });
      expect(first.text).toMatch(/characters 0 to 28000 of \d+; read_artifact with from 28000 for the rest:\n/);
      const last = yield* call(tools, "master", "read_artifact", { from: 56_000, name: "long" });
      expect(last.text.endsWith("</p></body></html>")).toBe(true);
      // a style preset reads as read_artifact("style/<id>")
      const linear = yield* call(tools, "master", "read_artifact", { name: "style/linear" });
      expect(linear.text).toMatch(/^style\/linear\.app, the Linear style/);
      expect(STYLES.every((s) => readStyle(s.id)?.text.startsWith("---") === true)).toBe(true);
      expect((yield* call(tools, "master", "read_artifact", { name: "style/geocities" })).error).toBe(true);
    }),
  );
  expect(told).toEqual(["card v1", "card v2", "scouted v1", "scouted v2", "long v1"]);
});

test("the tool list: the three artifact tools after zoom, date, spawn and tell", () => {
  expect(TOOLS.map((t) => t.name)).toEqual(["zoom", "date", "spawn", "tell", "publish_artifact", "edit_artifact", "read_artifact"]);
  expect(ARTIFACT_TOOL_DEFS.map((t) => t.name)).toEqual(["publish_artifact", "edit_artifact", "read_artifact"]);
});

// ---- the log's stubs (E31) ----

const BIG = page(`<main>${"SECRET-HTML ".repeat(4000)}</main>`);

test("the stubs: a publish or an edit is logged without its HTML, a read's answer as its head line", () => {
  const publish = stubToolEntry(`mcp__optchat__publish_artifact ${JSON.stringify({ html: BIG, name: "landing" })}`);
  expect(publish).toBe(`mcp__optchat__publish_artifact {"html":"<${kb(Buffer.byteLength(BIG))} of HTML, not kept in the log: read_artifact>","name":"landing"}`);
  expect(kb(Buffer.byteLength(BIG))).toBe("46.9 KB");
  const edits = [{ new: BIG, old: "x" }];
  const edit = stubToolEntry(`edit_artifact ${JSON.stringify({ edits, name: "landing" })}`);
  expect(edit).toBe(`edit_artifact {"edits":"<1 edit, ${kb(Buffer.byteLength(JSON.stringify(edits)))}, not kept in the log: read_artifact>","name":"landing"}`);
  expect(stubToolEntry('mcp__optchat__zoom {"id":1,"n":1}')).toBe('mcp__optchat__zoom {"id":1,"n":1}');
  expect(stubToolEntry(`Bash {"command":"echo ${"x".repeat(10)}"}`)).toBe(`Bash {"command":"echo ${"x".repeat(10)}"}`);
  const read = stubEcho("mcp__optchat__read_artifact", `landing v3 of 3 (46.9 KB, 2026-10-19 14:03):\n${BIG}`);
  expect(read).toBe("landing v3 of 3 (46.9 KB, 2026-10-19 14:03):\n<46.9 KB not kept in the log: read_artifact again>");
  expect(stubEcho("read_artifact", "read_artifact: there is no artifact named x")).toBe("read_artifact: there is no artifact named x");
  expect(stubEcho("Bash", BIG)).toBe(BIG);
  expect(stubEcho(undefined, BIG)).toBe(BIG);
  expect(loggedText("talk", BIG)).toBe(BIG);
});

type Play = (out: TurnEvents) => Effect.Effect<void, StoreError>;
const engineOf = (play: Play): TurnEngine => ({ ref: "fake:x", run: (_input, out) => play(out), vision: false, warm: () => Effect.void });

test("the log and the tree never hold an artifact's HTML; the live draft streams to clients", async () => {
  const dir = tmp();
  const input = JSON.stringify({ html: BIG, name: "landing" });
  const play: Play = (out) =>
    Effect.gen(function* () {
      const id = "toolu_9";
      for (const piece of input.match(/[\s\S]{1,500}/gu) ?? []) yield* out.toolInput?.delta({ id, name: "mcp__optchat__publish_artifact" }, piece) ?? Effect.void;
      yield* out.toolInput?.end(id) ?? Effect.void;
      yield* out.log("tool", `mcp__optchat__publish_artifact ${input}`);
      yield* out.log("echo", "Published landing (46.9 KB) [v1]", { tool: "mcp__optchat__publish_artifact" });
      yield* out.log("tool", 'mcp__optchat__read_artifact {"name":"landing"}');
      yield* out.log("echo", `landing v1 of 1 (47.0 KB, 2026-10-19 14:03):\n${BIG}`, { tool: "mcp__optchat__read_artifact" });
      yield* out.log("talk", "Here it is.");
    });
  const events: SessionEvent[] = [];
  await run(
    Effect.gen(function* () {
      const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
      const session = yield* makeSession({
        chat,
        commit: Effect.succeed(null),
        defaultDevice: "mini",
        devices: ["mini"],
        engines: [engineOf(play)],
        idle: "1 hour",
        logUsage: () => Effect.void,
        media: noMedia,
      });
      const sub = yield* PubSub.subscribe(session.events);
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => void events.push(e))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* session.input("make me a landing page");
      const deadline = Date.now() + 5000;
      while (!(events.some((e) => e.type === "run-finished") && session.state().phase === "idle" && allBuilt(chat.mem))) {
        if (Date.now() > deadline) throw new Error("the turn never finished");
        yield* Effect.sleep("10 millis");
      }
    }),
  );
  const files = (stream: string) => readdirSync(`${dir}/chat/${stream}`).map((f) => readFileSync(`${dir}/chat/${stream}/${f}`, "utf8")).join("");
  const main = files("main");
  expect(main).not.toContain("SECRET-HTML");
  expect(files("tree")).not.toContain("SECRET-HTML");
  expect(main).toContain("of HTML, not kept in the log: read_artifact");
  expect(main).toContain("not kept in the log: read_artifact again");
  // the drafts: the page as it streamed, in order and whole, the last piece closed
  const drafts = events.flatMap((e) => (e.type === "artifact-draft" ? [e.draft] : [])) satisfies DraftOut[];
  expect(drafts.length).toBeGreaterThan(0);
  expect(drafts.at(-1)?.closed).toBe(true);
  expect(drafts.every((d) => d.name === null || d.name === "landing")).toBe(true);
  let html = "";
  for (const d of drafts) {
    expect(d.offset).toBe(html.length);
    html += d.delta;
  }
  expect(html).toBe(BIG);
});

// ---- the live draft's decoders ----

test("the html field decodes across split escapes, unicode included", () => {
  const out: string[] = [];
  const feed = fieldExtractor("html", (chunk) => {
    out.push(chunk);
  });
  const raw = JSON.stringify({ html: '<p class="x">😀\n\\u</p>', name: "a" });
  for (const ch of raw) feed(ch);
  expect(out.join("")).toBe('<p class="x">😀\n\\u</p>');
  expect(nameIn('{"name":"lan')).toBeNull();
  expect(nameIn('{"name":"landing","html":"<')).toBe("landing");
});

test("an edit's draft takes the edits the model has written whole", () => {
  const raw = JSON.stringify({ edits: [{ new: "B}", old: "a{" }, { new: "D", old: "c" }], name: "x" });
  expect(editsIn(raw.slice(0, raw.indexOf("},") + 1))).toEqual([{ new: "B}", old: "a{" }]);
  expect(editsIn(raw)).toEqual([
    { new: "B}", old: "a{" },
    { new: "D", old: "c" },
  ]);
  expect(editsIn('{"name":"x","ed')).toEqual([]);
});

test("an edit's draft is the latest version with the edits so far; a close sends what is left and leaves no timer", async () => {
  const sent: DraftOut[] = [];
  await run(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const drafts = makeDrafts({ base: () => Effect.succeed(page("<p>a</p><p>c</p>")), runId: "7", scope, send: (d) => Effect.sync(() => void sent.push(d)) });
      const raw = JSON.stringify({ edits: [{ new: "<p>A</p>", old: "<p>a</p>" }, { new: "<p>C</p>", old: "<p>c</p>" }], name: "x" });
      yield* drafts.delta({ id: "c1", name: "edit_artifact" }, raw);
      yield* drafts.delta({ id: "c2", name: "Bash" }, '{"command":"ls"}'); // not an artifact: not looked at
      yield* drafts.end("c1");
      expect(drafts.now().map((d) => [d.id, d.closed])).toEqual([["c1", true]]);
      yield* drafts.stop;
    }),
  );
  expect(sent).toEqual([{ closed: true, delta: page("<p>A</p><p>C</p>"), id: "c1", name: "x", offset: 0, replace: true, runId: "7", tool: "edit" }]);
});

test("each echo names the version its own call saved, also when another call of the name is unchanged (no guess at the log)", async () => {
  const dir = tmp();
  await run(
    Effect.gen(function* () {
      const artifacts = yield* openArtifacts(dir, { report: report([]) });
      const tools = makeArtifactTools({ artifacts, changed: () => Effect.void });
      const publish = (body: string) => call(tools, "master", "publish_artifact", { html: page(body), name: "card" });
      const first = yield* publish("<p>1</p>");
      const same = yield* publish("<p>1</p>");
      const next = yield* publish("<p>2</p>");
      expect(same.text).toBe("card is unchanged: its latest version is this HTML already [v1]");
      expect([first.text, same.text, next.text].map(savedVersion)).toEqual([1, 1, 2]);
      // a name that looks like a version is still the name
      const plan = yield* call(tools, "master", "publish_artifact", { html: page("<p>p</p>"), name: "plan-v2" });
      expect(plan.text).toBe("Published plan-v2 (0.1 KB) [v1]");
      expect(savedVersion(plan.text)).toBe(1);
      expect(savedVersion("Published plan-v2 v1 (0.1 KB).")).toBeNull();
      expect(savedVersion("publish_artifact: artifact must start with <!doctype html>")).toBeNull();
    }),
  );
});

test("a draft past MAX_ARTIFACT_BYTES stops, closed, and holds no more; a close waits for a flush that is running", async () => {
  const sent: DraftOut[] = [];
  await run(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const drafts = makeDrafts({ base: () => Effect.succeed(null), runId: "1", scope, send: (d) => Effect.sync(() => void sent.push(d)) });
      const big = "x".repeat(200_000);
      yield* drafts.delta({ id: "p", name: "publish_artifact" }, '{"name":"huge","html":"<p>');
      for (let k = 0; k < 4; k++) yield* drafts.delta({ id: "p", name: "publish_artifact" }, big);
      yield* drafts.delta({ id: "p", name: "publish_artifact" }, big); // after the stop: not taken
      yield* drafts.end("p");
      const [now] = drafts.now();
      expect(now?.closed).toBe(true);
      expect(now?.html.length ?? 0).toBeLessThanOrEqual(600_000);
      yield* drafts.stop;
    }),
  );
  expect(sent.at(-1)?.closed).toBe(true);
  expect(sent.filter((d) => d.closed)).toHaveLength(1);
  const total = sent.reduce((n, d) => n + d.delta.length, 0);
  expect(total).toBeLessThanOrEqual(600_000);

  // an edit whose base read is slow: the close comes while the flush waits on it, and is sent after it
  const order: string[] = [];
  await run(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const drafts = makeDrafts({
        base: () => Effect.sleep("300 millis").pipe(Effect.as(page("<p>a</p>"))),
        runId: "1",
        scope,
        send: (d) => Effect.sync(() => void order.push(d.closed ? "closed" : "open")),
      });
      yield* drafts.delta({ id: "e", name: "edit_artifact" }, JSON.stringify({ edits: [{ new: "<p>A</p>", old: "<p>a</p>" }], name: "x" }));
      yield* Effect.sleep("200 millis"); // the flush has started, and waits on the base
      yield* drafts.end("e");
      yield* drafts.stop;
    }),
  );
  expect(order).toEqual(["open", "closed"]);
});

test("the validator reads tags as a browser does: no tag hides behind a quote in a name or inside <svg>'s script and style", () => {
  invalid(page(`<p x"><iframe srcdoc="<script>parent.postMessage(1,'*')</script>"><p y">`), "artifact must not contain <iframe> elements");
  invalid(page(`<p x"><meta http-equiv="refresh" content="0;url=https://evil.example/"><p y">`), "artifact must not contain meta refresh");
  invalid(page(`<svg><script><embed src="https://evil.example/x"></script></svg>`), "artifact must not contain <embed> elements");
  invalid(page(`<svg><style><meta http-equiv="refresh" content="0;url=https://evil.example/"></style></svg>`), "artifact must not contain meta refresh");
  invalid(page('<frame src="data:image/png,x">'), "artifact must not contain <frame> elements");
  // the parser attaches a declarative shadow root, where the frame guard's observer can't see
  invalid(page('<div><template shadowrootmode="closed"><p>x</p></template></div>'), "artifact must not contain declarative shadow roots");
  // a script's own text is text, as before
  expect(validateArtifactHtml(page('<script>const s="<iframe src=x>";</script><svg><circle r="1"/></svg>')).ok).toBe(true);
});

test("the validator refuses ping and styles that load: @import, url() and image-set() of anything but data:", () => {
  invalid(page('<a href="https://example.com/" ping="https://evil.example/ping">x</a>'), "artifact must not contain ping attributes");
  invalid(page("", "<style>@import url(https://evil.example/a.css);</style>"), "artifact styles must not @import");
  invalid(page("", "<style>body{background:url(https://evil.example/b.png)}</style>"), "artifact styles may load only embedded data: URLs");
  invalid(page("", "<style>@font-face{font-family:x;src:url('//evil.example/f.woff')}</style>"), "artifact styles may load only embedded data: URLs");
  invalid(page("", '<style>body{background:image-set("https://evil.example/c.png" 1x)}</style>'), "artifact styles may load only embedded data: URLs");
  invalid(page("", String.raw`<style>body{background:\75 rl(https://evil.example/d.png)}</style>`), "artifact styles may load only embedded data: URLs");
  invalid(page('<p style="background:url(https://evil.example/e.png)">x</p>'), "artifact styles may load only embedded data: URLs");
  expect(validateArtifactHtml(page('<p style="background:url(data:image/gif;base64,AA==)">x</p>', '<style>.a{filter:url(#f);background:url("data:image/png;base64,AA==")}</style>')).ok).toBe(true);
});

// ---- the bootstrap's functions, inlined ----

// A page with just what the guard takes from it, in a realm of its own (node:vm), so the guard runs
// from its source alone, as in a browser: a value of its module it reached for would be a
// ReferenceError here. `trace` is a string: the page's tampering below can't reach a string's `+`.
const FAKE_PAGE = `
var trace = "", notify = null, XHTML = "http://www.w3.org/1999/xhtml";
class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } }
class Node {}
Object.defineProperty(Node.prototype, "parentNode", { get() { return this.parent ?? null; } });
Object.defineProperty(Node.prototype, "nodeType", { get() { return this.type; } });
Node.prototype.removeChild = function (child) { trace += "remove " + child.name + ";"; child.parent = null; return child; };
class Element extends Node {}
Object.defineProperty(Element.prototype, "localName", { get() { return this.name; } });
Object.defineProperty(Element.prototype, "namespaceURI", { get() { return this.ns; } });
Element.prototype.attachShadow = function () { const root = new Node(); root.type = 11; root.name = "#shadow"; root.children = []; return root; };
Element.prototype.setHTMLUnsafe = function () { trace += "setHTMLUnsafe;"; };
class ShadowRoot {}
ShadowRoot.prototype.setHTMLUnsafe = function () { trace += "setHTMLUnsafe;"; };
class MutationRecord {}
Object.defineProperty(MutationRecord.prototype, "addedNodes", { get() { return this.added; } });
class NodeList {}
Object.defineProperty(NodeList.prototype, "length", { get() { return this.items.length; } });
NodeList.prototype.item = function (k) { return this.items[k]; };
class TreeWalker {}
TreeWalker.prototype.nextNode = function () { return this.queue.shift() ?? null; };
class Document extends Node {}
const descendants = (node) => (node.children ?? []).flatMap((c) => [c].concat(descendants(c)));
Document.prototype.createTreeWalker = function (root) { const w = new TreeWalker(); w.queue = descendants(root); return w; };
Document.prototype.createElement = function (name) { trace += "create " + name + ";"; return element(name); };
Element.prototype.setAttribute = function (name, value) { trace += "set " + name + "=" + value + ";"; };
Document.prototype.createElementNS = function (ns, name) { trace += "createNS " + name + ";"; return null; };
for (const name of ["open", "write", "writeln"]) Document.prototype[name] = function () { trace += name + ";"; };
Document.parseHTMLUnsafe = function () { trace += "parseHTMLUnsafe;"; };
class MutationObserver { constructor(callback) { notify = callback; } }
// as a browser's: the options are read from the object given, and these two together are a TypeError
MutationObserver.prototype.observe = function (root, options) {
  if (options.characterDataOldValue && options.characterData === false) throw new TypeError("characterData is false");
  trace += "observe " + root.name + " " + options.childList + " " + options.subtree + ";";
};
const document = new Document();
document.type = 9;
document.name = "#document";
document.head = { append: (node) => { trace += "append " + node.name + ";"; } };
var RTCPeerConnection = function () {};
const element = (name, children = [], ns = XHTML) => { const e = new Element(); e.type = 1; e.name = name; e.ns = ns; e.children = children; for (const c of children) c.parent = e; return e; };
const added = (...nodes) => { const r = new MutationRecord(); r.added = new NodeList(); r.added.items = nodes; return r; };
const refused = (f) => { try { f(); return "ran"; } catch (e) { return e.name; } };
`;

// what the page then does: puts frames in (one SVG <object>, which is no frame), tampers with every
// prototype and global the guard might use later, and tries the ways it refuses
const HOSTILE = `
const frame = element("iframe");
const host = element("div", [element("p", [frame]), element("object", [], "http://www.w3.org/2000/svg")]);
host.parent = document;
const lone = element("embed");
lone.parent = document;
const shadowHost = element("div");
const records = [added(host), added(lone)];
Object.defineProperty(Array.prototype, "0", { configurable: true, set() {} });
Array.prototype[Symbol.iterator] = function* () {};
Set.prototype.has = () => false;
String.prototype.toLowerCase = () => "div";
String.prototype.slice = () => "div";
Reflect.apply = () => undefined;
Object.defineProperty(Object.prototype, "characterDataOldValue", { configurable: true, get() { return true; } });
Object.defineProperty(Object.prototype, "characterData", { configurable: true, get() { return false; } });
notify(records);
const shadow = shadowHost.attachShadow({ mode: "closed" });
JSON.stringify({
  rtc: typeof RTCPeerConnection,
  createElement: refused(() => document.createElement("IFRAME")),
  createElementObject: refused(() => document.createElement({ toString: () => "object" })),
  createElementNS: refused(() => document.createElementNS(XHTML, "x:iframe")),
  write: refused(() => document.write("<p>")),
  open: refused(() => document.open()),
  setHTMLUnsafe: refused(() => element("div").setHTMLUnsafe("<p>")),
  parseHTMLUnsafe: refused(() => Document.parseHTMLUnsafe("<p>")),
  div: refused(() => document.createElement("div")),
  shadow: shadow.name,
  trace,
})
`;

const onFakePage = (guard: string) => {
  const realm = createContext({});
  runInContext(FAKE_PAGE, realm);
  runInContext(guard, realm);
  const said: unknown = runInContext(HOSTILE, realm);
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(said);
};

const guardHolds = (guard: string) => {
  const result = onFakePage(guard);
  expect(result).toMatchObject({
    createElement: "NotSupportedError",
    createElementNS: "NotSupportedError",
    createElementObject: "NotSupportedError",
    div: "ran",
    open: "NotSupportedError",
    parseHTMLUnsafe: "NotSupportedError",
    rtc: "undefined",
    setHTMLUnsafe: "NotSupportedError",
    shadow: "#shadow",
    write: "NotSupportedError",
  });
  // the document and the closed shadow root watched; the iframe deep in the div and the lone embed
  // dropped, the SVG <object> kept; none of the refused calls reached the page's own natives
  expect(result.trace?.split(";").filter(Boolean)).toEqual(["observe #document true true", "remove iframe", "remove embed", "observe #shadow true true", "create div"]);
};

test("the bootstrap is its functions' own source, and the guard holds from it alone, whatever the page does to its prototypes", () => {
  const script = artifactBootstrap("ready</script><!--");
  expect(script).toStartWith("<script>");
  expect(script.indexOf("</script>")).toBe(script.length - "</script>".length);
  expect(script).not.toContain("<!--");
  for (const run of [noWebRtc, frameGuard, noScripts, heartbeat]) expect(script).toContain(run.toString());
  // WebRTC goes first, then the guard, then the heartbeat; it compiles as it is
  expect(script.indexOf("RTCPeerConnection")).toBeLessThan(script.indexOf("MutationObserver"));
  expect(script.indexOf("MutationObserver")).toBeLessThan(script.indexOf("heartbeat"));
  expect(() => new Script(script.slice("<script>".length, -"</script>".length))).not.toThrow();
  guardHolds(`${inline(noWebRtc)}try{${inline(frameGuard)}}catch{${inline(noScripts)}}`);
});

test("a page the guard can't be set up in runs no script of its own", () => {
  const realm = createContext({});
  // a browser whose MutationRecord has no addedNodes getter
  const getter = 'Object.defineProperty(MutationRecord.prototype, "addedNodes", { get() { return this.added; } });';
  expect(FAKE_PAGE).toContain(getter);
  runInContext(FAKE_PAGE.replace(getter, ""), realm);
  runInContext(artifactBootstrap().slice("<script>".length, -"</script>".length), realm);
  expect(runInContext("trace", realm)).toBe("create meta;set http-equiv=Content-Security-Policy;set content=script-src 'none';append meta;");
});

test("minified, the guard still takes the page's natives by their names and holds", async () => {
  const outdir = tmp();
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/artifacts/frame-guard.ts`, `${import.meta.dir}/../src/artifacts/bootstrap.ts`], minify: true, outdir, target: "browser" });
  expect(built.success).toBe(true);
  const Guard = Schema.Struct({ frameGuard: Schema.declare((u): u is () => void => Predicate.isFunction(u)) });
  const Rtc = Schema.Struct({ noWebRtc: Schema.declare((u): u is () => void => Predicate.isFunction(u)) });
  const minified = {
    ...Schema.decodeUnknownSync(Guard)(await import(`${outdir}/frame-guard.js`)),
    ...Schema.decodeUnknownSync(Rtc)(await import(`${outdir}/bootstrap.js`)),
  };
  expect(minified.frameGuard.toString()).not.toBe(frameGuard.toString());
  guardHolds(inline(minified.noWebRtc) + inline(minified.frameGuard));
});
