#!/usr/bin/env bun
// The server process. Run it on the machine that owns the memory (SPEC "System shape"), published to the
// tailnet with `tailscale serve --bg --https=443 http://127.0.0.1:7700`.
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { loadSettings } from "../src/config.ts";
import { HOME } from "../src/paths.ts";
import { serverLayer } from "./app.ts";

const root = `${import.meta.dir}/../`;

export const main = Effect.gen(function* () {
  const settings = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const device = Bun.env.OPTCHAT_DEVICE ?? settings.defaultDevice;
  yield* Effect.logInfo(`optchat-server: ${HOME}/streams/${device}, http://${settings.server?.host ?? "127.0.0.1"}:${settings.server?.port ?? 7700}`);
  return yield* Layer.launch(
    serverLayer({
      device,
      home: HOME,
      host: settings.server?.host ?? "127.0.0.1",
      port: settings.server?.port ?? 7700,
      settings,
      web: `${root}web/dist`,
    }),
  );
});

if (import.meta.main) BunRuntime.runMain(main);
