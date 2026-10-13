// The app (SPEC "Web UI"): one page with four tabs and no router. The chat stays mounted while
// another tab is open, so its log and the live turn are there when you come back. One /ws link
// for the whole page.
import { Button } from "@/components/ui/button";
import { segmentedItem, segmentedList } from "@/components/ui/segmented";
import { MessageScrollerProvider } from "@/components/ui/message-scroller";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { Uploader } from "@/lib/attach";
import type { Link } from "@/lib/connection";
import type { SessionStore } from "@/lib/session";
import { syncThemeColor } from "@/lib/theme";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { nativeShell } from "@/lib/shell";
import { MoonIcon, ServerIcon, SunIcon } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useCallback, useState, useSyncExternalStore } from "react";
import { Chat } from "./chat/chat";
import { Devices } from "./devices/devices";
import { Memory } from "./memory/memory";

// recharts is most of a chart's weight; the chat shouldn't wait for it. Its chunk can fail to load
// (offline before the first visit; a page left open across a new build, whose old chunk is gone):
// the boundary below says so and offers a reload, and the rest of the app stays up. No retry: a
// browser keeps a failed import of the same URL failed until the page loads again.
const Stats = lazy(async () => {
  const module = await import("./stats/stats");
  return { default: module.Stats };
});

// a screen that fails to load or draw says so and offers a reload; the other screens are not taken with it
class ScreenBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="space-y-3 p-6 text-ui" role="alert">
        <p>Couldn't load this screen.</p>
        <Button
          onClick={() => {
            location.reload();
          }}
          size="sm"
          variant="outline"
        >
          Reload
        </Button>
      </div>
    );
  }
}

type Tab = "chat" | "memory" | "stats" | "devices";
const TABS: readonly Tab[] = ["chat", "memory", "stats", "devices"];
const isTab = (s: string): s is Tab => TABS.some((t) => t === s);

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // no storage (a private window): the choice lasts this page
    }
    setDark(next);
    syncThemeColor();
  };
  return (
    <Button aria-label={dark ? "Light theme" : "Dark theme"} className="text-muted-foreground hover:text-foreground" onClick={toggle} size="icon-sm" variant="ghost">
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

// in the iOS app: its server-address screen, over this page, the only way back to it once a server is set
function ChangeServer() {
  const shell = nativeShell();
  if (shell === undefined) return null;
  return (
    <Button aria-label="Change server" className="text-muted-foreground hover:text-foreground" onClick={shell.changeServer} size="icon-sm" variant="ghost">
      <ServerIcon />
    </Button>
  );
}

export function App({ link, session, uploader }: { link: Link; session: SessionStore; uploader?: Uploader }) {
  const state = useSyncExternalStore(session.subscribe, session.get);
  const devices = useApi(api.devices);
  const [tab, setTab] = useState<Tab>("chat");
  const [target, setTarget] = useState<number | null>(null);
  const shown = useCallback(() => {
    setTarget(null);
  }, []);

  return (
    <MessageScrollerProvider>
      <Tabs
        className="flex h-dvh flex-col gap-0"
        onValueChange={(v) => {
          if (isTab(v)) setTab(v);
        }}
        value={tab}
      >
        <header
          className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b bg-background pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] md:bg-shell md:pr-3 md:pl-4"
        >
          <span className="hidden items-center gap-2 pr-3 text-ui font-semibold tracking-tight md:flex">optchat</span>
          <span
            aria-label={`connection ${state.status}`}
            className={cn(
              "size-2 shrink-0 rounded-full md:order-first",
              state.status === "open" ? "bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_18%,transparent)]" : "animate-breathe bg-muted-foreground",
            )}
            role="img"
            title={state.status === "open" ? "Connected" : state.status === "connecting" ? "Connecting…" : "Disconnected, reconnecting…"}
          />
          <TabsList className={cn(segmentedList({ ground: "bare" }), "h-auto min-w-0 flex-1 justify-start md:flex-none")}>
            {TABS.map((t) => (
              <TabsTrigger
                className={cn(segmentedItem, "h-8 flex-1 border-0 hover:bg-accent md:flex-none dark:data-[state=active]:bg-raised")}
                key={t}
                value={t}
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="ml-auto flex items-center gap-0.5">
            <ChangeServer />
            <ThemeToggle />
          </div>
        </header>
        <TabsContent className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden" forceMount value="chat">
          <Chat
            devices={devices.data ?? []}
            link={link}
            onTargetShown={shown}
            session={session}
            state={state}
            target={target}
            uploader={uploader}
          />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto" value="memory">
          <Memory
            onShowInChat={(i) => {
              setTarget(i);
              setTab("chat");
            }}
          />
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto" value="stats">
          <ScreenBoundary>
            <Suspense fallback={<p className="p-6 text-ui text-muted-foreground">Loading…</p>}>
              <Stats />
            </Suspense>
          </ScreenBoundary>
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto" value="devices">
          <Devices />
        </TabsContent>
      </Tabs>
    </MessageScrollerProvider>
  );
}
