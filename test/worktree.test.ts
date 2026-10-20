// Isolated subagents' worktrees (SPEC "Subagents", E37): what a finish does, as a pure plan over its
// facts (a table), and in temporary git repositories only: the folder's own merge in progress is
// never touched, a folder that moved to another branch gets nothing, gitignored files keep the
// worktree, a repository outside the folders is refused at the add, and a dropped worktree goes
// with its branch.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { addWorktree, discardWorktree, type Facts, finishWorktree, plan } from "../src/worktree.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout.trim() };
};
// a repository with a.txt and b.txt on main, in a temporary folder; its worktrees beside it
const repo = () => {
  const top = realpathSync(mkdtempSync(`${tmpdir()}/oc-wtt-`));
  dirs.push(top);
  const folder = `${top}/repo`;
  mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  writeFileSync(`${folder}/a.txt`, "base\n");
  writeFileSync(`${folder}/b.txt`, "base\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "base");
  return { folder, root: `${top}/worktrees`, top };
};
const run = async <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

const facts = (f: Partial<Facts> = {}): Facts => ({ ahead: 1, busy: null, ff: false, from: "main", on: "main", tree: { clean: "abc" }, ...f });

test("the plan: nothing to merge, a fast-forward, a merge commit, or kept and why", () => {
  const b = "optchat/x";
  expect(plan(facts({ ahead: 0, busy: "a merge", on: null }), b)).toEqual({ do: "remove", outcome: "nothing" });
  expect(plan(facts({ ff: true, tree: null }), b)).toEqual({ do: "advance", outcome: "fast-forward" });
  expect(plan(facts(), b)).toEqual({ do: "advance", outcome: "merged" });
  expect(plan(facts({ tree: { conflicts: ["a.txt"] } }), b)).toEqual({ conflicts: ["a.txt"], do: "keep", outcome: "conflict", why: "optchat/x conflicts with main in a.txt" });
  // only into the branch it was made from, never while something else is in progress, never on no branch
  expect(plan(facts({ on: "release" }), b)).toMatchObject({ do: "keep", outcome: "not-merged", why: "the folder is on release now, not main, which optchat/x was made from, so it was not merged" });
  expect(plan(facts({ on: null }), b)).toMatchObject({ do: "keep", outcome: "not-merged" });
  expect(plan(facts({ from: null }), b)).toMatchObject({ do: "keep", outcome: "not-merged" });
  expect(plan(facts({ busy: "a merge", ff: true }), b)).toMatchObject({ do: "keep", outcome: "not-merged", why: "a merge is in progress in the folder, so optchat/x was not merged into main" });
  expect(plan(facts({ tree: { failed: "unknown option" } }), b)).toMatchObject({ do: "keep", outcome: "not-merged" });
});

test("the folder's own merge in progress is never touched: the branch is kept, the half-resolved files stay", async () => {
  const { folder, root, top } = repo();
  const w = await run(addWorktree(root, folder, "Scout", [top]));
  writeFileSync(`${w.path}/c.txt`, "scout's work\n");
  // the user merges a branch that conflicts on a.txt, and is halfway through resolving it
  git(folder, "checkout", "-qb", "feature");
  writeFileSync(`${folder}/a.txt`, "feature\n");
  git(folder, "commit", "-qam", "feature");
  git(folder, "checkout", "-q", "main");
  writeFileSync(`${folder}/a.txt`, "main\n");
  git(folder, "commit", "-qam", "main");
  expect(git(folder, "merge", "feature").code).not.toBe(0);
  writeFileSync(`${folder}/a.txt`, "carefully resolved by hand\n");
  const mergeHead = git(folder, "rev-parse", "MERGE_HEAD").out;
  const merge = await run(finishWorktree(w, "Scout"));
  expect(merge).toMatchObject({ into: "main", outcome: "not-merged" });
  expect(merge.detail).toContain("a merge is in progress in the folder");
  expect(git(folder, "rev-parse", "MERGE_HEAD").out).toBe(mergeHead);
  expect(readFileSync(`${folder}/a.txt`, "utf8")).toBe("carefully resolved by hand\n");
  expect(existsSync(w.path)).toBe(true);
  // the user concludes; the next finish merges, off the working tree
  git(folder, "commit", "-qam", "resolved");
  const later = await run(finishWorktree(w, "Scout"));
  expect(later).toMatchObject({ into: "main", outcome: "merged" });
  expect(readFileSync(`${folder}/c.txt`, "utf8")).toBe("scout's work\n");
  expect(readFileSync(`${folder}/a.txt`, "utf8")).toBe("carefully resolved by hand\n");
});

test("a folder that moved to another branch gets nothing: the work is kept for the branch it came from", async () => {
  const { folder, root, top } = repo();
  git(folder, "branch", "release");
  writeFileSync(`${folder}/new-feature.txt`, "unreleased\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "unreleased feature on main");
  const w = await run(addWorktree(root, folder, "Fixer", [top]));
  expect(w.from).toBe("main");
  writeFileSync(`${w.path}/fix.txt`, "fix\n");
  git(folder, "checkout", "-q", "release");
  const merge = await run(finishWorktree(w, "Fixer"));
  expect(merge).toMatchObject({ into: "release", outcome: "not-merged" });
  expect(merge.detail).toContain("the folder is on release now, not main");
  expect(git(folder, "log", "--format=%s", "release").out).toBe("base");
  expect(existsSync(w.path)).toBe(true);
  // back on main, it merges there
  git(folder, "checkout", "-q", "main");
  expect(await run(finishWorktree(w, "Fixer"))).toMatchObject({ into: "main", outcome: "fast-forward" });
  expect(existsSync(`${folder}/fix.txt`)).toBe(true);
});

test("gitignored files keep the worktree after a merge, and the report says how many", async () => {
  const { folder, root, top } = repo();
  writeFileSync(`${folder}/.gitignore`, "notes/\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-qm", "ignore notes");
  const w = await run(addWorktree(root, folder, "Notes", [top]));
  mkdirSync(`${w.path}/notes`);
  writeFileSync(`${w.path}/notes/findings.md`, "an hour of findings\n");
  writeFileSync(`${w.path}/b.txt`, "b\n");
  const merge = await run(finishWorktree(w, "Notes"));
  expect(merge).toMatchObject({ ignored: 1, into: "main", outcome: "fast-forward" });
  expect(merge.detail).toContain(`kept: 1 ignored files in its worktree at ${w.path}`);
  expect(readFileSync(`${w.path}/notes/findings.md`, "utf8")).toBe("an hour of findings\n");
  expect(readFileSync(`${folder}/b.txt`, "utf8")).toBe("b\n");
  // finished again with nothing new: still kept while the ignored file is there
  expect(await run(finishWorktree(w, "Notes"))).toMatchObject({ ignored: 1, outcome: "nothing" });
});

test("a repository whose top folder is outside the folders can't be isolated; a dropped worktree goes with its branch", async () => {
  const { folder, root, top } = repo();
  mkdirSync(`${folder}/web`);
  const refused = await run(Effect.flip(addWorktree(root, `${folder}/web`, "Inner", [`${folder}/web`])));
  expect(refused.message).toBe(`${folder}/web is inside the repository ${folder}, which is outside this device's folders, so it can't be isolated`);
  const w = await run(addWorktree(root, folder, "Dropped", [top]));
  writeFileSync(`${w.path}/x.txt`, "x\n");
  git(w.path, "add", "-A");
  git(w.path, "commit", "-qm", "x");
  await run(discardWorktree(w));
  expect(existsSync(w.path)).toBe(false);
  expect(git(folder, "branch", "--list", "optchat/Dropped").out).toBe("");
  // so the name can be used again
  const again = await run(addWorktree(root, folder, "Dropped", [top]));
  expect(again.branch).toBe("optchat/Dropped");
});
