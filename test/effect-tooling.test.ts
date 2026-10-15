import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { diagnosticsCommand, EXECUTABLE, lintEffect, PROJECTS } from "../dev/lint-effect.ts";

const root = path.resolve(import.meta.dir, "..");
const readJson = <A>(file: string, schema: Schema.ConstraintDecoder<A>): A => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(readFileSync(path.join(root, file), "utf8"));
const Version = Schema.Struct({ version: Schema.String });
const Manifest = Schema.Struct({ workspaces: Schema.optional(Schema.Array(Schema.String)), dependencies: Schema.Struct({ effect: Schema.String }) });
const Config = Schema.Struct({
  exclude: Schema.Array(Schema.String),
  compilerOptions: Schema.Struct({ plugins: Schema.Array(Schema.Struct({
    name: Schema.String,
    allowedUnstableApis: Schema.Array(Schema.String),
    diagnosticSeverity: Schema.optional(Schema.Unknown),
    allowedExperimentalApis: Schema.optional(Schema.Unknown),
  })) }),
});
const Editor = Schema.Struct({
  "files.exclude": Schema.Record(Schema.String, Schema.Boolean),
  "files.watcherExclude": Schema.Record(Schema.String, Schema.Boolean),
  "search.exclude": Schema.Record(Schema.String, Schema.Boolean),
  "typescript.preferences.autoImportFileExcludePatterns": Schema.Array(Schema.String),
  "javascript.preferences.autoImportFileExcludePatterns": Schema.Array(Schema.String),
});
const Pin = Schema.Struct({ url: Schema.String, tag: Schema.String, commit: Schema.String, version: Schema.String });
const Report = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ name: Schema.String, code: Schema.Number, message: Schema.String })),
  files: Schema.optional(Schema.Array(Schema.Struct({ file: Schema.String, detectedEffect: Schema.String, supportedEffect: Schema.String }))),
  summary: Schema.Struct({ errors: Schema.Number, warnings: Schema.Number, filesWithoutPlugin: Schema.Number }),
});
const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

function assertV4(report: typeof Report.Type): void {
  expect(report.summary.filesWithoutPlugin).toBe(0);
  expect(report.files?.length).toBeGreaterThan(0);
  for (const file of report.files ?? []) {
    expect(file.detectedEffect).toBe("v4");
    expect(file.supportedEffect).toBe("v4");
    expect(file.file).not.toContain("/repos/");
  }
}

describe("native Effect runner", () => {
  test("executable resolves to a decoded filesystem path in checkouts with special characters", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "effect checkout ü # %-")));
    try {
      mkdirSync(path.join(dir, "dev"));
      const runner = path.join(dir, "dev/lint-effect.ts");
      copyFileSync(path.join(root, "dev/lint-effect.ts"), runner);
      const copied = Schema.decodeUnknownSync(Schema.Struct({ EXECUTABLE: Schema.String }))(await import(pathToFileURL(runner).href));
      expect(copied.EXECUTABLE).toBe(path.join(dir, "node_modules/.bin/effect-tsgo"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("strict error/warning gate and CI arguments apply to both projects", () => {
    const commands: string[][] = [];
    expect(lintEffect(["--", "--format", "github-actions"], (command) => {
      commands.push(command);
      return { exitCode: 0 };
    })).toBe(0);
    expect(commands).toEqual(PROJECTS.map((project) => [EXECUTABLE, "diagnostics", "--project", project, "--strict", "--severity", "error,warning", "--format", "github-actions"]));
    expect(diagnosticsCommand("tsconfig.json", [])).toContain("--strict");
  });

  test("fails closed on nonzero exits, signals, spawn errors and missing binary", () => {
    for (const result of [{ exitCode: 1 }, { exitCode: null }, { exitCode: 0, signalCode: "SIGTERM" }, { exitCode: 0, error: new Error("spawn") }]) {
      let calls = 0;
      expect(lintEffect([], () => {
        calls++;
        return calls === 1 ? result : { exitCode: 0 };
      })).toBe(1);
      expect(calls).toBe(2);
    }
    expect(lintEffect([], () => Bun.spawnSync([path.join(root, "node_modules/.missing-effect-tsgo")]))).toBe(1);
  });

  for (const project of PROJECTS) {
    test(`${project}: real floating and denied unstable API sentinels fail`, () => {
      const dir = mkdtempSync(path.join(root, ".effect-sentinel-"));
      try {
        const config = path.join(dir, "tsconfig.json");
        writeFileSync(config, JSON.stringify({ extends: path.join(root, project), include: ["fixture.ts"], exclude: [] }));
        const cases = [
          { source: 'import { Effect } from "effect"; export const floating = () => { Effect.succeed(42); };', name: "floatingEffect", code: 377_001 },
          { source: 'import { HttpClientRequest } from "effect/http"; export const denied = HttpClientRequest.put("https://example.invalid");', name: "unstableApiUsage", code: 377_136 },
        ];
        for (const sentinel of cases) {
          writeFileSync(path.join(dir, "fixture.ts"), sentinel.source);
          const result = Bun.spawnSync(diagnosticsCommand(config, ["--format", "json", "--list-files"]), { cwd: root });
          expect(result.exitCode).toBe(1);
          const report = decodeReport(result.stdout.toString());
          expect(report.diagnostics).toEqual([expect.objectContaining({ name: sentinel.name, code: sentinel.code })]);
          if (sentinel.name === "unstableApiUsage") expect(report.diagnostics[0]?.message).toContain("effect/http/HttpClientRequest#put");
          assertV4(report);
        }
        writeFileSync(path.join(dir, "fixture.ts"), 'import { BunRuntime } from "@effect/platform-bun"; export const accepted = BunRuntime.runMain;');
        const accepted = Bun.spawnSync(diagnosticsCommand(config, ["--format", "json"]), { cwd: root });
        expect(accepted.exitCode).toBe(0);
        expect(decodeReport(accepted.stdout.toString()).diagnostics).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test(`${project}: positive V4 scan has no errors/warnings or upstream files`, () => {
      const result = Bun.spawnSync(diagnosticsCommand(project, ["--format", "json", "--list-files"]), { cwd: root });
      expect(result.exitCode).toBe(0);
      const report = decodeReport(result.stdout.toString());
      expect(report.diagnostics).toEqual([]);
      expect(report.summary.errors).toBe(0);
      expect(report.summary.warnings).toBe(0);
      assertV4(report);
    }, 60_000);
  }
});

test("pinned schema supports selective export permissions without severity overrides", () => {
  expect(readJson("node_modules/@effect/tsgo/package.json", Version).version).toBe("0.52.0");
  expect(readFileSync(path.join(root, "node_modules/@effect/tsgo/schema.json"), "utf8")).toContain('"allowedUnstableApis"');
  for (const project of PROJECTS) {
    const plugin = readJson(project, Config).compilerOptions.plugins[0];
    expect(plugin?.name).toBe("@effect/language-service");
    expect(plugin?.diagnosticSeverity).toBeUndefined();
    expect(plugin?.allowedExperimentalApis).toBeUndefined();
    expect(plugin?.allowedUnstableApis.every((api) => api.includes("#"))).toBe(true);
    expect(plugin?.allowedUnstableApis).not.toContain("effect/http/HttpClientRequest#put");
  }
});

test("canonical build scripts select JS TS5 and preserve standalone vendor scripts", () => {
  const Scripts = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
  const { scripts } = readJson("package.json", Scripts);
  expect(scripts.build).toBe("bun node_modules/typescript/bin/tsc -p . && bun --filter optchat-web build");
  expect(scripts.postinstall).toBe("bun node_modules/typescript/bin/tsc -p vendor/oxlint-config/tsconfig.build.json");
  const web = readJson("web/package.json", Scripts).scripts;
  expect(web.build).toBe("bun ../node_modules/typescript/bin/tsc -p . && vite build");
  expect(web.typecheck).toBe("bun ../node_modules/typescript/bin/tsc -p .");
  expect(readJson("vendor/oxlint-config/package.json", Scripts).scripts.build).toBe("tsc -p tsconfig.build.json");
  const version = Bun.spawnSync([process.execPath, path.join(root, "node_modules/typescript/bin/tsc"), "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString().trim()).toBe("Version 5.9.3");
});

test("reference is excluded from tests, lint, editor and compiler inputs", () => {
  expect(readFileSync(path.join(root, "bunfig.toml"), "utf8")).toContain('"repos/**"');
  expect(readFileSync(path.join(root, "oxlint.config.ts"), "utf8")).toContain('"repos/**"');
  expect(readJson("tsconfig.json", Config).exclude).toContain("repos/**");
  expect(readJson("web/tsconfig.json", Config).exclude).toContain("../repos/**");
  const editor = readJson(".vscode/settings.json", Editor);
  for (const setting of ["files.exclude", "files.watcherExclude", "search.exclude"] as const) expect(editor[setting]["repos/**"]).toBe(true);
  for (const setting of ["typescript.preferences.autoImportFileExcludePatterns", "javascript.preferences.autoImportFileExcludePatterns"] as const) expect(editor[setting]).toContain("repos/**");
  const manifest = readJson("package.json", Manifest);
  expect(manifest.workspaces).toEqual(["vendor/*", "web"]);
  expect(manifest.dependencies.effect).toBe("4.0.4");
  expect(readJson("web/package.json", Manifest).dependencies.effect).toBe("4.0.4");
  const pin = readJson("repos/effect-reference.json", Pin);
  expect(pin).toEqual({ url: "https://github.com/Effect-TS/effect.git", tag: "effect@4.0.4", commit: "e17ecdbe902aa7108f775c8ab9c0ddf9f38801ab", version: "4.0.4" });
  expect(readJson("repos/effect/packages/effect/package.json", Version).version).toBe(pin.version);
  expect(readFileSync(path.join(root, "repos/effect/LLMS.md"), "utf8")).toContain("Effect library documentation");
});
