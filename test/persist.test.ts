// The data dir as its own git repo (gist §10, ref §10, E10): committed after a turn, pushed in the
// background when a remote is configured, and a failed push is a message, never a failure.
import { afterAll, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { makePersist } from "../src/persist.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-`);
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

// the push runs in the background: poll for what it leaves
const eventually = async (what: string, ok: () => boolean) => {
  const end = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};

test("the data dir is committed as its own repo, without its lock, and pushed in the background when there is a remote", async () => {
  const outer = tmp();
  git(outer, "init", "-q"); // another repo around it: the data dir still gets its own
  const data = `${outer}/data`;
  mkdirSync(`${data}/chat/main`, { recursive: true });
  writeFileSync(`${data}/chat/main/2026-10-05.jsonl`, '{"i":0}\n');
  const lock = createServer().listen(`${data}/lock`);
  await new Promise<void>((resolve) => {
    lock.once("listening", () => {
      resolve();
    });
  });

  const reports: string[] = [];
  const scope = await Effect.runPromise(Scope.make());
  const persist = await Effect.runPromise(Scope.provide(makePersist((m) => Effect.sync(() => reports.push(m))), scope));
  const save = async (message: string) => Effect.runPromise(persist(data, message));
  try {
    expect(await save("chore(chat): 1 messages")).toBeNull();
    expect(existsSync(`${data}/.git`)).toBe(true);
    expect(git(data, "log", "--format=%s|%an <%ae>").out).toBe("chore(chat): 1 messages|optchat <optchat@localhost>");
    expect(git(data, "ls-files").out.split("\n")).toEqual([".gitignore", "chat/main/2026-10-05.jsonl"]);
    expect(git(outer, "rev-parse", "--verify", "HEAD").code).not.toBe(0); // nothing reached the outer repo

    expect(await save("chore(chat): nothing new")).toBeNull();
    expect(git(data, "rev-list", "--count", "HEAD").out).toBe("1"); // nothing staged, no commit

    const remote = `${tmp()}/backup.git`;
    git(outer, "init", "-q", "--bare", remote);
    git(data, "remote", "add", "origin", remote);
    appendFileSync(`${data}/chat/main/2026-10-05.jsonl`, '{"i":1}\n');
    expect(await save("chore(chat): 2 messages")).toBeNull();
    const pushed = () => git(remote, "log", "--all", "--format=%s").out;
    await eventually("the push", () => pushed() === "chore(chat): 2 messages\nchore(chat): 1 messages");

    // a remote that fails: reported once, however many pushes fail; the commits are kept
    git(data, "remote", "set-url", "origin", `${outer}/nowhere.git`);
    for (const n of [3, 4]) {
      appendFileSync(`${data}/chat/main/2026-10-05.jsonl`, `{"i":${n - 1}}\n`);
      expect(await save(`chore(chat): ${n} messages`)).toBeNull();
      await eventually("the failed push", () => reports.length === 1);
    }
    expect(reports[0]).toStartWith("git: git push: ");
    expect(git(data, "log", "-1", "--format=%s").out).toBe("chore(chat): 4 messages");

    // a remote that never answers holds up no commit
    const knocked = `${tmp()}/knocked`;
    git(data, "config", "core.sshCommand", `sh -c 'touch ${knocked}; sleep 5' --`);
    git(data, "remote", "set-url", "origin", "ssh://unreachable.example/backup.git");
    appendFileSync(`${data}/chat/main/2026-10-05.jsonl`, '{"i":4}\n');
    const asked = Date.now();
    expect(await save("chore(chat): 5 messages")).toBeNull();
    appendFileSync(`${data}/chat/main/2026-10-05.jsonl`, '{"i":5}\n');
    expect(await save("chore(chat): 6 messages")).toBeNull();
    expect(Date.now() - asked).toBeLessThan(3000);
    await eventually("the push to start", () => existsSync(knocked)); // and it is still going
    expect(git(data, "log", "-1", "--format=%s").out).toBe("chore(chat): 6 messages");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void)); // the hanging push is killed
    lock.close();
  }
});
