#!/usr/bin/env bun
// What can be checked of the iOS app without a Mac (CI's `mobile` job, `bun run check` here): its
// types and tests, that eas.json's profiles are ones EAS takes, that Metro bundles the JavaScript
// into Hermes bytecode for iOS, and that `expo prebuild` turns app.json into an Xcode project with
// the bundle id, the permission strings and the icon. It can't compile the native code, sign or
// run the app: only EAS Build on Apple's toolchain does (.github/workflows/testflight.yml).
import { AppVersionSource, EasJsonAccessor, EasJsonUtils, Platform } from "@expo/eas-json";
import { existsSync, readFileSync } from "node:fs";
import app from "./app.json";

const here = import.meta.dir;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
const run = (...cmd: string[]) => {
  const done = Bun.spawnSync(cmd, { cwd: here, stderr: "inherit", stdout: "inherit" });
  check(done.exitCode === 0, cmd.join(" "));
};

run("bunx", "tsc", "-p", ".");
run("bun", "test");

// the profiles the TestFlight workflow builds and submits with
const eas = EasJsonAccessor.fromProjectPath(here);
const build = await EasJsonUtils.getBuildProfileAsync(eas, Platform.IOS, "production");
check(build.autoIncrement === true, "eas.json: production build increments the build number");
const cli = await EasJsonUtils.getCliConfigAsync(eas);
check(cli?.appVersionSource === AppVersionSource.REMOTE, "eas.json: the build number lives on EAS (appVersionSource remote)");
await EasJsonUtils.getSubmitProfileAsync(eas, Platform.IOS, "production");

// the JavaScript as the app ships it: Metro's bundle, compiled to Hermes bytecode
const exported = `${here}/.expo/check-export`;
run("bunx", "expo", "export", "--platform", "ios", "--output-dir", exported, "--clear");
check([...new Bun.Glob("_expo/static/js/ios/*.hbc").scanSync(exported)].length === 1, "the iOS bundle, as Hermes bytecode");

// the native project, as EAS writes it on its Mac before building
run("bunx", "expo", "prebuild", "--platform", "ios", "--no-install", "--clean");
const plistPath = `${here}/ios/${app.expo.name}/Info.plist`;
const plist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : "";
const value = (key: string) => new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`, "u").exec(plist);
for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryUsageDescription"]) {
  check((value(key)?.[2] ?? "").trim().length > 0, `Info.plist: ${key} says why`);
}
check(value("ITSAppUsesNonExemptEncryption")?.[1] === "false", "Info.plist: no export-compliance question per build");
check(value("NSAllowsArbitraryLoads")?.[1] === "false", "Info.plist: App Transport Security stays on");
const pbxPath = `${here}/ios/${app.expo.name}.xcodeproj/project.pbxproj`;
const pbx = existsSync(pbxPath) ? readFileSync(pbxPath, "utf8") : "";
check(pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = "${app.expo.ios.bundleIdentifier}";`), "project.pbxproj: the bundle id");
check(existsSync(`${here}/ios/${app.expo.name}/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png`), "the app icon");

if (failures.length > 0) {
  process.stderr.write(`mobile check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("mobile check: ok\n");
}
