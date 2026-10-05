// The data dir is its own git repo, committed after every turn (gist §10, ref §10 "Git") and
// pushed when it has a remote (E10). Git is a backup here, never a reason to fail a turn: every
// problem comes back as a message for the caller to show.
import { Data, Effect, Semaphore } from "effect";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

class GitFailed extends Data.TaggedError("GitFailed")<{ readonly message: string }> {}

// Run from inside a git hook, git exports where *that* repo lives; a child git would then commit
// there instead of in the data dir. These are dropped from every git we run.
const REPO_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX"]);

const gitEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !REPO_VARS.has(k)) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0"; // a push without credentials fails instead of asking
  return env;
};

// A fixed author and no signing, so a commit works on a machine with no git identity and never
// stops to ask for a key's passphrase. Hooks a global config may name are not ours to run.
const OWN = ["-c", "user.name=optchat", "-c", "user.email=optchat@localhost", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null"];

type Ran = { readonly code: number; readonly out: string; readonly err: string };

// one git command in `dir`; interrupting it kills the process
const git = (dir: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: (error) => new GitFailed({ message: `cannot run git: ${error instanceof Error ? error.message : String(error)}` }),
    try: async (signal): Promise<Ran> => {
      const proc = Bun.spawn(["git", ...OWN, ...args], { cwd: dir, env: gitEnv(), signal, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, err, out };
    },
  });

const failed = (args: readonly string[], r: Ran) =>
  new GitFailed({ message: `git ${args[0] ?? ""}: ${(r.err || r.out).trim() || `exit code ${r.code}`}` });

// a command that must succeed: its stderr becomes the message when it doesn't
const must = (dir: string, args: readonly string[]) =>
  git(dir, args).pipe(Effect.flatMap((r) => (r.code === 0 ? Effect.succeed(r) : Effect.fail(failed(args, r)))));

// whether anything is staged: `diff --quiet` says so by its exit code
const staged = (dir: string) => {
  const args = ["diff", "--cached", "--quiet"];
  return git(dir, args).pipe(Effect.flatMap((r) => (r.code <= 1 ? Effect.succeed(r.code === 1) : Effect.fail(failed(args, r)))));
};

const files = (what: string, f: () => void) =>
  Effect.try({ catch: (error) => new GitFailed({ message: `${what}: ${error instanceof Error ? error.message : String(error)}` }), try: f });

// how long one git command may take; a push to an unreachable remote must not hold the turn loop
const GIT_TIMEOUT = "2 minutes";

const save = (dir: string, message: string) =>
  Effect.gen(function* () {
    yield* files(dir, () => {
      mkdirSync(dir, { recursive: true });
    });
    // its own repo even inside another one, so `add -A` never reaches past the data dir
    if (!existsSync(`${dir}/.git`)) yield* must(dir, ["init", "-q"]);
    // the lock is a socket that lives as long as its process: never history
    if (!existsSync(`${dir}/.gitignore`))
      yield* files(".gitignore", () => {
        writeFileSync(`${dir}/.gitignore`, "lock\n");
      });
    yield* must(dir, ["add", "-A"]);
    if (yield* staged(dir)) yield* must(dir, ["commit", "-q", "--no-verify", "-m", message]);
    const remotes = (yield* must(dir, ["remote"])).out.split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    // also when nothing new was committed: a push that failed last time goes out now
    if (remote) yield* must(dir, ["push", "-q", remote, "HEAD"]);
  }).pipe(
    Effect.timeoutOrElse({ duration: GIT_TIMEOUT, orElse: () => Effect.fail(new GitFailed({ message: `git took longer than ${GIT_TIMEOUT}` })) }),
  );

// `persist(dir, message)`: an error message, or null when the data dir is saved (and pushed)
export const makePersist = Effect.gen(function* () {
  const one = yield* Semaphore.make(1); // one git at a time: two would fight over index.lock
  return (dir: string, message: string): Effect.Effect<string | null> =>
    one.withPermit(
      save(dir, message).pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      ),
    );
});
