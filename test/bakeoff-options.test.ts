import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { parseSettings } from "../src/config.ts";
import { type BakeoffFiles, parseBakeoffCommand, resolveBakeoffOptions, parseContender, sameSourceAndOutput } from "../dev/bakeoff-options.ts";

const parseBakeoffOptions = (argv: readonly string[], loaded: typeof settings, files: BakeoffFiles) => {
  const command = parseBakeoffCommand(argv);
  if (command.type !== "run") throw new Error("expected run command");
  return resolveBakeoffOptions(command, loaded, files);
};

const settings = parseSettings({
  allowedLogins: [],
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["openai-plan:gpt-6"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: [], url: "http://127.0.0.1:9" } },
  master: { chain: ["openai-plan:gpt-6"], effort: "high", permissionMode: "bypassPermissions" },
  openai: DEFAULT_ENDPOINTS,
});
const files = (existingOutput = false) => ({ sameFile: () => false, sourceExists: (path: string) => path === "source", outputExists: () => existingOutput });
const base = ["--from", "source", "--chain", "one=openai-plan:fake", "--out", "result.json", "--max-requests", "4"];

test("one parser accepts normal Node separate and equals forms", () => {
  const separate = parseBakeoffOptions(base, settings, files());
  const equals = parseBakeoffOptions(["--from=source", "--chain=one=openai-plan:fake", "--out=result.json", "--max-requests=4"], settings, files());
  expect(equals).toEqual(separate);
  expect(separate.maxRequests).toBe(4);
});

test("existing output requires explicit overwrite", () => {
  expect(() => parseBakeoffOptions(base, settings, files(true))).toThrow();
  expect(parseBakeoffOptions([...base, "--overwrite"], settings, files(true)).overwrite).toBe(true);
});

test("invalid setup is redacted and never touches existing output", () => {
  const dir = mkdtempSync(`${tmpdir()}/bake-options-`);
  const path = `${dir}/result.json`;
  const sentinel = '{"sentinel":"PRIVATE-OUTPUT"}\n';
  writeFileSync(path, sentinel);
  const invalid = [
    [],
    [...base, "--bogus"],
    [...base.slice(0, -1), "0"],
    [...base, "--chain", "one=claude-code:sonnet"],
    [...base, "--kinds", "PRIVATE-INVALID-KIND"],
    [...base, "--effort", "PRIVATE-INVALID-EFFORT"],
  ];
  for (const argv of invalid) {
    try {
      parseBakeoffOptions(argv, settings, { ...files(), outputExists: (candidate) => candidate === path });
      throw new Error("accepted invalid setup");
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE-INVALID");
    }
  }
  expect(readFileSync(path, "utf8")).toBe(sentinel);
});

test("level-chain validation is retained", () => {
  const split = parseContender("split=0:openai-plan:gpt-6,claude-code:sonnet;3:openai-plan:gpt-6.1");
  expect(split.byLevel.map((level) => level.from)).toEqual([0, 3]);
  expect(() => parseContender("x=2:claude-code:sonnet")).toThrow();
  expect(() => parseContender("x=0:claude-code:sonnet;0:openai-plan:gpt-6")).toThrow("levels must strictly increase");
  expect(() => parseContender("x=0:claude-code:sonnet;3:openai-plan:gpt-6;2:claude-code:opus")).toThrow("levels must strictly increase");
  expect(() => parseContender("x=0:claude-code:sonnet;9007199254740992:openai-plan:gpt-6")).toThrow("levels must be nonnegative safe integers");
});

test("canonical, symlink, and hardlink source aliases are rejected even with overwrite", () => {
  const dir = mkdtempSync(`${tmpdir()}/bake-alias-`);
  try {
    const source = `${dir}/source`;
    writeFileSync(source, "private");
    symlinkSync(source, `${dir}/symlink`);
    linkSync(source, `${dir}/hardlink`);
    symlinkSync(dir, `${dir}/alias-dir`);
    for (const output of [source, `${dir}/./source`, `${dir}/symlink`, `${dir}/hardlink`, `${dir}/alias-dir/source`]) {
      expect(sameSourceAndOutput(source, output)).toBe(true);
      expect(() => parseBakeoffOptions(["--from", source, "--out", output, "--overwrite", "--chain", "one=claude-code:sonnet", "--max-requests", "1"], settings, { sourceExists: existsSync, outputExists: existsSync })).toThrow();
    }
    expect(readFileSync(source, "utf8")).toBe("private");
    expect(sameSourceAndOutput(source, `${dir}/new.json`)).toBe(false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
