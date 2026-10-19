// From fx0 tests/design-draft.test.mjs (Apache-2.0, © Vercel, modified).
// Artifacts on the client (SPEC "Artifacts"): the live draft's pieces, ported from fx0's
// tests/design-draft.test.mjs (reconnect prefixes, gaps, a new attempt, the close held until the
// version is saved), the scriptless draft document from fx0's draft-preview, and what a tool row
// says of the version it made.
import { describe, expect, test } from "bun:test";
import { applyDraft, type DraftPiece, fileName, frameUrl, madeBy, noDrafts, savedOver } from "./artifacts.ts";
import { draftDocument, patchDraftDocument, renderable } from "./draft-preview.ts";
import type { Row } from "./rows.ts";

const piece = (delta: string, offset = 0, extra: Partial<DraftPiece> = {}): DraftPiece => ({ closed: false, delta, id: "call", name: "landing", offset, replace: false, runId: "1", tool: "publish", ...extra });

describe("drafts", () => {
  test("reconnect prefixes and overlap do not duplicate HTML, including unicode", () => {
    let state = applyDraft(noDrafts, piece("<body>😀"));
    state = applyDraft(state, piece("<body>😀<h1>Hello</h1>"));
    state = applyDraft(state, piece("<body>😀<h1>Hello</h1>"));
    expect(state.get("call")?.html).toBe("<body>😀<h1>Hello</h1>");
    expect(applyDraft(state, piece("bad", 100))).toBe(state); // a gap is not appended
    expect(applyDraft(state, piece("wrong", 0))).toBe(state); // a mismatched prefix is not appended
  });

  test("a piece from a later run starts the draft again; a whole page replaces it", () => {
    let state = applyDraft(noDrafts, piece("old"));
    expect(applyDraft(state, piece("x", 3, { runId: "9" }))).toBe(state); // not from its start
    state = applyDraft(state, piece("new", 0, { runId: "9" }));
    expect(state.get("call")?.html).toBe("new");
    state = applyDraft(state, piece("<p>edited</p>", 0, { replace: true, tool: "edit" }));
    expect(state.get("call")?.html).toBe("<p>edited</p>");
  });

  test("a closed draft is held until its artifact is saved, and accepts no more", () => {
    let state = applyDraft(noDrafts, piece("picture"));
    state = applyDraft(state, piece("", 7, { closed: true }));
    expect(state.get("call")).toMatchObject({ closed: true, html: "picture" });
    expect(savedOver(state, "other")).toBe(state);
    expect(savedOver(state, "LANDING").size).toBe(0);
    // one still streaming stays when another's version is saved
    const open = applyDraft(noDrafts, piece("x"));
    expect(savedOver(open, "landing")).toBe(open);
  });
});

describe("the draft document", () => {
  test("no script, handler, frame or remote load survives the cleaning", () => {
    const doc = draftDocument(
      '<!doctype html><html lang="en" onclick="x()"><head><meta http-equiv="refresh" content="0;url=https://e.x"><base href="https://e.x/"></head><body class="b" onload="steal()"><script>alert(1)</script><img src="https://e.x/a.png" onerror="x()"><img src="data:image/gif;base64,AA=="><a href="https://e.x" target="_blank">out</a><a href="#here">here</a><iframe src="https://e.x"></iframe><form action="/x"></form><svg><animate attributeName="href" to="javascript:x()"/></svg><p style="color:red">kept</p></body></html>',
    );
    expect(doc).not.toMatch(/<script|onerror|onclick|onload|<iframe|<form|<base|refresh|https:\/\/e\.x|target=|<animate/i);
    expect(doc).toContain('<p style="color:red">kept</p>');
    expect(doc).toContain('src="data:image/gif;base64,AA=="');
    expect(doc).toContain('href="#here"');
    expect(doc).toContain('<html lang="en">');
    expect(doc).toContain('<body class="b">');
    expect(doc).toContain("script-src 'none'");
  });

  test("a patch keeps what is drawn already and adds what came", () => {
    const target = document.implementation.createHTMLDocument("draft");
    patchDraftDocument(target, '<!doctype html><html><head></head><body><h1 id="t">One</h1>');
    const heading = target.getElementById("t");
    patchDraftDocument(target, '<!doctype html><html><head></head><body><h1 id="t">One</h1><p>two</p></body></html>');
    expect(target.getElementById("t")).toBe(heading);
    expect(target.body.textContent).toBe("Onetwo");
  });

  test("it takes over only once the body has started", () => {
    expect(renderable("<!doctype html><html><head><style>")).toBe(false);
    expect(renderable("<!doctype html><html><head></head><body>")).toBe(false);
    expect(renderable("<!doctype html><html><head></head><body><h1>")).toBe(true);
  });
});

const row = (name: string, args: string, output: string | null, failed = false, id = 7): Row => ({ args, failed, id, key: `e${id}`, kind: "tool", name, output });

describe("a tool row's artifact", () => {
  const list = [{ name: "landing", versions: [{ by: "publish" as const, bytes: 2048, date: "2026-10-19T10:00:00.000Z", v: 1 }] }];

  test("a publish row names its artifact and the version its echo says it saved", () => {
    const made = madeBy(row("mcp__optchat__publish_artifact", '{"name":"landing","html":"<2.0 KB of HTML, not kept in the log: read_artifact>"}', "Published landing (2.0 KB) [v1]"), list);
    expect(made).toMatchObject({ name: "landing", tool: "publish", v: 1, version: { bytes: 2048 } });
  });

  test("the echo is the only record: a list that has not caught up gives no size yet; a running call no version", () => {
    expect(madeBy(row("edit_artifact", '{"name":"landing","edits":"<1 edit>"}', "Edited landing (2.1 KB) [v2]", false, 9), list)).toMatchObject({ tool: "edit", v: 2, version: null });
    expect(madeBy(row("edit_artifact", '{"name":"landing","edits":"<1 edit>"}', null), list)).toMatchObject({ v: null, version: null });
    // an unchanged publish names the version it found, never the next one
    expect(madeBy(row("publish_artifact", '{"name":"landing","html":"<1 KB>"}', "landing is unchanged: its latest version is this HTML already [v1]", false, 5), list)).toMatchObject({ v: 1 });
  });

  test("a name like plan-v2 is not a version", () => {
    expect(madeBy(row("mcp__optchat__publish_artifact", '{"name":"plan-v2","html":"<1 KB>"}', "Published plan-v2 (0.1 KB) [v1]", false, 12), [])?.v).toBe(1);
    // an echo in the old words says no version rather than the one in the name
    expect(madeBy(row("mcp__optchat__publish_artifact", '{"name":"plan-v2","html":"<1 KB>"}', "Published plan-v2 v1 (0.1 KB).", false, 12), [])?.v).toBeNull();
  });

  test("a refused call, a read and any other tool make no card", () => {
    expect(madeBy(row("publish_artifact", '{"name":"landing","html":"<1 KB>"}', "publish_artifact: artifact must start with <!doctype html>", true), list)).toBeNull();
    expect(madeBy(row("mcp__optchat__read_artifact", '{"name":"landing"}', "landing v1 of 1"), list)).toBeNull();
    expect(madeBy(row("Bash", '{"command":"ls"}', "x"), list)).toBeNull();
  });

  test("the routes and the file name", () => {
    expect(frameUrl("landing", null)).toBe("/artifact/frame?name=landing");
    expect(frameUrl("landing", 3)).toBe("/artifact/frame?name=landing&v=3");
    expect(fileName("landing", 3)).toBe("landing-v3.html");
  });
});
