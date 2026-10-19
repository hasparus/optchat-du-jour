// Isolated subagents' git worktrees (SPEC "Subagents", E37). `spawn(…, isolate: true)` gives a
// subagent a worktree of its own: branch `optchat/<Name>` from its folder's HEAD, at
// `<worktrees>/<Name>` on the same device, outside every repository (a repo's own tests, linters
// and watchers never see a copy of it). When a run ends cleanly its branch goes back into the
// folder's current branch by itself, a fast-forward or a clean merge, and the worktree and branch
// are removed; a conflict, or anything else in the way, keeps both and says why. Nothing here
// runs a shell: every git command has fixed arguments, with the names and paths as arguments of
// their own. The device runner runs the same code for its own folders (device/runner.ts, POST
// /worktree); the server's own device runs it in-process.
import { Data, Effect, Semaphore } from "effect";
import { existsSync, mkdirSync } from "node:fs";
import { gitEnv } from "./persist.ts";
import type { Isolation, Merge } from "./wire.ts";

export class WorktreeError extends Data.TaggedError("WorktreeError")<{ readonly message: string }> {}

// what a device does with worktrees: one made for a subagent, and one finished (merged back, or kept)
export type Worktrees = {
  readonly add: (folder: string, name: string) => Effect.Effect<Isolation, WorktreeError>;
  readonly finish: (worktree: Isolation, name: string) => Effect.Effect<Merge, WorktreeError>;
};

export const branchOf = (name: string) => `optchat/${name}`;

type Ran = { readonly code: number; readonly out: string; readonly err: string };

// how long one git command may take
const GIT_TIMEOUT = "2 minutes";

// Our own commits and merges in the user's repository never stop to ask for a key's passphrase
// and run no hooks (a hook that waits for input would hang the subagent's end); they are the
// user's own identity when git has one, else OptChat's.
const QUIET = ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null"];

const git = (dir: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: (error) => new WorktreeError({ message: `cannot run git: ${error instanceof Error ? error.message : String(error)}` }),
    try: async (signal): Promise<Ran> => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, env: gitEnv(), signal, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, err, out };
    },
  }).pipe(Effect.timeoutOrElse({ duration: GIT_TIMEOUT, orElse: () => Effect.fail(new WorktreeError({ message: `git ${args[0] ?? ""} took longer than ${GIT_TIMEOUT}` })) }));

const said = (r: Ran) => (r.err || r.out).trim() || `exit code ${r.code}`;

// a command that must succeed, its output trimmed
const must = (dir: string, args: readonly string[], what = `git ${args[0] ?? ""}`) =>
  git(dir, args).pipe(Effect.flatMap((r) => (r.code === 0 ? Effect.succeed(r.out.trim()) : Effect.fail(new WorktreeError({ message: `${what}: ${said(r)}` })))));

// the user's identity when git has one there, else OptChat's
const identity = (dir: string) =>
  git(dir, ["config", "user.email"]).pipe(Effect.map((r) => (r.code === 0 && r.out.trim() !== "" ? QUIET : [...QUIET, "-c", "user.name=OptChat", "-c", "user.email=optchat@localhost"])));

// " 3 files changed, 40 insertions(+), 2 deletions(-)"
export const shortstat = (text: string) => {
  const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
  return { deletions: n(/(\d+) deletions?\(-\)/), files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/) };
};

// A worktree for `name`: its folder's repository, at its HEAD, on a new branch optchat/<name>, at
// `<root>/<name>` (root already expanded, the device's own path). A folder that isn't in a git
// repository, or has no commit yet, can't be isolated; a branch or a path left from before is not
// taken over.
export const addWorktree = (root: string, folder: string, name: string) =>
  Effect.gen(function* () {
    const top = yield* git(folder, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return yield* new WorktreeError({ message: `${folder} is not in a git repository, so it can't be isolated: spawn without isolate to work there directly` });
    const repo = top.out.trim();
    const base = yield* git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (base.code !== 0) return yield* new WorktreeError({ message: `${repo} has no commit yet, so there is nothing to branch from: commit first, or spawn without isolate` });
    const branch = branchOf(name);
    const path = `${root.replace(/\/$/, "")}/${name}`;
    if (existsSync(path)) return yield* new WorktreeError({ message: `${path} exists already: remove it (git worktree remove) or pick another name` });
    const taken = yield* git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    if (taken.code === 0) return yield* new WorktreeError({ message: `the branch ${branch} exists already in ${repo}: delete it or pick another name` });
    yield* Effect.try({ catch: (e) => new WorktreeError({ message: `cannot make ${root}: ${String(e)}` }), try: () => mkdirSync(root, { recursive: true }) });
    const sha = base.out.trim();
    yield* must(repo, ["worktree", "add", "-q", "-b", branch, path, sha], "git worktree add");
    return { base: sha, branch, path, repo } satisfies Isolation;
  });

// the worktree and its branch go: the branch only when what it holds is in the folder's branch (-d)
const remove = (w: Isolation) =>
  must(w.repo, ["worktree", "remove", "--force", w.path], "git worktree remove").pipe(Effect.andThen(git(w.repo, ["branch", "-q", "-d", w.branch])), Effect.asVoid);

// The end of a clean run: what the subagent left uncommitted is committed on its branch (nothing is
// lost, and a merge carries all of it), then the branch goes into the folder's current branch, a
// fast-forward when it can, else a merge commit when git finds no conflict (checked first with
// merge-tree, so a conflict never touches the folder's files); then the worktree and the branch
// are removed. Kept, and said why: a conflict (the files), a folder on no branch, or a merge git
// refuses (local changes in the way). The folder's own uncommitted work is never touched: git
// refuses a merge that would overwrite it.
export const finishWorktree = (w: Isolation, name: string) =>
  Effect.gen(function* () {
    const left = yield* must(w.path, ["status", "--porcelain"]);
    let note = "";
    if (left !== "") {
      const who = yield* identity(w.path);
      yield* must(w.path, ["add", "-A"]);
      yield* must(w.path, [...who, "commit", "-q", "-m", `${name}: work left uncommitted when it ended`], "git commit");
      note = `; its uncommitted changes (${left.split("\n").length} paths) were committed on ${w.branch} first`;
    }
    const stat = shortstat(yield* must(w.repo, ["diff", "--shortstat", w.base, w.branch]));
    const ahead = Number(yield* must(w.repo, ["rev-list", "--count", `HEAD..${w.branch}`]));
    const result = (outcome: Merge["outcome"], into: string | null, detail: string, conflicts?: readonly string[]): Merge => {
      const merge: Merge = { ...stat, detail: `${detail}${note}`, into, outcome };
      return conflicts === undefined ? merge : { ...merge, conflicts: [...conflicts] };
    };
    if (ahead === 0) {
      yield* remove(w);
      return result("nothing", null, `${w.branch} has nothing the folder lacks; its worktree is removed`);
    }
    const head = yield* git(w.repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (head.code !== 0) return result("not-merged", null, `${w.repo} is on no branch (a detached HEAD), so ${w.branch} was not merged; it is kept with its worktree at ${w.path}`);
    const into = head.out.trim();
    const kept = `${w.branch} is kept with its worktree at ${w.path}`;
    const ff = yield* git(w.repo, ["merge-base", "--is-ancestor", "HEAD", w.branch]);
    if (ff.code === 0) {
      const done = yield* git(w.repo, ["merge", "--ff-only", "-q", w.branch]);
      if (done.code !== 0) return result("not-merged", into, `git refused to fast-forward ${into} (${said(done)}); ${kept}`);
      yield* remove(w);
      return result("fast-forward", into, `${into} fast-forwarded to ${w.branch}; its worktree and branch are removed`);
    }
    // a conflict is found without touching the folder; a git without merge-tree --write-tree (before
    // 2.38) answers neither 0 nor 1, and the merge below finds it instead
    const tree = yield* git(w.repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", w.branch]);
    if (tree.code === 1) {
      const files = tree.out.trim().split("\n").slice(1).filter((f) => f !== "");
      return result("conflict", into, `${w.branch} conflicts with ${into} in ${files.join(", ") || "some files"}; ${kept}`, files);
    }
    const who = yield* identity(w.repo);
    const merged = yield* git(w.repo, [...who, "merge", "--no-ff", "--no-edit", "-q", "-m", `Merge ${w.branch} (subagent ${name})`, w.branch]);
    if (merged.code !== 0) {
      const midway = yield* git(w.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      if (midway.code === 0) yield* git(w.repo, ["merge", "--abort"]);
      return result(midway.code === 0 ? "conflict" : "not-merged", into, `git did not merge ${w.branch} into ${into} (${said(merged)}); ${kept}`);
    }
    yield* remove(w);
    return result("merged", into, `${w.branch} merged into ${into}; its worktree and branch are removed`);
  });

// This machine's worktrees, under `root` (expanded). One finish at a time per repository: two
// merges into one folder at once would fight over its index.lock, and the second must see the
// first's commit to know it no longer fast-forwards.
export const localWorktrees = (root: string): Worktrees => {
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (repo: string) => {
    const found = locks.get(repo);
    if (found) return found;
    const made = Semaphore.makeUnsafe(1);
    locks.set(repo, made);
    return made;
  };
  return {
    add: (folder, name) => addWorktree(root, folder, name),
    finish: (w, name) => lockOf(w.repo).withPermit(finishWorktree(w, name)),
  };
};
