// Isolated subagents' git worktrees (SPEC "Subagents", E37). `spawn(…, isolate: true)` gives a
// subagent a worktree of its own: branch `optchat/<Name>` from its folder's HEAD, at
// `<worktrees>/<Name>` on the same device, outside every repository (a repo's own tests, linters
// and watchers never see a copy of it). When a run ends cleanly its branch goes back into the
// branch the folder was on when the worktree was made, and only that one: a fast-forward, or a
// merge commit built off the working tree (`git merge-tree`, `git commit-tree`); the folder then
// moves only by `git merge --ff-only` to that commit, a compare-and-swap that refuses when HEAD
// moved meanwhile, a merge is in progress, or local changes are in the way. No merge ever runs
// in the folder's working tree, and nothing is ever aborted there. Then the worktree and branch
// are removed, unless gitignored files other than disposable ones (DISPOSABLE) are in the
// worktree. A conflict, or anything else in the
// way, keeps both and says why. Every git command has fixed arguments (src/git.ts). The device
// runner runs the same code for its own folders (device/runner.ts, POST /worktree); the server's
// own device runs it in-process. Which of these happens is `plan`, a pure function of the facts
// gathered first.
import { Data, Effect, Semaphore } from "effect";
import { existsSync, mkdirSync } from "node:fs";
import { type GitFailed, must as gitMust, run, said } from "./git.ts";
import { realInside } from "./paths.ts";
import { type Isolation, type Merge, worktreeKept } from "./wire.ts";

export class WorktreeError extends Data.TaggedError("WorktreeError")<{ readonly message: string }> {}

// what a device does with worktrees: one made for a subagent, one finished (merged back, or kept),
// and one dropped (a spawn that failed after making it)
export type Worktrees = {
  readonly add: (folder: string, name: string) => Effect.Effect<Isolation, WorktreeError>;
  readonly finish: (worktree: Isolation, name: string) => Effect.Effect<Merge, WorktreeError>;
  readonly discard: (worktree: Isolation) => Effect.Effect<void, WorktreeError>;
};

export const branchOf = (name: string) => `optchat/${name}`;

const asError = (e: GitFailed) => new WorktreeError({ message: e.message });
const git = (dir: string, args: readonly string[], identity: "user" | "none" = "none") => run(dir, args, identity).pipe(Effect.mapError(asError));
const must = (dir: string, args: readonly string[], identity: "user" | "none" = "none") =>
  gitMust(dir, args, identity).pipe(
    Effect.map((r) => r.out.trim()),
    Effect.mapError(asError),
  );

// " 3 files changed, 40 insertions(+), 2 deletions(-)"
export const shortstat = (text: string) => {
  const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
  return { deletions: n(/(\d+) deletions?\(-\)/), files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/) };
};

// A worktree for `name`: its folder's repository, at its HEAD, on a new branch optchat/<name>, at
// `<root>/<name>` (root already expanded, the device's own path). The repository's top folder must
// be inside `folders` (the device's, its worktree root included), the same rule a finish is held to,
// so a worktree is never made that can't be finished. A folder that isn't in a git repository, or
// has no commit yet, can't be isolated; a branch or a path left from before is not taken over. The
// branch the folder is on is kept (`from`): the run's work goes back into it and no other.
export const addWorktree = (root: string, folder: string, name: string, folders: readonly string[]) =>
  Effect.gen(function* () {
    const top = yield* git(folder, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return yield* new WorktreeError({ message: `${folder} is not in a git repository, so it can't be isolated: spawn without isolate to work there directly` });
    const repo = top.out.trim();
    if (realInside(repo, folders) === null) return yield* new WorktreeError({ message: `${folder} is inside the repository ${repo}, which is outside this device's folders, so it can't be isolated` });
    const base = yield* git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (base.code !== 0) return yield* new WorktreeError({ message: `${repo} has no commit yet, so there is nothing to branch from: commit first, or spawn without isolate` });
    const on = yield* git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const branch = branchOf(name);
    const path = `${root.replace(/\/$/, "")}/${name}`;
    if (existsSync(path)) return yield* new WorktreeError({ message: `${path} exists already: remove it (git worktree remove) or pick another name` });
    const taken = yield* git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    if (taken.code === 0) return yield* new WorktreeError({ message: `the branch ${branch} exists already in ${repo}: delete it or pick another name` });
    yield* Effect.try({ catch: (e) => new WorktreeError({ message: `cannot make ${root}: ${String(e)}` }), try: () => mkdirSync(root, { recursive: true }) });
    const sha = base.out.trim();
    yield* must(repo, ["worktree", "add", "-q", "-b", branch, path, sha]);
    return { base: sha, branch, from: on.code === 0 ? on.out.trim() : null, path, repo } satisfies Isolation;
  });

// ---- the finish: facts, then a plan, then one move ----

// What the finish sees once the worktree's leftovers are committed: how many commits the branch
// has that the folder's HEAD lacks, the folder's branch now and the one the worktree was made from,
// an operation in progress in the folder (a merge, a cherry-pick, a rebase), whether the folder's
// HEAD is an ancestor of the branch (a fast-forward), and else what merge-tree made of the two:
// a clean tree, the files in conflict, or why it couldn't say.
export type Facts = {
  readonly ahead: number;
  readonly on: string | null;
  readonly from: string | null;
  readonly busy: string | null;
  readonly ff: boolean;
  readonly tree: { readonly clean: string } | { readonly conflicts: readonly string[] } | { readonly failed: string } | null;
};

export type Plan =
  | { readonly do: "remove"; readonly outcome: "nothing" }
  | { readonly do: "advance"; readonly outcome: "fast-forward" | "merged" }
  | { readonly do: "keep"; readonly outcome: "conflict" | "not-merged"; readonly why: string; readonly conflicts?: readonly string[] };

// What to do with a finished worktree, `branch` naming it in the reasons
export const plan = (f: Facts, branch: string): Plan => {
  if (f.ahead === 0) return { do: "remove", outcome: "nothing" };
  if (f.from === null) return { do: "keep", outcome: "not-merged", why: `the folder was on no branch when ${branch} was made, so there is no branch to merge it into` };
  if (f.on === null) return { do: "keep", outcome: "not-merged", why: `the folder is on no branch now (a detached HEAD), so ${branch} was not merged into ${f.from}` };
  if (f.on !== f.from) return { do: "keep", outcome: "not-merged", why: `the folder is on ${f.on} now, not ${f.from}, which ${branch} was made from, so it was not merged` };
  if (f.busy !== null) return { do: "keep", outcome: "not-merged", why: `${f.busy} is in progress in the folder, so ${branch} was not merged into ${f.on}` };
  if (f.ff) return { do: "advance", outcome: "fast-forward" };
  if (f.tree === null) return { do: "keep", outcome: "not-merged", why: `git could not tell whether ${branch} merges into ${f.on}` };
  if ("conflicts" in f.tree) return { conflicts: f.tree.conflicts, do: "keep", outcome: "conflict", why: `${branch} conflicts with ${f.on} in ${f.tree.conflicts.join(", ") || "some files"}` };
  if ("failed" in f.tree) return { do: "keep", outcome: "not-merged", why: `git could not merge ${branch} into ${f.on} off the working tree (${f.tree.failed})` };
  return { do: "advance", outcome: "merged" };
};

// what is in progress in the folder's repository, by the files git keeps for it; null: nothing
const inProgress = (repo: string) =>
  Effect.gen(function* () {
    for (const [ref, what] of [
      ["MERGE_HEAD", "a merge"],
      ["CHERRY_PICK_HEAD", "a cherry-pick"],
      ["REVERT_HEAD", "a revert"],
      ["REBASE_HEAD", "a rebase"],
    ] as const) {
      const r = yield* git(repo, ["rev-parse", "-q", "--verify", ref]);
      if (r.code === 0) return what;
    }
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const at = yield* must(repo, ["rev-parse", "--git-path", dir]);
      if (existsSync(at.startsWith("/") ? at : `${repo}/${at}`)) return "a rebase";
    }
    return null;
  });

// Gitignored files a finish deletes with the worktree, by name at any depth: what a tool or a build
// makes again (dependencies, caches, build output, Finder's litter), plus `subagents.disposable`.
// Any other ignored file (notes, .env.local, output the task asked for) keeps the worktree. A name
// may hold `*`, any run of characters within it.
export const DISPOSABLE: readonly string[] = ["node_modules", "__pycache__", "*.pyc", ".venv", ".pytest_cache", ".next", ".turbo", "dist", "build", "target", ".DS_Store"];
const nameRe = (glob: string) => new RegExp(`^${glob.split("*").map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("[^/]*")}$`);
export const disposable = (extra: readonly string[] = []) => {
  const names = [...DISPOSABLE, ...extra].map(nameRe);
  return (path: string) => path.split("/").some((part) => part !== "" && names.some((re) => re.test(part)));
};

// gitignored files in the worktree that aren't disposable: each path an ignore rule matches
// (`--ignored=matching`; a directory it matches counts once, whatever it holds, and is disposable
// when its own path is)
const ignoredIn = (path: string, isDisposable: (path: string) => boolean) =>
  must(path, ["status", "--porcelain", "-z", "--ignored=matching"]).pipe(Effect.map((out) => out.split("\0").filter((l) => l.startsWith("!! ") && !isDisposable(l.slice(3))).length));

// the worktree and its branch go: the branch only when what it holds is in the folder's branch (-d)
const remove = (w: Isolation) => must(w.repo, ["worktree", "remove", "--force", w.path]).pipe(Effect.andThen(git(w.repo, ["branch", "-q", "-d", w.branch])), Effect.asVoid);

// The end of a clean run (`plan` says what happens): what the subagent left uncommitted is
// committed on its branch first (nothing is lost, and the merge carries all of it); then the folder
// moves by `--ff-only` to the branch's tip, or to a merge commit made off the working tree; then
// the worktree and branch go, unless gitignored files other than disposable ones are in the
// worktree, which are kept with it.
export const finishWorktree = (w: Isolation, name: string, isDisposable = disposable()) =>
  Effect.gen(function* () {
    const left = yield* must(w.path, ["status", "--porcelain"]);
    let note = "";
    if (left !== "") {
      yield* must(w.path, ["add", "-A"]);
      yield* must(w.path, ["commit", "-q", "-m", `${name}: work left uncommitted when it ended`], "user");
      note = `; its uncommitted changes (${left.split("\n").length} paths) were committed on ${w.branch} first`;
    }
    const stat = shortstat(yield* must(w.repo, ["diff", "--shortstat", w.base, w.branch]));
    const head = yield* must(w.repo, ["rev-parse", "HEAD"]);
    const tip = yield* must(w.repo, ["rev-parse", w.branch]);
    const ahead = Number(yield* must(w.repo, ["rev-list", "--count", `${head}..${tip}`]));
    const on = yield* git(w.repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const ff = (yield* git(w.repo, ["merge-base", "--is-ancestor", head, tip])).code === 0;
    // a conflict is found without touching the folder: exit 1 (a git without --write-tree, before
    // 2.38, answers otherwise, and the branch is kept)
    let tree: Facts["tree"] = null;
    if (!ff && ahead > 0) {
      const t = yield* git(w.repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", head, tip]);
      const [oid = "", ...files] = t.out.trim().split("\n");
      tree = t.code === 0 ? { clean: oid } : t.code === 1 ? { conflicts: files.filter((f) => f !== "") } : { failed: said(t) };
    }
    const facts: Facts = { ahead, busy: yield* inProgress(w.repo), ff, from: w.from ?? null, on: on.code === 0 ? on.out.trim() : null, tree };
    const into = facts.on;
    const kept = `${w.branch} is kept with its worktree at ${w.path}`;
    const merge = (outcome: Merge["outcome"], detail: string, more: { readonly conflicts?: readonly string[]; readonly ignored?: number } = {}): Merge => {
      const m: Merge = { ...stat, detail: `${detail}${note}`, into, outcome };
      const withConflicts = more.conflicts === undefined ? m : { ...m, conflicts: [...more.conflicts] };
      return more.ignored === undefined ? withConflicts : { ...withConflicts, ignored: more.ignored };
    };
    // the worktree and branch go once their work is in, unless ignored files would go with them
    const done = (outcome: "nothing" | "fast-forward" | "merged", detail: string) =>
      Effect.gen(function* () {
        const ignored = yield* ignoredIn(w.path, isDisposable);
        if (ignored > 0) return merge(outcome, `${detail}; kept: ${ignored} ignored files in its worktree at ${w.path}, which git worktree remove --force deletes`, { ignored });
        yield* remove(w);
        return merge(outcome, `${detail}; its worktree and branch are removed`);
      });
    const p = plan(facts, w.branch);
    if (p.do === "keep") return merge(p.outcome, `${p.why}; ${kept}`, p.conflicts === undefined ? {} : { conflicts: p.conflicts });
    if (p.do === "remove") return yield* done("nothing", `${w.branch} has nothing the folder lacks`);
    // the merge commit, made off the working tree, with the folder's HEAD and the branch as parents
    const target =
      p.outcome === "fast-forward" || tree === null || !("clean" in tree)
        ? tip
        : yield* must(w.repo, ["commit-tree", tree.clean, "-p", head, "-p", tip, "-m", `Merge ${w.branch} (subagent ${name})`], "user");
    // the one write to the folder: a compare-and-swap that refuses if HEAD moved since `head`
    const moved = yield* git(w.repo, ["merge", "--ff-only", "-q", target]);
    if (moved.code !== 0) return merge("not-merged", `git did not move ${into ?? "the folder"} to ${p.outcome === "merged" ? "the merge commit" : w.branch} (${said(moved)}); ${kept}`);
    return yield* done(p.outcome, p.outcome === "merged" ? `${w.branch} merged into ${into ?? "the folder's branch"}` : `${into ?? "the folder's branch"} fast-forwarded to ${w.branch}`);
  });

// a worktree made for a spawn that then failed: removed, with its branch, whatever they hold
export const discardWorktree = (w: Isolation) => must(w.repo, ["worktree", "remove", "--force", w.path]).pipe(Effect.andThen(git(w.repo, ["branch", "-q", "-D", w.branch])), Effect.asVoid);

// This machine's worktrees, under `root` (expanded), for repositories inside `folders`; `extra`
// names more ignored files a finish may delete (subagents.disposable). One finish
// at a time per repository: two at once would race for the folder's HEAD (the second's --ff-only
// would refuse, and its branch be kept for nothing). Never interrupted halfway: a stop, a restart or
// a dropped link waits for git to finish, and a finish asked again is safe (nothing to merge).
export const localWorktrees = (root: string, folders: readonly string[], extra: readonly string[] = []): Worktrees => {
  const isDisposable = disposable(extra);
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (repo: string) => {
    const found = locks.get(repo);
    if (found) return found;
    const made = Semaphore.makeUnsafe(1);
    locks.set(repo, made);
    return made;
  };
  const allowed = [...folders, root];
  return {
    add: (folder, name) => Effect.uninterruptible(addWorktree(root, folder, name, allowed)),
    discard: (w) => Effect.uninterruptible(discardWorktree(w)),
    finish: (w, name) => Effect.uninterruptible(lockOf(w.repo).withPermit(finishWorktree(w, name, isDisposable))),
  };
};

// ---- an isolated subagent's worktree over its runs (src/subagents.ts) ----

// a merge that couldn't be tried: kept, and why
export const notMerged = (w: Isolation, message: string): Merge => ({
  deletions: 0,
  detail: `not merged (${message}); ${w.branch} is kept with its worktree at ${w.path}`,
  files: 0,
  insertions: 0,
  into: null,
  outcome: "not-merged",
});

// The worktree a run of an isolated subagent works in: its own while it has one (on this machine,
// while its path is there), else a new one from its folder's HEAD (spawned, merged back, or gone)
export const ensureWorktree = (trees: Worktrees | undefined, a: { readonly name: string; readonly folder: string; readonly worktree: Isolation | null; readonly local: boolean }) =>
  Effect.gen(function* () {
    if (a.worktree !== null && (!a.local || existsSync(a.worktree.path))) return a.worktree;
    if (trees === undefined) return yield* new WorktreeError({ message: "this device can't make worktrees" });
    return yield* trees.add(a.folder, a.name);
  });

// A clean run's branch back into its folder: the merge, and the worktree the subagent still has
// (none once it is gone). Never fails: a failure is the merge's answer, the branch kept.
export const mergeBack = (trees: Worktrees | undefined, w: Isolation, name: string) =>
  (trees === undefined ? Effect.succeed(notMerged(w, "this device can't merge worktrees")) : trees.finish(w, name).pipe(Effect.catch((error) => Effect.succeed(notMerged(w, error.message))))).pipe(
    Effect.map((merge) => ({ merge, worktree: worktreeKept(merge) ? w : null })),
  );
