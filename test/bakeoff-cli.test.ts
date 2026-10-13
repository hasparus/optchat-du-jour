import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { decodeArtifact } from "../dev/bakeoff-artifact.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";

const dir = mkdtempSync(`${tmpdir()}/bake-cli-`);
afterAll(() => { rmSync(dir, { force: true, recursive: true }); });
const cli = new URL("../dev/bakeoff.ts", import.meta.url).pathname;
const config = `${dir}/config.ts`;
writeFileSync(config, `export default ${JSON.stringify({
  allowedLogins: [], cache: { claudeCodeTtl: "1h", primeTtl: "1h" }, compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
  defaultDevice: "offline", devices: { offline: { folders: [], url: "http://127.0.0.1:9" } },
  master: { chain: ["claude-code:sonnet"], effort: "medium", permissionMode: "bypassPermissions" }, openai: DEFAULT_ENDPOINTS,
})};\n`);
const invoke = async (argv: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(["mise", "exec", "bun@1.4.2", "--", "bun", cli, ...argv], {
    env: { ...process.env, TMPDIR: dir, OPTCHAT_CONFIG: config, OPTCHAT_HOME: `${dir}/home-does-not-exist`, OPTCHAT_SECRETS: `${dir}/secret-does-not-exist`, OPTCHAT_CLAUDE: new URL("no-claude", import.meta.url).pathname, ...env },
    stderr: "pipe", stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stderr, stdout };
};

test("subprocess help exits zero without settings, secrets or filesystem initialization", async () => {
  const bad = `${dir}/help-settings.ts`;
  const marker = `${dir}/help-imported`;
  writeFileSync(bad, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'wrong'); throw Error('PRIVATE-SETTINGS');`);
  const before = readdirSync(dir).sort();
  const result = await invoke(["--help"], { OPTCHAT_CONFIG: bad });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("authorized-request cap");
  expect(result.stderr).toBe("");
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(existsSync(marker)).toBe(false);
});

test("subprocess invalid settings/options use fixed redacted errors and leave output untouched", async () => {
  const out = `${dir}/untouched.json`;
  writeFileSync(out, "PRIVATE-EXISTING-OUTPUT");
  for (const [argv, env] of [
    [["--bogus=PRIVATE-ARGV"], {}],
    [["--out", out, "--overwrite"], { OPTCHAT_CONFIG: `${dir}/PRIVATE-PATH` }],
  ] as const) {
    const result = await invoke([...argv], env);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("bake-off setup failed (details redacted); use --help\n");
    expect(readFileSync(out, "utf8")).toBe("PRIVATE-EXISTING-OUTPUT");
  }
});

test("offline executable --no-fail-fast exits nonzero even when a later contender succeeds", async () => {
  const source = `${dir}/LOG.txt`;
  writeFileSync(source, `#0 2026-01-01 ${"PRIVATE-CORPUS ".repeat(60)}\n`);
  const script = `${dir}/claude-script.json`;
  writeFileSync(script, JSON.stringify({ compact: [[{ result: { is_error: true, text: "usage limit PRIVATE-PROVIDER" } }], [{ text: "note: short" }]] }));
  for (const noFailFast of [true, false]) {
    const out = `${dir}/${noFailFast ? "continued" : "stopped"}.json`;
    const result = await invoke(["--from", source, "--chain", "first=claude-code:sonnet", "--chain", "second=claude-code:sonnet", "--out", out, "--n", "1", "--max-requests", "2", ...(noFailFast ? ["--no-fail-fast"] : [])], {
      FAKE_CLAUDE_LOG: `${dir}/${noFailFast}.log`, FAKE_CLAUDE_SCRIPT: script, OPTCHAT_CLAUDE: new URL("fake-claude.ts", import.meta.url).pathname,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("PRIVATE");
    expect(result.stderr).not.toContain(" at ");
    const raw = readFileSync(out, "utf8");
    expect(raw).not.toContain("PRIVATE");
    const value = decodeArtifact(JSON.parse(raw));
    expect(value.outcome.type).toBe(noFailFast ? "completed-with-failures" : "aborted");
    expect(value.outcome.contenders.map((c) => c.type)).toEqual(noFailFast ? ["failed", "complete"] : ["failed"]);
  }
  expect(existsSync(`${dir}/home-does-not-exist`)).toBe(false);
  expect(readdirSync(dir).filter((name) => name.startsWith("bake-"))).toEqual([]);
});
