#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

export const PROJECTS = ["tsconfig.json", "web/tsconfig.json"];
export const EXECUTABLE = fileURLToPath(new URL("../node_modules/.bin/effect-tsgo", import.meta.url));

type Spawn = (command: string[]) => { exitCode: number | null; signalCode?: string | null; error?: unknown };
const spawn: Spawn = (command) => Bun.spawnSync(command, { stderr: "inherit", stdout: "inherit" });

export function diagnosticsCommand(project: string, args: string[]): string[] {
  return [EXECUTABLE, "diagnostics", "--project", project, "--strict", "--severity", "error,warning", ...args.filter((arg) => arg !== "--")];
}

export function lintEffect(args: string[], run: Spawn = spawn): number {
  let failed = false;
  for (const project of PROJECTS) {
    try {
      const result = run(diagnosticsCommand(project, args));
      if (result.exitCode !== 0 || result.signalCode || result.error) failed = true;
    } catch (error) {
      process.stderr.write(`Effect diagnostics could not run for ${project}: ${String(error)}\n`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = lintEffect(process.argv.slice(2));
