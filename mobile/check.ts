#!/usr/bin/env bun
// What can be checked of the iOS app without a Mac (CI's `mobile` job, `bun run check` here): its
// types and tests, that eas.json's profiles are ones EAS takes, what EAS Build would upload, that
// Metro bundles the JavaScript
// into Hermes bytecode for iOS, and that `expo prebuild` turns app.json into an Xcode project with
// the bundle id, the permission strings and the icon. It can't compile the native code, sign or
// run the app: only EAS Build on Apple's toolchain does (.github/workflows/testflight.yml).
import { AppVersionSource, EasJsonAccessor, EasJsonUtils, Platform } from "@expo/eas-json";
import GitClient from "eas-cli/build/vcs/clients/git.js";
import { Ignore } from "eas-cli/build/vcs/local.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

run("bunx", "tsc", "-p", "tsconfig.app.json"); // the app, with React Native's types only
run("bunx", "tsc", "-p", "tsconfig.bun.json"); // this file and the tests, with Bun's
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

// What EAS Build uploads, by the root .easignore, made with eas-cli's own code: its ignore rules
// (asked about bare paths, as its copy asks) and then its copy of the repository, as `eas build`
// makes it before uploading (the generated mobile/ios above must stay out). A pattern eas-cli reads
// differently from git uploads an empty project, which nothing else would notice before EAS did.
const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: here }).stdout.toString().trim();
const ignore = await Ignore.createForCopyingAsync(root);
const uploaded: readonly (readonly [string, boolean])[] = [
  ["mobile", true],
  ["mobile/app.json", true],
  ["mobile/src/app.tsx", true],
  ["mobile/ios", false],
  ["mobile/node_modules", false],
  ["mobile/.expo", false],
  ["web", false],
  ["server", false],
  ["package.json", false],
];
for (const [path, up] of uploaded) check(ignore.ignores(path) !== up, `.easignore: ${path} is ${up ? "uploaded" : "left out"}`);
const upload = mkdtempSync(join(tmpdir(), "optchat-eas-upload-"));
try {
  await new GitClient({ maybeCwdOverride: root, requireCommit: false }).makeShallowCopyAsync(`${upload}/repo`);
  for (const [path, up] of [...uploaded, ["mobile/package.json", true], ["mobile/bun.lock", true], ["mobile/assets/icon.png", true]] as const) {
    if (path !== "mobile") check(existsSync(`${upload}/repo/${path}`) === up, `EAS's copy ${up ? "has" : "leaves out"} ${path}`);
  }
} finally {
  rmSync(upload, { force: true, recursive: true });
}

if (failures.length > 0) {
  process.stderr.write(`mobile check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("mobile check: ok\n");
}
