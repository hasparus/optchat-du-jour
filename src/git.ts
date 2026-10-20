// One way to run git (src/persist.ts for the data dir, src/worktree.ts for isolated subagents'
// worktrees): never through a shell, with the repository variables a git hook may export dropped,
// no terminal prompt, a time limit, and our own commits never signing and running no hooks.
// Interrupting a command kills it; a caller that must not stop halfway makes its steps
// uninterruptible.
import { Data, Effect } from "effect";

export class GitFailed extends Data.TaggedError("GitFailed")<{ readonly message: string }> {}

// Run from inside a git hook, git exports where *that* repo lives; a child git would then work
// there instead of in the folder asked for. These are dropped from every git we run.
const REPO_VARS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX"]);

export const gitEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !REPO_VARS.has(k)) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0"; // a push without credentials fails instead of asking
  return env;
};

// How a command's commits are signed off: `own`, a fixed author (the data dir's: it works on a
// machine with no git identity); `user`, the repository's own identity, OptChat's when it has none
// (a user's repository); `none`, no commit is made. Either way nothing signs and no hook runs: a
// passphrase or a hook that waits for input would hang the caller.
export type Identity = "own" | "user" | "none";
const QUIET = ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null"];
const OWN = ["-c", "user.name=optchat", "-c", "user.email=optchat@localhost"];
const OPTCHAT = ["-c", "user.name=OptChat", "-c", "user.email=optchat@localhost"];

export type Ran = { readonly code: number; readonly out: string; readonly err: string };

// how long one command may take
export const GIT_TIMEOUT = "2 minutes";

const spawn = (dir: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: (error) => new GitFailed({ message: `cannot run git: ${error instanceof Error ? error.message : String(error)}` }),
    try: async (signal): Promise<Ran> => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, env: gitEnv(), signal, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, err, out };
    },
  }).pipe(Effect.timeoutOrElse({ duration: GIT_TIMEOUT, orElse: () => Effect.fail(new GitFailed({ message: `git ${args[0] ?? ""} took longer than ${GIT_TIMEOUT}` })) }));

// the user's identity when git has one in `dir`, else OptChat's
const userIdentity = (dir: string) => spawn(dir, ["config", "user.email"]).pipe(Effect.map((r) => (r.code === 0 && r.out.trim() !== "" ? [] : OPTCHAT)));

// one git command in `dir`, whatever its exit code
export const run = (dir: string, args: readonly string[], identity: Identity = "none") =>
  Effect.gen(function* () {
    const who = identity === "own" ? OWN : identity === "user" ? yield* userIdentity(dir) : [];
    return yield* spawn(dir, [...QUIET, ...who, ...args]);
  });

// what a command said, for a message
export const said = (r: Ran) => (r.err || r.out).trim() || `exit code ${r.code}`;

// a command that must succeed: what it said becomes the message when it doesn't
export const must = (dir: string, args: readonly string[], identity: Identity = "none") =>
  run(dir, args, identity).pipe(Effect.flatMap((r) => (r.code === 0 ? Effect.succeed(r) : Effect.fail(new GitFailed({ message: `git ${args[0] ?? ""}: ${said(r)}` })))));
