// The data dir is a git repo of its own, committed after every turn (gist §10) and pushed to its
// remote when it has one (E10). A git failure never fails a turn: it is returned, to be reported.
import { Effect, Semaphore } from "effect";
import { existsSync, writeFileSync } from "node:fs";

const git = (dir: string, ...args: string[]) =>
  Effect.promise(async () => {
    // an identity and no signing of our own: it must work on a bare machine and never wait for a passphrase
    const p = Bun.spawn(["git", "-C", dir, "-c", "user.name=optchat", "-c", "user.email=optchat@localhost", "-c", "commit.gpgsign=false", ...args], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    return { code, err: err.trim() || `git ${args[0]} exited with code ${code}`, out };
  });

const run = (dir: string, message: string) =>
  Effect.gen(function* () {
    if (!existsSync(`${dir}/.git`)) {
      // its own repo even inside another one, so `add -A` never reaches the outer
      const r = yield* git(dir, "init", "-q");
      if (r.code) return r.err;
    }
    if (!existsSync(`${dir}/.gitignore`)) writeFileSync(`${dir}/.gitignore`, "lock\n**/lock\n");
    let r = yield* git(dir, "add", "-A");
    if (r.code) return r.err;
    r = yield* git(dir, "diff", "--cached", "--quiet"); // exit 1: something to commit
    if (r.code === 0) return null;
    if (r.code !== 1) return r.err;
    r = yield* git(dir, "commit", "-q", "-m", message);
    if (r.code) return r.err;
    const remotes = yield* git(dir, "remote");
    if (!remotes.out.trim()) return null;
    r = yield* git(dir, "push", "-q");
    return r.code ? r.err : null;
  });

// one git at a time: two commits at once collide on the index lock
export const makePersist = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  return (dir: string, message: string) => lock.withPermits(1)(run(dir, message));
});
