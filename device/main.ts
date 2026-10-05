#!/usr/bin/env bun
// optchat-device (SPEC "Multi-machine"): one per machine that has files to work on, kept alive by
// launchd (deploy/optchat-device.plist). Which device this is comes from OPTCHAT_DEVICE; its folders
// and port from that device's entry in optchat.config.ts. It listens on the machine's tailnet address
// (`tailscale ip -4`, or OPTCHAT_DEVICE_HOST) and lets in the configured devices' nodes, asking
// Tailscale's WhoIs. OPTCHAT_DEVICE_TRUST=loopback also lets in local callers (development only);
// OPTCHAT_TAILSCALE names the tailscale binary, OPTCHAT_CLAUDE the claude binary.
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { claudeBinary } from "../src/claude/process.ts";
import { ConfigError, loadSettings } from "../src/config.ts";
import { nodesOf, tailnetAddress, tailscaleWhois } from "./auth.ts";
import { deviceLayer } from "./runner.ts";

const root = new URL("..", import.meta.url).pathname;
const DEFAULT_PORT = 7710;

const main = Effect.gen(function* () {
  const settings = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const name = Bun.env.OPTCHAT_DEVICE ?? "";
  const device = settings.devices[name];
  if (!device) return yield* new ConfigError({ message: `OPTCHAT_DEVICE must name one of: ${Object.keys(settings.devices).join(", ")}` });
  const tailscale = Bun.env.OPTCHAT_TAILSCALE ?? "tailscale";
  const found = Bun.env.OPTCHAT_DEVICE_HOST === undefined ? yield* tailnetAddress(tailscale) : Option.some(Bun.env.OPTCHAT_DEVICE_HOST);
  if (Option.isNone(found)) return yield* new ConfigError({ message: "no tailnet address: is Tailscale up? (OPTCHAT_DEVICE_HOST sets one)" });
  const host = found.value;
  const port = Number(new URL(device.url).port || DEFAULT_PORT);
  const trust = {
    loopback: Bun.env.OPTCHAT_DEVICE_TRUST === "loopback",
    nodes: nodesOf(Object.values(settings.devices).map((d) => d.url)),
    whois: yield* tailscaleWhois(tailscale),
  };
  yield* Effect.logInfo(`optchat-device ${name}: http://${host}:${port}, folders ${device.folders.join(", ")}, callers ${trust.nodes.join(", ")}`);
  return yield* Layer.launch(deviceLayer({ claude: claudeBinary(), folders: device.folders, host, name, port, trust }));
}).pipe(Effect.provide(BunServices.layer));

BunRuntime.runMain(main);
