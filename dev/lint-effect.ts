#!/usr/bin/env bun
// Effect-aware diagnostics (@effect/language-service) over both TypeScript projects, the server's
// and the web app's: the CLI takes one project per run. Extra arguments go to every run, e.g.
// `bun run lint:effect -- --format github-actions` in CI. Fails if any project has an error or warning.
const PROJECTS = ["tsconfig.json", "web/tsconfig.json"];

let failed = false;
for (const project of PROJECTS) {
  const run = Bun.spawnSync(["effect-language-service", "diagnostics", "--project", project, "--strict", "--severity", "error,warning", ...process.argv.slice(2)], {
    stderr: "inherit",
    stdout: "inherit",
  });
  if (run.exitCode !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
