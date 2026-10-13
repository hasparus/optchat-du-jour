import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { parseSettings } from "../src/config.ts";
import { parseBakeoffOptions, parseContender } from "../dev/bakeoff-options.ts";

const settings = parseSettings({
  allowedLogins: [],
  cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["openai-plan:gpt-6"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: [], url: "http://127.0.0.1:9" } },
  master: { chain: ["openai-plan:gpt-6"], effort: "high", permissionMode: "bypassPermissions" },
  openai: DEFAULT_ENDPOINTS,
});
const files = (existingOutput = false) => ({ sourceExists: (path: string) => path === "source", outputExists: () => existingOutput });
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
      parseBakeoffOptions(argv, settings, { sourceExists: files().sourceExists, outputExists: (candidate) => candidate === path });
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
