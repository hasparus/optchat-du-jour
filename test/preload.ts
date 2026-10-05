// Loaded before every `bun test` file (bunfig.toml): no test can reach a real model or a real key
// by accident. `claude` is a stub that refuses to run until a test names a fake, and the secrets
// store is an empty file of its own, so the ChatGPT plan and the API keys are signed out unless a
// test signs in to a fake. Set here, before any module reads them, and over whatever the shell had.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const secrets = mkdtempSync(`${tmpdir()}/oc-secrets-`);
process.on("exit", () => {
  rmSync(secrets, { force: true, recursive: true });
});
Bun.env.OPTCHAT_CLAUDE = new URL("no-claude", import.meta.url).pathname;
Bun.env.OPTCHAT_SECRETS = `${secrets}/secrets.json`;
