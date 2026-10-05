// The terminal REPL (ref §10), a client of the server's /ws (E1). Plain output, no redraws beyond
// the input line, so the scrollback works. The screen is a state machine fed keys and AG-UI
// events; `runRepl` wires it to the terminal and the socket.
import { Effect, Option, Schema } from "effect";
import { type Key, makeKeys } from "./keys.ts";

const Phase = Schema.Literals(["idle", "priming", "running", "waiting"]);
const State = Schema.Struct({
  phase: Phase,
  device: Schema.String,
  waiting: Schema.Number,
  viewBytes: Schema.Number,
  budget: Schema.Number,
  messages: Schema.Number,
});
type State = typeof State.Type;

// the AG-UI events the REPL shows; any other event is dropped
const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal("TEXT_MESSAGE_START"), messageId: Schema.String, role: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TEXT_MESSAGE_CONTENT"), messageId: Schema.String, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TEXT_MESSAGE_END"), messageId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TOOL_CALL_START"), toolCallName: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TOOL_CALL_ARGS"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TOOL_CALL_END") }),
  Schema.Struct({ type: Schema.Literal("RUN_STARTED") }),
  Schema.Struct({ type: Schema.Literal("RUN_FINISHED") }),
  Schema.Struct({ type: Schema.Literal("RUN_ERROR"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("CUSTOM"), name: Schema.Literal("info"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("CUSTOM"), name: Schema.Literal("thinking") }),
  Schema.Struct({ type: Schema.Literal("STATE_SNAPSHOT"), snapshot: Schema.Record(Schema.String, Schema.Json) }),
  Schema.Struct({
    type: Schema.Literal("STATE_DELTA"),
    delta: Schema.Array(Schema.Struct({ op: Schema.Literal("replace"), path: Schema.String, value: Schema.Json })),
  }),
]);
export type Inbound = typeof Inbound.Type;
const decodeInbound = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));
export const parseInbound = (frame: string) => decodeInbound(frame);
const decodeState = Schema.decodeUnknownOption(State);

const ViewLines = Schema.Struct({ lines: Schema.Array(Schema.Struct({ id: Schema.Number, n: Schema.Number, text: Schema.String })) });
const decodeView = Schema.decodeUnknownOption(ViewLines);

export type Action =
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "abort" | "exit" | "suspend" };

export type ScreenOptions = {
  readonly write: (s: string) => void;
  readonly color: boolean;
  readonly tty: boolean; // a prompt and an input line; otherwise every message is echoed
  readonly columns: () => number;
};

// Model and tool text can't drive the terminal: control characters other than \n and \t, and C1, go
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
export const clean = (s: string) => s.replaceAll(CONTROLS, "");

const kb = (n: number) => (n / 1000).toFixed(1);
const graphemes = new Intl.Segmenter();

export function makeScreen(o: ScreenOptions) {
  let input = ""; // typed, not sent yet
  let promptShown = false;
  let atLineStart = true;
  let busy = false;
  let armed = false; // a Ctrl-C with no key since: the next one exits
  let tool: { name: string; args: string } | null = null;
  let thinking = false;
  let state: Record<string, Schema.Json> = {};
  let shownWaiting = -1;
  let headerShown = false;
  const mine: string[] = []; // sent from here, not logged yet: their user events are not shown again
  const users = new Set<string>(); // the ids of user messages being logged

  const dim = (s: string) => (o.color ? `\u001B[2m${s}\u001B[0m` : s);
  const row = (s: string) => {
    const one = s.replaceAll(/\s*\n\s*/g, " ");
    const width = Math.max(10, o.columns() - 1);
    return one.length > width ? `${one.slice(0, width - 1)}…` : one;
  };

  const hidePrompt = () => {
    if (!promptShown) return;
    o.write("\r\u001B[2K");
    promptShown = false;
  };
  const showPrompt = () => {
    if (!o.tty || promptShown || !atLineStart || (busy && input === "")) return;
    o.write(`> ${input}`);
    promptShown = true;
  };
  const print = (s: string) => {
    if (s === "") return;
    hidePrompt();
    o.write(s);
    atLineStart = s.endsWith("\n");
    showPrompt();
  };
  const line = (s: string) => {
    print(`${atLineStart ? "" : "\n"}${s}\n`);
  };
  const note = (s: string) => {
    line(dim(s));
  };

  const header = (st: State) => {
    note(`optchat: ${st.messages} messages · view ${kb(st.viewBytes)}/${st.budget / 1000} KB (${Math.round((100 * st.viewBytes) / st.budget)}%) · device ${st.device}`);
    note(o.tty ? "Ctrl-C cancels, Ctrl-D exits" : "reading messages from stdin");
  };

  const applyState = (next: Record<string, Schema.Json>) => {
    state = next;
    const st = Option.getOrUndefined(decodeState(state));
    if (!st) return;
    if (!headerShown) {
      headerShown = true;
      header(st);
    }
    busy = st.phase !== "idle";
    if (st.phase === "waiting" && st.waiting !== shownWaiting && st.waiting > 0) note(`waiting for ${st.waiting} summaries…`);
    shownWaiting = st.phase === "waiting" ? st.waiting : -1;
    showPrompt();
  };

  // a user message was logged: shown unless it is one sent from here, which is on screen already
  const logged = (text: string) => {
    const at = mine.indexOf(text);
    if (at === -1) note(`> ${row(clean(text))}`);
    else mine.splice(at, 1);
  };

  const sent = (text: string) => {
    mine.push(text);
    busy = true;
  };

  return {
    get busy() {
      return busy;
    },

    // the last view lines, before the socket's first state
    intro(lines: readonly string[], total: number) {
      if (total > lines.length) note(`… ${total - lines.length} earlier view lines (optchat view)`);
      for (const l of lines) line(row(clean(l)));
    },

    event(e: Inbound) {
      switch (e.type) {
        case "TEXT_MESSAGE_START":
          if (e.role === "user") users.add(e.messageId);
          return;
        case "TEXT_MESSAGE_CONTENT":
          if (users.has(e.messageId)) logged(e.delta);
          else {
            thinking = false;
            print(clean(e.delta));
          }
          return;
        case "TEXT_MESSAGE_END":
          if (users.delete(e.messageId)) return;
          if (!atLineStart) print("\n");
          return;
        case "TOOL_CALL_START":
          tool = { args: "", name: e.toolCallName };
          return;
        case "TOOL_CALL_ARGS":
          if (tool) tool.args += e.delta;
          return;
        case "TOOL_CALL_END":
          if (tool) note(row(clean(`${tool.name} ${tool.args}`)));
          tool = null;
          return;
        case "RUN_STARTED":
          busy = true;
          return;
        case "RUN_FINISHED":
          thinking = false;
          return;
        case "RUN_ERROR":
          note(`error: ${clean(e.message)}`);
          return;
        case "CUSTOM":
          if (e.name === "info") note(clean(e.value));
          else if (!thinking) {
            thinking = true;
            note("thinking…");
          }
          return;
        case "STATE_SNAPSHOT":
          applyState(e.snapshot);
          return;
        case "STATE_DELTA": {
          const next = { ...state };
          for (const op of e.delta) next[op.path.slice(1)] = op.value;
          applyState(next);
          return;
        }
      }
    },

    // a line from a stdin that is not a terminal: one message each, echoed
    submit(text: string): Action | null {
      const t = text.trim();
      if (!t) return null;
      line(`> ${t}`);
      sent(t);
      return { text: t, type: "send" };
    },

    key(k: Key): Action | null {
      const wasArmed = armed;
      armed = false;
      switch (k.type) {
        case "text":
        case "paste": {
          input += k.text;
          if (promptShown) o.write(k.text.replaceAll("\n", "\r\n"));
          else showPrompt();
          return null;
        }
        case "backspace": {
          // a pasted newline can't be taken back: the rows above it are not redrawn
          const last = [...graphemes.segment(input)].at(-1)?.segment;
          if (last === undefined || last === "\n") return null;
          input = input.slice(0, input.length - last.length);
          if (promptShown) o.write("\b \b");
          return null;
        }
        case "clear":
          hidePrompt();
          input = "";
          showPrompt();
          return null;
        case "enter": {
          const text = input.trim();
          input = "";
          if (promptShown) o.write("\r\n");
          promptShown = false;
          atLineStart = true;
          if (!text) {
            showPrompt();
            return null;
          }
          sent(text);
          return { text, type: "send" };
        }
        case "interrupt":
          if (busy) {
            armed = true;
            note("cancelled (Ctrl-C again exits)");
            return { type: "abort" };
          }
          if (wasArmed) return { type: "exit" };
          armed = true;
          hidePrompt();
          input = "";
          note("(Ctrl-C again or Ctrl-D exits)");
          return null;
        case "eof":
          return input === "" ? { type: "exit" } : null;
        case "suspend":
          hidePrompt();
          return { type: "suspend" };
      }
    },

    // back from Ctrl-Z
    redraw() {
      showPrompt();
    },

    // leaving: the cursor on a fresh line
    finish() {
      hidePrompt();
      if (!atLineStart) o.write("\n");
    },

    // the socket went away or came back
    disconnected() {
      busy = false;
      mine.length = 0;
      users.clear();
      note("disconnected from the server; reconnecting…");
    },
  };
}
export type Screen = ReturnType<typeof makeScreen>;

// ---------------------------------------------------------------------------------------------

const PASTE_ON = "\u001B[?2004h";
const PASTE_OFF = "\u001B[?2004l";
const RECONNECT_MS = 2000;
const INTRO_LINES = 5;

export type ReplOptions = {
  readonly url: string; // http(s)://host:port of optchat-server
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
};

const runInput = (text: string) =>
  JSON.stringify({
    context: [],
    forwardedProps: {},
    messages: [{ content: text, id: crypto.randomUUID(), role: "user" }],
    runId: crypto.randomUUID(),
    state: {},
    threadId: "repl",
    tools: [],
  });

const fetchIntro = (base: string) =>
  Effect.tryPromise(async () => {
    const res = await fetch(new URL("/api/view", base));
    return decodeView(await res.json());
  }).pipe(Effect.orElseSucceed(() => Option.none()));

export const runRepl = (o: ReplOptions) =>
  Effect.gen(function* () {
    const stdin = o.stdin ?? process.stdin;
    const stdout = o.stdout ?? process.stdout;
    const tty = stdin.isTTY;
    const write = (s: string) => {
      try {
        stdout.write(s);
      } catch {
        // the terminal is gone (SIGHUP when the window closes): nothing left to show
      }
    };
    const screen = makeScreen({ color: stdout.isTTY, columns: () => stdout.columns || 80, tty, write });

    const view = yield* fetchIntro(o.url);
    if (Option.isSome(view)) {
      const lines = view.value.lines.filter((l) => l.n === 1).slice(-INTRO_LINES);
      screen.intro(
        lines.map((l) => `${l.id}+${l.n}|${l.text}`),
        view.value.lines.length,
      );
    }

    const terminal = Effect.acquireRelease(
      Effect.sync(() => {
        if (!tty) return;
        stdin.setRawMode(true);
        write(PASTE_ON);
      }),
      () =>
        Effect.sync(() => {
          screen.finish();
          if (!tty) return;
          write(PASTE_OFF);
          stdin.setRawMode(false);
        }),
    );
    yield* terminal;

    yield* Effect.callback<"ended">((resume) => {
      const wsUrl = new URL("/ws", o.url);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket | null = null;
      let open = false;
      let closing = false;
      let ended = false; // stdin ended: exit once nothing runs
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outbox: string[] = [];

      const send = (frame: string) => {
        if (open && ws) ws.send(frame);
        else outbox.push(frame);
      };
      const done = () => {
        if (closing) return;
        closing = true;
        clearTimeout(timer);
        ws?.close();
        stdin.off("data", onData);
        stdin.pause();
        process.off("SIGCONT", onCont);
        resume(Effect.succeed("ended"));
      };
      const act = (a: Action | null) => {
        if (!a) return;
        switch (a.type) {
          case "send":
            send(runInput(a.text));
            return;
          case "abort":
            send(JSON.stringify({ type: "abort" }));
            return;
          case "exit":
            done();
            return;
          case "suspend":
            write(PASTE_OFF);
            stdin.setRawMode(false);
            process.kill(0, "SIGTSTP"); // the whole job stops; fg brings SIGCONT
            return;
        }
      };
      const onCont = () => {
        if (!tty) return;
        stdin.setRawMode(true);
        write(PASTE_ON);
        screen.redraw();
      };
      process.on("SIGCONT", onCont);

      const keys = makeKeys();
      let pending = "";
      const decoder = new TextDecoder();
      const onData = (chunk: Uint8Array) => {
        if (tty) {
          for (const k of keys(chunk)) act(screen.key(k));
          return;
        }
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const l of lines) act(screen.submit(l));
      };
      stdin.on("data", onData);
      if (!tty)
        stdin.on("end", () => {
          act(screen.submit(pending));
          ended = true;
          if (!screen.busy) done();
        });
      stdin.resume();

      const connect = () => {
        const socket = new WebSocket(wsUrl);
        ws = socket;
        socket.addEventListener("open", () => {
          open = true;
          for (const f of outbox.splice(0)) socket.send(f);
        });
        socket.addEventListener("message", (m) => {
          Option.map(parseInbound(String(m.data)), (e) => {
            screen.event(e);
            if (ended && !screen.busy) done();
          });
        });
        socket.addEventListener("close", () => {
          open = false;
          if (closing) return;
          screen.disconnected();
          if (ended) {
            done();
            return;
          }
          timer = setTimeout(connect, RECONNECT_MS);
        });
      };
      connect();
      return Effect.sync(done);
    });
  }).pipe(Effect.scoped);
