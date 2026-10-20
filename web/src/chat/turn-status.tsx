// What the dock says of the turn and the link beyond the status line (SPEC "Web UI", Chat): while
// the turn's engine waits to ask again, a quiet countdown in place of the shimmering status (E43);
// and once the server runs another build, a banner on the composer's tray to reload (E44).
import { Button } from "@/components/ui/button";
import type { SessionState } from "@wire";
import { RefreshCwIcon } from "lucide-react";
import { useNow } from "./background-work";

type Retry = NonNullable<SessionState["retry"]>;

// whole seconds left of a pause told `ms` long at `stateAt` (this page's clock, when the state came)
export const secondsLeft = (retry: Retry, stateAt: number, now: number) => Math.max(0, Math.ceil((retry.ms - (now - stateAt)) / 1000));

// "Busy, asking again in 7 s", counting down once a second; at 0, until the next try is told
export function RetryCountdown({ retry, stateAt }: { readonly retry: Retry; readonly stateAt: number }) {
  const left = secondsLeft(retry, stateAt, useNow(true));
  return (
    <span className="text-muted-foreground tabular-nums" data-testid="retry-countdown" title={`Try ${retry.next} of ${retry.tries}`}>
      {left > 0 ? `Busy, asking again in ${left} s` : "Busy, asking again…"}
    </span>
  );
}

// The server closed the link as from another build (E44): reconnecting would get the same answer,
// so the page asks to be reloaded, which loads the new build
export function Outdated() {
  return (
    <div className="flex items-center gap-2.5 px-3.5 py-3 text-ui" data-testid="outdated" role="alert">
      <RefreshCwIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 grow text-foreground">OptChat was updated — reload</p>
      <Button
        className="h-8 shrink-0 rounded-lg pointer-coarse:h-10"
        onClick={() => {
          location.reload();
        }}
        size="sm"
      >
        Reload
      </Button>
    </div>
  );
}
