// The iOS app: a WebView on the user's own optchat server (docs/mobile.md). The first launch asks
// for the server's address; it is kept on the phone and can be changed from the web UI's header
// (the server icon) or from the screen shown when the server can't be reached. The address screen
// opens over the page, so cancelling it leaves the page as it was.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import app from "../app.json";
import { asksForServerScreen, shellScript } from "./bridge";
import { loadsInApp, parseServerUrl, probe } from "./server-url";

const KEY = "optchat.server"; // the server's origin, e.g. https://mini.tailnet.ts.net
const VERSION = app.expo.version;

// the web UI's own colors (web/index.html's theme-color and its light background), so nothing flashes
const palette = (dark: boolean) =>
  dark ? { bg: "#0a0a0a", fg: "#fafafa", muted: "#a3a3a3", border: "#262626", error: "#f87171" } : { bg: "#ffffff", fg: "#0a0a0a", muted: "#737373", border: "#e5e5e5", error: "#dc2626" };
type Palette = ReturnType<typeof palette>;

// A link the server's page opens that isn't the server's: the in-app Safari sheet for http(s),
// which is all it takes, and the system for any other scheme (mailto:, tel:).
function openOutside(url: string) {
  const open = /^https?:/iu.test(url) ? WebBrowser.openBrowserAsync(url) : Linking.openURL(url);
  open.catch(() => {
    Alert.alert("Can't open this link", url);
  });
}

async function savedOrigin(): Promise<string | null> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    const parsed = saved === null ? null : parseServerUrl(saved);
    return parsed?.ok === true ? parsed.origin : null;
  } catch {
    return null; // unreadable: ask again
  }
}

export function App() {
  const dark = useColorScheme() !== "light";
  const colors = palette(dark);
  const [loaded, setLoaded] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null); // the server the page shows
  const [asking, setAsking] = useState(false); // the address screen, over the page

  useEffect(() => {
    let live = true;
    void savedOrigin().then((saved) => {
      if (!live) return;
      setOrigin(saved);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const use = (next: string) => {
    AsyncStorage.setItem(KEY, next).catch(() => {
      Alert.alert("Couldn't save the address", "This phone will ask for it again at the next launch.");
    });
    setOrigin(next);
    setAsking(false);
  };
  const ask = () => {
    setAsking(true);
  };

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg }]}>
      <StatusBar style={dark ? "light" : "dark"} />
      {!loaded && <ActivityIndicator color={colors.muted} style={styles.fill} />}
      {origin !== null && <Web colors={colors} key={origin} onChangeServer={ask} origin={origin} />}
      {loaded && (origin === null || asking) && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
          <Setup
            colors={colors}
            current={origin}
            onCancel={
              origin === null
                ? null
                : () => {
                    setAsking(false);
                  }
            }
            onUse={use}
          />
        </View>
      )}
    </View>
  );
}

type SetupProps = {
  readonly colors: Palette;
  readonly current: string | null;
  readonly onCancel: (() => void) | null;
  readonly onUse: (origin: string) => void;
};

function Setup({ colors, current, onCancel, onUse }: SetupProps) {
  const [text, setText] = useState(current ?? "");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<string | null>(null); // an address that failed its check, usable anyway

  const connect = async () => {
    const parsed = parseServerUrl(text);
    setUnchecked(null);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setChecking(true);
    const answer = await probe(parsed.origin);
    setChecking(false);
    if (answer.ok) {
      onUse(parsed.origin);
      return;
    }
    setError(answer.error);
    setUnchecked(parsed.origin);
  };

  return (
    <ScrollView contentContainerStyle={styles.setup} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, { color: colors.fg }]}>optchat</Text>
      <Text style={[styles.body, { color: colors.muted }]}>
        Your optchat server's address, as tailscale serve publishes it: the same as server.publicUrl in its optchat.config.ts. Tailscale must be connected
        on this phone.
      </Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={current === null}
        editable={!checking}
        keyboardType="url"
        onChangeText={setText}
        onSubmitEditing={() => void connect()}
        placeholder="https://mini.tailnet.ts.net"
        placeholderTextColor={colors.muted}
        returnKeyType="go"
        style={[styles.input, { borderColor: colors.border, color: colors.fg }]}
        textContentType="URL"
        value={text}
      />
      {error !== null && <Text style={[styles.body, { color: colors.error }]}>{error}</Text>}
      <View style={styles.row}>
        {checking ? <ActivityIndicator color={colors.muted} /> : <Button colors={colors} label="Connect" onPress={() => void connect()} primary />}
        {unchecked !== null && !checking && (
          <Button
            colors={colors}
            label="Use it anyway"
            onPress={() => {
              onUse(unchecked);
            }}
          />
        )}
        {onCancel !== null && !checking && <Button colors={colors} label="Cancel" onPress={onCancel} />}
      </View>
      <Text style={[styles.small, { color: colors.muted }]}>optchat {VERSION}</Text>
    </ScrollView>
  );
}

function Web({ colors, onChangeServer, origin }: { readonly colors: Palette; readonly onChangeServer: () => void; readonly origin: string }) {
  const ref = useRef<WebView>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // back in front on the failure screen: try again at once (Tailscale may be back). The page's own
  // /ws link reconnects by itself (web/src/lib/connection.ts, wakeOnReturn)
  useEffect(() => {
    if (failure === null) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      setFailure(null);
      ref.current?.reload();
    });
    return () => {
      subscription.remove();
    };
  }, [failure]);

  const retry = () => {
    setFailure(null);
    ref.current?.reload();
  };

  return (
    // the keyboard shrinks the WebView instead of covering it, so the composer sits on top of it
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <WebView
        allowsBackForwardNavigationGestures={false}
        allowsInlineMediaPlayback
        allowsLinkPreview={false}
        applicationNameForUserAgent={`optchat-ios/${VERSION}`}
        automaticallyAdjustContentInsets={false}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        hideKeyboardAccessoryView // no prev/next/Done bar: the composer is the only field
        injectedJavaScriptBeforeContentLoaded={shellScript}
        keyboardDisplayRequiresUserAction={false}
        // only the server's pages ever load (loadsInApp), so this grants the server alone
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        mediaPlaybackRequiresUserAction
        onContentProcessDidTerminate={() => {
          ref.current?.reload(); // iOS dropped the page while the app was away
        }}
        onError={(event) => {
          setFailure(event.nativeEvent.description);
        }}
        onHttpError={(event) => {
          setFailure(`The server answered ${event.nativeEvent.statusCode}.`);
        }}
        onMessage={(event) => {
          if (asksForServerScreen(origin, event.nativeEvent)) onChangeServer();
        }}
        onOpenWindow={(event) => {
          openOutside(event.nativeEvent.targetUrl);
        }}
        onShouldStartLoadWithRequest={(request) => {
          if (loadsInApp(origin, request.url)) return true;
          if (request.isTopFrame) openOutside(request.url); // a frame elsewhere just doesn't load
          return false;
        }}
        ref={ref}
        source={{ uri: `${origin}/` }}
        style={{ backgroundColor: colors.bg }}
        webviewDebuggingEnabled={__DEV__} // Safari's Web Inspector, in a development build only
      />
      {failure !== null && (
        <View style={[StyleSheet.absoluteFill, styles.failure, { backgroundColor: colors.bg }]}>
          <Text style={[styles.title, { color: colors.fg }]}>Can't open optchat</Text>
          <Text style={[styles.body, { color: colors.muted }]}>{origin}</Text>
          <Text style={[styles.body, { color: colors.error }]}>{failure}</Text>
          <Text style={[styles.body, { color: colors.muted }]}>Is Tailscale connected on this phone, and the server running?</Text>
          <View style={styles.row}>
            <Button colors={colors} label="Try again" onPress={retry} primary />
            <Button colors={colors} label="Change server" onPress={onChangeServer} />
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function Button({ colors, label, onPress, primary = false }: { readonly colors: Palette; readonly label: string; readonly onPress: () => void; readonly primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
        primary && { backgroundColor: colors.fg, borderColor: colors.fg },
      ]}
    >
      <Text style={{ color: primary ? colors.bg : colors.fg, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 21 },
  button: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10 },
  failure: { gap: 12, justifyContent: "center", padding: 24 },
  fill: { flex: 1 },
  input: { borderRadius: 10, borderWidth: 1, fontSize: 17, paddingHorizontal: 12, paddingVertical: 10 },
  row: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 12 },
  setup: { gap: 16, padding: 24, paddingTop: 48 },
  small: { fontSize: 12 },
  title: { fontSize: 28, fontWeight: "700" },
});
