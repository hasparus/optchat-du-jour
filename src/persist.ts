// The data dir is its own git repo, committed after every turn (ref §10 "Git") and
// pushed when it has a remote (E10). Git is a backup here, never a reason to fail a turn: every
// problem comes back as a message for the caller to show. The push runs in the background, so an
// unreachable remote never holds up the end of a turn.
import { Effect, type Scope, Semaphore } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitFailed, must as mustRun, run, said } from "./git.ts";

// every command commits as optchat itself (the data dir's own identity)
const must = (dir: string, args: readonly string[]) => mustRun(dir, args, "own");

// whether anything is staged: `diff --quiet` says so by its exit code
const staged = (dir: string) => {
  const args = ["diff", "--quiet", "--cached"];
  return run(dir, args).pipe(Effect.flatMap((r) => (r.code <= 1 ? Effect.succeed(r.code === 1) : Effect.fail(new GitFailed({ message: `git diff: ${said(r)}` })))));
};

const files = (what: string, f: () => void) =>
  Effect.try({ catch: (error) => new GitFailed({ message: `${what}: ${error instanceof Error ? error.message : String(error)}` }), try: f });

// how long a whole commit or push may take
const GIT_TIMEOUT = "2 minutes";
const inTime = <A, R>(work: Effect.Effect<A, GitFailed, R>) =>
  work.pipe(Effect.timeoutOrElse({ duration: GIT_TIMEOUT, orElse: () => Effect.fail(new GitFailed({ message: `git took longer than ${GIT_TIMEOUT}` })) }));

// Files that stay out of a commit though they are new: a block in the repo's own .git/info/exclude
// (never committed), the rest of that file kept. Only untracked files are affected, so one already
// committed stays. The block is written whole each time: a file named in it earlier and named by
// a message since is in the next commit.
const OUT_BEGIN = "# optchat: left out of commits";
const OUT_END = "# optchat: end";
const leaveOut = (dir: string, paths: readonly string[]) =>
  files("git exclude", () => {
    const file = join(dir, ".git", "info", "exclude");
    const old = existsSync(file) ? readFileSync(file, "utf8") : "";
    const begin = old.indexOf(OUT_BEGIN);
    const end = old.indexOf(OUT_END);
    const kept = begin === -1 || end < begin ? old : `${old.slice(0, begin)}${old.slice(end + OUT_END.length).replace(/^\n/, "")}`;
    if (paths.length === 0 && kept === old) return;
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    const block = paths.length === 0 ? "" : `${OUT_BEGIN}\n${paths.join("\n")}\n${OUT_END}\n`;
    writeFileSync(file, `${kept}${kept === "" || kept.endsWith("\n") ? "" : "\n"}${block}`);
  });

const save = (dir: string, message: string, leftOut: readonly string[]) =>
  Effect.gen(function* () {
    // created first if missing (a fresh machine): git needs a directory to run in
    yield* files(dir, () => {
      mkdirSync(dir, { mode: 0o700, recursive: true });
    });
    const has = (name: string) => existsSync(join(dir, name));
    // its own repo even inside another one, so `add -A` never reaches past the data dir
    if (!has(".git")) yield* must(dir, ["init", "-q"]);
    // the lock is a socket that lives as long as its process: never history
    if (!has(".gitignore"))
      yield* files(".gitignore", () => {
        writeFileSync(join(dir, ".gitignore"), "lock\n");
      });
    yield* leaveOut(dir, leftOut);
    yield* must(dir, ["add", "-A"]);
    if (yield* staged(dir)) yield* must(dir, ["commit", "-q", "--no-verify", "-m", message]);
  }).pipe(inTime);

// HEAD to the remote ("origin", else the first one), if there is one
const push = (dir: string) =>
  Effect.gen(function* () {
    const remotes = (yield* must(dir, ["remote"])).out.split("\n").filter((name) => name !== "");
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (remote) yield* must(dir, ["push", "-q", remote, "HEAD"]);
  }).pipe(inTime);

// `persist(dir, message)`: an error message, or null once the data dir is committed. Each commit
// is then pushed in the background, one push at a time: commits made during a push are pushed
// by one more after it. A failing push is reported once, until a push goes through again.
// `leftOut`: paths (git's, from the repo's root, "/assets/ab/<sha>.jpg") not to commit yet, asked
// for at each commit: the uploads no logged message names (src/media/media.ts `unreferenced`).
export const makePersist = (report: (message: string) => Effect.Effect<void>, leftOut: () => readonly string[] = () => []) =>
  Effect.gen(function* () {
    // a single commit at once: two in the same repo would fight over index.lock (a push takes none)
    const one = yield* Semaphore.make(1);
    const scope: Scope.Scope = yield* Effect.scope;
    let pushing = false;
    let next: string | null = null; // a dir to push once the push going on is done
    let failing = false;
    const pushes: Effect.Effect<void> = Effect.suspend(() => {
      const dir = next;
      next = null;
      if (dir === null) return Effect.sync(() => (pushing = false));
      return push(dir).pipe(
        Effect.matchEffect({
          onFailure: (error) => (failing ? Effect.void : Effect.sync(() => (failing = true)).pipe(Effect.andThen(report(`git: ${error.message}`)))),
          onSuccess: () => Effect.sync(() => (failing = false)),
        }),
        Effect.andThen(pushes),
      );
    });
    const pushSoon = (dir: string) =>
      Effect.suspend(() => {
        next = dir;
        if (pushing) return Effect.void;
        pushing = true;
        return pushes.pipe(Effect.forkIn(scope), Effect.asVoid);
      });
    return (dir: string, message: string): Effect.Effect<string | null> =>
      one.withPermit(Effect.suspend(() => save(dir, message, leftOut()))).pipe(
        Effect.andThen(pushSoon(dir)), // also when nothing new was committed: a push that failed goes out again
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
  });
