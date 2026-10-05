// The app (SPEC "Web UI"): one page with four tabs and no router. The chat stays mounted while
// another tab is open, so its log and the live turn are there when you come back. One /ws link
// for the whole page.
import { Button } from "@/components/ui/button";
import { MessageScrollerProvider } from "@/components/ui/message-scroller";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { Link } from "@/lib/connection";
import type { SessionStore } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { MoonIcon, SunIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useState, useSyncExternalStore } from "react";
import { Chat } from "./chat/chat";
import { Devices } from "./devices/devices";
import { Memory } from "./memory/memory";

// recharts is most of a chart's weight; the chat shouldn't wait for it
const Stats = lazy(async () => ({ default: (await import("./stats/stats")).Stats }));

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
  };
  return (
    <Button aria-label={dark ? "Light theme" : "Dark theme"} onClick={toggle} size="icon-sm" variant="ghost">
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

export function App({ link, session }: { link: Link; session: SessionStore }) {
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
        <header className="flex items-center gap-2 border-b px-2 pt-[max(0.25rem,env(safe-area-inset-top))] pb-1">
          <span
            aria-label={`connection ${state.status}`}
            className={`size-2 shrink-0 rounded-full ${state.status === "open" ? "bg-green-600" : "bg-muted-foreground"}`}
            role="img"
          />
          <TabsList className="min-w-0 flex-1">
            {TABS.map((t) => (
              <TabsTrigger className="capitalize" key={t} value={t}>
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
          <ThemeToggle />
        </header>
        <TabsContent className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden" forceMount value="chat">
          <Chat
            devices={devices.data ?? []}
            link={link}
            onTargetShown={shown}
            session={session}
            state={state}
            target={target}
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
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">loading…</p>}>
            <Stats />
          </Suspense>
        </TabsContent>
        <TabsContent className="min-h-0 flex-1 overflow-y-auto" value="devices">
          <Devices />
        </TabsContent>
      </Tabs>
    </MessageScrollerProvider>
  );
}
