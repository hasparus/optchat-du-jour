#!/usr/bin/env bun
// optchat-device (SPEC "Multi-machine"): one per machine whose files the server's turns work on,
// except the server's own (its turns use the local runner), kept alive by launchd
// (deploy/optchat-device.plist). Which device this is comes from OPTCHAT_DEVICE; its folders and
// port from that device's entry in optchat.config.ts. It listens on the machine's tailnet IPv4
// address (`tailscale ip -4`, or OPTCHAT_DEVICE_HOST) and lets in the server's device's node only
// (OPTCHAT_SERVER_DEVICE, else defaultDevice), asking Tailscale's WhoIs. OPTCHAT_DEVICE_TRUST=loopback lets in local callers only, on
// 127.0.0.1 unless OPTCHAT_DEVICE_HOST says otherwise (development and tests).
// OPTCHAT_TAILSCALE names the tailscale binary, OPTCHAT_CLAUDE the claude binary.
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { claudeBinary } from "../src/claude/process.ts";
import { ConfigError, loadSettings } from "../src/config.ts";
import { type Trust, cachedWhois, callerNames, tailnetAddress, tailnetSuffix, tailscaleWhois } from "./auth.ts";
import { deviceLayer } from "./runner.ts";

const root = new URL("..", import.meta.url).pathname;
const DEFAULT_PORT = 7710;

const main = Effect.gen(function* () {
  const settings = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const name = Bun.env.OPTCHAT_DEVICE ?? "";
  const device = settings.devices[name];
  if (!device) return yield* new ConfigError({ message: `OPTCHAT_DEVICE must name one of: ${Object.keys(settings.devices).join(", ")}` });
  const tailscale = Bun.env.OPTCHAT_TAILSCALE ?? "tailscale";
  const port = Number(new URL(device.url).port || DEFAULT_PORT);
  const loopback = Bun.env.OPTCHAT_DEVICE_TRUST === "loopback";

  // who may call: only the device the server runs on (OPTCHAT_SERVER_DEVICE, else defaultDevice);
  // the server is the runner's one legitimate caller, and its own machine needs no runner
  const server = Bun.env.OPTCHAT_SERVER_DEVICE ?? settings.defaultDevice;
  const others = Object.entries(settings.devices).filter(([other]) => other === server && other !== name);
  let trust: Trust = { _tag: "loopback" };
  if (!loopback) {
    const suffix = yield* tailnetSuffix(tailscale);
    if (Option.isNone(suffix)) return yield* new ConfigError({ message: "cannot read this tailnet's MagicDNS suffix: is Tailscale up?" });
    const names = yield* callerNames(others.map(([, d]) => d.url), suffix.value);
    trust = { _tag: "tailnet", names, whois: yield* cachedWhois(yield* tailscaleWhois(tailscale), { concurrency: 4, ttl: "10 seconds" }) };
  }

  const fixed = Bun.env.OPTCHAT_DEVICE_HOST;
  const found = fixed === undefined ? (loopback ? Option.some("127.0.0.1") : yield* tailnetAddress(tailscale)) : Option.some(fixed);
  if (Option.isNone(found)) return yield* new ConfigError({ message: "no tailnet address: is Tailscale up? (OPTCHAT_DEVICE_HOST sets one)" });
  const host = found.value;
  const callers = trust._tag === "tailnet" ? trust.names.join(", ") || "nobody" : "this machine only";
  yield* Effect.logInfo(`optchat-device ${name}: http://${host}:${port}, folders ${device.folders.join(", ")}, callers ${callers}`);
  return yield* Layer.launch(deviceLayer({ claude: claudeBinary(), folders: device.folders, host, name, port, trust }));
}).pipe(Effect.provide(BunServices.layer));

BunRuntime.runMain(main);
