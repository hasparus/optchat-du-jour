// The data dir as its own git repo (gist §10, ref §10, E10): committed after a turn, pushed when a
// remote is configured, and a failed push is a message, never a failure.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
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

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};

test("the data dir is committed as its own repo, without its lock, and pushed to a remote when there is one", async () => {
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

  const persist = await Effect.runPromise(makePersist);
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
    expect(git(remote, "log", "--all", "--format=%s").out).toBe("chore(chat): 2 messages\nchore(chat): 1 messages");

    git(data, "remote", "set-url", "origin", `${outer}/nowhere.git`);
    appendFileSync(`${data}/chat/main/2026-10-05.jsonl`, '{"i":2}\n');
    const failed = await save("chore(chat): 3 messages");
    expect(failed).toStartWith("git push: "); // reported, and the commit is kept
    expect(git(data, "log", "-1", "--format=%s").out).toBe("chore(chat): 3 messages");
  } finally {
    lock.close();
  }
});
