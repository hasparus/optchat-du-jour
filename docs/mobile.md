# optchat on an iPhone

The iOS app (`mobile/`) is an Expo app whose one screen is a WebView on your own optchat server. It
bundles none of the web UI: the server serves it, as it does to a browser. TestFlight installs it.
SPEC.md's "iOS app (E27)" describes how it behaves. This page covers how to set it up and why it
is built this way. The comparison was researched in October 2026.

## Setup

You do this once. A Mac is not needed: every step works from Linux.

1. **Apple Developer Program.** The bundle id is `dev.hasparus.optchat`. To use another one, change
   it in `mobile/app.json`.
2. **The App Store Connect record.** Go to [App Store Connect](https://appstoreconnect.apple.com) →
   Apps → + → New App, and pick iOS, any name, that bundle id and any SKU. If the bundle id isn't
   in the list, register it first under Certificates, Identifiers & Profiles → Identifiers. Then
   copy the app's Apple ID (App Information, all digits) into `mobile/eas.json` and commit it:
   ```json
   "submit": { "production": { "ios": { "ascAppId": "1234567890" } } }
   ```
3. **An App Store Connect API key.** Go to Users and Access → Integrations → App Store Connect API
   → Team Keys → +, with App Manager access. Download the `.p8` file; Apple lets you download it
   only once. Keep it on your machine for step 5. It never goes to GitHub.
4. **Expo.** Make an account at [expo.dev](https://expo.dev). Under Account settings → Access tokens,
   make a token and store it as the repository secret `EXPO_TOKEN`. It is the only secret the
   workflow needs.
5. **EAS, by hand, once:**
   ```sh
   cd mobile
   bun install
   bun run eas login
   bun run eas init              # makes the EAS project; commit what it adds to app.json
   bun run eas credentials -p ios
   ```
   In `eas credentials`, choose the production profile, then:
   - "Build Credentials: Set up all the required credentials". EAS signs in to Apple with your
     Apple ID and makes the distribution certificate and the provisioning profile.
   - "App Store Connect: Manage your API Key" → "Set up your project to use an API Key for EAS
     Submit". Give it the `.p8` from step 3, with its key ID and issuer ID.

   Use `bun run eas`, not `bunx eas`: the npm package named `eas` is a different program. This step
   can't be automated, because a non-interactive build can't create the first distribution
   certificate (`SetUpDistributionCertificate.js` in eas-cli 24.7.0). After this, non-interactive
   builds renew the provisioning profile and submit with the key EAS keeps
   (`tryAuthenticateAppStoreWithEasAscApiKeyAsync`, and the submit key's `credentialsService`
   source).
6. **Build.** Go to GitHub → Actions → TestFlight → Run workflow, or push a tag `ios-v…`. The job
   checks the app, uploads `mobile/` to EAS (`.easignore` keeps the rest of the repo out) and
   ends. EAS then builds and submits. The free plan has 15 iOS builds a month, in a slower queue.
   Apple takes a few minutes to process the upload. Then the build is in TestFlight for the team's
   internal testers, with no review.
7. **On the iPhone.** Install TestFlight and Tailscale from the App Store, connect Tailscale, then
   install optchat from TestFlight. Type the server's https address: the one `tailscale serve`
   publishes, which must also be `server.publicUrl`. Your login must be in `allowedLogins`.

A TestFlight build expires after 90 days. Rebuild then, or when `mobile/` changes. A server update
needs no rebuild, because the app shows whatever UI the server serves.

**Checks.** `cd mobile && bun run check` is CI's `mobile` job. It checks what Linux can check:
- both TypeScript programs and the tests;
- `eas.json`;
- the Metro bundle compiled to Hermes;
- the Xcode project that `expo prebuild` writes, with its bundle id, permission strings and icon.

The native compile, the signing and the device itself are checked only by EAS's Macs and by a phone
(TODO.md, "iPhone app"). On a Mac with Xcode, `bunx expo run:ios` runs the app in the simulator;
type `http://127.0.0.1:7700`.

## What the app needs

- **One server.** It runs on the Mac Mini on 127.0.0.1:7700, published to the tailnet as
  `https://<mini>.<tailnet>.ts.net` with a valid certificate. The web UI uses `/ws` (AG-UI),
  `/api/*` and `PUT /api/assets`.
- **Auth** (`server/auth.ts`). There are no tokens.
  - Tailscale serve adds `Tailscale-User-Login`, which must be in `allowedLogins`.
  - `Host` must be loopback or `server.publicUrl`'s host.
  - An `Origin`, when sent, must be the server's own. A WebView on the server's page sends exactly
    that. A WebView on bundled files would send `capacitor://localhost` or similar, which the
    server refuses.
- **Permissions.** The composer has a file input and a camera input (`capture="environment"`), and
  videos have sound. That needs `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` and
  `NSPhotoLibraryUsageDescription`. Keyboard dictation needs nothing.
- **Releases.** The UI and the server change together (`src/wire.ts` is shared). A UI bundled into
  the app would lag the server until the next TestFlight build.

## Options

### A plain PWA ("Add to Home Screen"): the baseline, already there

- **Effort:** none.
- **Limits on iOS:**
  - Web Push only for a web app opened from the Home Screen (iOS 16.4+).
  - iOS 26 opens every site added to the Home Screen as a web app.
  - No background execution. The WebSocket dies once iOS suspends the page, which is true of any
    WebView app as well.
  - `getUserMedia` works, but the microphone is muted in the background.
  - The keyboard covers the page: Safari ignores `interactive-widget=resizes-content`.
- **Not TestFlight.** There is no native place for APNs, a share extension or widgets later.

### Capacitor 8, bundling `web/dist`

- **Status:** 8.5.3 (2026-10-07). Capacitor 9 is due at the end of November 2026. 8.5 was a breaking
  minor (UIScene). A navigation-guard CVE was fixed in 8.5.1, 8.4.3 and 7.6.9. CocoaPods trunk goes
  read-only on 2026-12-02, so the project should use SPM. It requires Xcode 26 and iOS 15+.
- **Native project:** `ios/` is committed and owned by you after `cap add ios`.
- **Builds:**
  - On a GitHub macOS runner (about $0.062/min on private repos since January 2026; the minute
    multiplier is 10× Linux's), with fastlane `match` or cloud signing through an API key, plus
    `upload_to_testflight`.
  - Or through Appflow, which is paid.
  - The signing setup is written and debugged by you, and none of it can be tried from Linux.
- **Bundled:** every `/api`, `/ws` and upload URL needs a configurable base. The server needs CORS
  (with a preflight for `PUT /api/assets`) and an Origin allowance. The UI drifts from the server.
- **Remote:** `server.url` and `allowNavigation` are documented as "not intended for use in
  production". Each user's host differs, so it would need `allowNavigation: ["*.ts.net"]`.
- **Upkeep:** major upgrades, CocoaPods → SPM, and fastlane.

### Expo + react-native-webview, built by EAS (chosen)

- **Versions:** Expo SDK 57 (57.0.24; SDK 58 shipped 2026-09-29), react-native 0.86.3,
  react-native-webview 13.16.1, eas-cli 24.7.0. Each was at least about two weeks old when pinned.
- **Native project:** none is committed. `expo prebuild` writes `ios/` from `app.json`, on Linux as
  well, from a template bundled in `expo`.
- **Build from Linux:** EAS builds, signs and submits on Expo's Macs. The GitHub job runs on ubuntu,
  with no macOS minutes. Expo keeps the certificate, the profile and the API key. One
  `eas credentials` run by hand sets them up.
- **Remote:** a remote page is what the component is for. Every request is same-origin, so the
  server needs no change.
- **Permissions:** Info.plist strings come from `app.json`. `mediaCapturePermissionGrantType`
  (iOS 15+) grants by host. That is safe only because nothing but the server's origin loads in any
  frame.
- **Keyboard:** a `KeyboardAvoidingView` shrinks the WebView. `contentInsetAdjustmentBehavior="never"`
  leaves the safe areas to the page's `env()`.
- **Push later:** `expo-notifications` for the APNs token, sent from the server with a `.p8` key.
- **Upkeep:**
  - An SDK upgrade once or twice a year (`expo install --fix`), and a rebuild every 90 days.
  - About 450 MB of `node_modules` in `mobile/`, which is kept out of the root workspace.
  - Expo holds the signing certificate. To leave Expo, download it with `eas credentials`, or run
    `eas build --local` on a macOS runner.
- **Checkable on Linux:** types, tests, the Hermes bundle, prebuild with its Info.plist and pbxproj,
  and `eas.json`.

### Tauri 2 mobile

The iOS build needs macOS, Xcode and Rust. Linux users are pointed to macOS runners, with signing
done by hand. A production build bundles `frontendDist`; a remote URL is a dev-server feature. It
has fewer and younger mobile plugins. It is the most toolchain for no gain here.

### Others

- **Hotwire Native:** built for multi-page Turbo apps with native navigation. optchat is one page
  with a WebSocket, so it would amount to a Swift project for a WKWebView.
- **A hand-written SwiftUI + WKWebView app with XcodeGen and fastlane:** the smallest app, but
  nothing is checkable on Linux, signing is by hand, and macOS minutes are billed. It is a fair
  later move if Expo's footprint becomes a problem.
- **PWABuilder's iOS package:** one fixed URL, and a Mac to build it.
- **Median/GoNative, MobiLoud:** paid, and out of scope for a personal tool.

## Comparison

| | PWA | Capacitor 8 (bundle) | **Expo + WebView (EAS)** | Tauri 2 | Swift + fastlane |
| --- | --- | --- | --- | --- | --- |
| TestFlight | no | yes | **yes** | yes | yes |
| Build from Linux | n/a | macOS runner + your fastlane/signing | **EAS cloud Mac; CI on ubuntu** | macOS runner + Rust | macOS runner + fastlane |
| macOS CI minutes | 0 | ~15–25/build at ~$0.062 | **0 (15 free iOS builds/mo)** | ~20–30/build | ~10–15/build |
| Signing | n/a | match or cloud signing, by hand | **EAS-managed; one `eas credentials`** | by hand | by hand |
| Secrets on GitHub | none | ASC key, match password | **`EXPO_TOKEN` only** | ASC key | ASC key |
| UI source | server | bundled (drifts) | **server (always matches)** | bundled | server |
| Server changes | none | CORS + Origin + base URLs | **none** | CORS + Origin | none |
| Push later | Web Push (16.4+) | plugin, APNs | **expo-notifications, APNs** | plugin | APNs by hand |
| Keyboard | overlays | Keyboard plugin | **WebView resized** | plugin | by hand |
| Checkable on Linux | yes | config only | **types, Hermes bundle, prebuild, plist** | little | nothing |
| Review risk, internal TestFlight | n/a | none | **none** | none | none |
| Upkeep | none | Cap majors, SPM move, fastlane | **SDK upgrade 1–2×/yr, 90-day rebuilds** | Rust + Xcode | Xcode + fastlane |

Guideline 4.2 (minimum functionality) is the usual rejection for thin web wrappers. It matters only
for an App Store release. Internal TestFlight testers get builds with no Beta App Review.

## Why this one

1. **Remote, not bundled.** The server already serves the UI, and the two change together. Bundling
   would mean a TestFlight build per server change. It would also mean changing CORS and Origin in
   a security-sensitive guard (`server/auth.ts`), and adding base URLs throughout the UI.
   Capacitor's own docs advise against the remote mode, while a WebView component is made for it.
2. **EAS, not a macOS runner with fastlane.** EAS keeps the certificate, profile and API key, and
   builds on Expo's Macs. From a Linux box it is the shortest path that you don't have to debug
   blind, and the workflow bills only ubuntu minutes.

The costs are an Expo account, Expo holding the signing material (it can be exported), a larger JS
dependency tree in `mobile/`, and the free plan's 15 iOS builds a month.

## Sources

Checked in October 2026.

- Capacitor config (`server.url`, `allowNavigation`: "not intended for use in production"): https://capacitorjs.com/docs/config
- Capacitor iOS (Xcode 26+, iOS 15+): https://capacitorjs.com/docs/ios
- Capacitor 8.5 (UIScene, Capacitor 9 timing, CocoaPods trunk read-only): https://ionic.io/blog/capacitor-8-5-released
- Capacitor navigation-guard advisory: https://advisories.gitlab.com/pkg/npm/@capacitor/ios/
- Capawesome on `server.url` in production: https://capawesome.io/docs/blog/
- Expo, building on CI (`EXPO_TOKEN`; credentials must exist first): https://docs.expo.dev/build/building-on-ci
- Expo, submitting to the App Store (`ascAppId`, API keys, `--auto-submit`): https://docs.expo.dev/submit/ios/
- Expo, `npx testflight`: https://docs.expo.dev/build-reference/npx-testflight/
- Expo pricing (Free: 15 iOS builds, low priority, 45-minute timeout; Starter $19/month): https://expo.dev/pricing
- eas-cli v20.2.0 (non-interactive builds use the ASC key stored on EAS): https://releases.sh/release/rel_yBV-RcJiLwlKDuNUXCnXa
- eas-cli 24.7.0 source, read locally:
  - `credentials/ios/actions/SetUpDistributionCertificate.js`
  - `SetUpProvisioningProfile.js` and `AscApiKeyUtils.js` (`tryAuthenticateAppStoreWithEasAscApiKeyAsync`)
  - `SetUpAscApiKey.js`
  - `submit/ios/IosSubmitCommand.js` and `AscApiKeySource.js`
  - `vcs/local.js` and `vcs/clients/git.js` (`.easignore` at the repository root replaces `.gitignore`)
- react-native-webview 13.16.1, read locally: its type definitions and `apple/RNCWebViewImpl.m`
- Expo WebView: https://docs.expo.dev/versions/v57.0.0/sdk/webview.md
- Tauri 2 App Store distribution: https://v2.tauri.app/distribute/app-store/ ; iOS setup notes: https://ibl.ai/developer/os/tauri-ios-setup
- Hotwire Native path configuration: https://native.hotwired.dev/ios/path-configuration
- GitHub Actions billing (macOS 10× multiplier): https://docs.github.com/en/billing/concepts/product-billing/github-actions
- GitHub Actions runner prices: https://docs.github.com/en/enterprise-server@3.17/billing/reference/actions-runner-pricing ; the 2026 price cut: https://cicdpipelinecost.com/github-actions-pricing
- TestFlight (internal testing without review, 90-day builds): https://docs.thunkable.com/publish-to-app-store-ios/testflight-overview ; https://instabug.com/blog/testflight-guide
- Guideline 4.2 and web wrappers: https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper ; https://developer.apple.com/forums/thread/806726
- iOS PWA limits: https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
- iOS 26 "Open as Web App": https://heise.de/-10749652
- A backgrounded WebSocket killed: https://bugs.webkit.org/show_bug.cgi?id=226620 ; https://developer.apple.com/forums/thread/716118
- WKWebView's microphone muted in the background: https://developer.apple.com/forums/thread/689182
