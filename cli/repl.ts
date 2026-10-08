// The terminal REPL (ref §10), a client of the server's /ws (E1). Plain output, no redraws beyond
// the input line, so the scrollback works. The screen is a state machine fed keys and AG-UI
// events; `runRepl` wires it to the terminal and the socket.
import { Data, Effect, Option, Schema } from "effect";
import { FollowUp } from "../src/wire.ts";
import { type Key, makeKeys } from "./keys.ts";

const Phase = Schema.Literals(["idle", "running", "waiting", "needs-model"]);
const State = Schema.Struct({
  phase: Phase,
  device: Schema.String,
  waiting: Schema.Number,
  viewBytes: Schema.Number,
  budget: Schema.Number,
  messages: Schema.Number,
  // what a message sent mid-run does, and the messages the server holds: a queued one waits for the next turn
  followUp: Schema.optional(FollowUp),
  pending: Schema.optional(Schema.Array(Schema.Struct({ clientId: Schema.NullOr(Schema.String), text: Schema.String, queued: Schema.optional(Schema.Boolean) }))),
  // the engines a message may be for (the first when it names none), and the one that stopped a
  // turn waiting for a resume
  engines: Schema.optional(Schema.Array(Schema.Struct({ ref: Schema.String, label: Schema.String, down: Schema.NullOr(Schema.String) }))),
  stopped: Schema.optional(Schema.NullOr(Schema.Struct({ ref: Schema.String, label: Schema.String, why: Schema.String }))),
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
  // a message from a client (its id) is log entry messageId, or could not be logged
  Schema.Struct({
    type: Schema.Literal("CUSTOM"),
    name: Schema.Literal("ack"),
    value: Schema.Struct({ clientId: Schema.String, messageId: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) }),
  }),
  // a client took a held message back: one sent from here is not answered
  Schema.Struct({
    type: Schema.Literal("CUSTOM"),
    name: Schema.Literal("taken-back"),
    value: Schema.Struct({ clientId: Schema.String, error: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String) }),
  }),
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
  // id: the AG-UI message id; engine: the one `/model` chose here, if any (else the chain's first)
  | { readonly type: "send"; readonly text: string; readonly id: string; readonly engine?: string }
  | { readonly type: "follow-up"; readonly followUp: typeof FollowUp.Type } // "/steer" or "/queue" typed alone
  | { readonly type: "resume"; readonly engine: string } // "/resume [<n>]": a turn waiting for a model goes on there
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
  const mine: string[] = []; // the ids of messages sent from here, not acked yet
  const own = new Set<string>(); // the log ids of messages sent from here: not shown again
  let logging = 0; // sent from here and logged, their run not over yet
  let failed = 0; // sent from here and not answered: the server could not log them, or their run ended in an error
  let offline = false; // the connection is down and the user has been told so
  const users = new Set<string>(); // the ids of user messages being logged
  const refused = new Set<string>(); // the ids of messages sent from here that the log refused
  const queued = new Set<string>(); // the ids of messages sent from here that the user was told wait for the next turn
  let followUp: string | null = null;
  let engines: NonNullable<State["engines"]> = [];
  let model: string | null = null; // the engine `/model` chose for messages sent from here; null: none named
  let stopped: State["stopped"] = null; // the engine that stopped the turn waiting for a resume, and why
  let stuck = false; // a turn waits for a resume

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
    const percent = Math.round((st.viewBytes / st.budget) * 100);
    note(`optchat: ${st.messages} messages · view ${kb(st.viewBytes)}/${st.budget / 1000} KB (${percent}%) · device ${st.device}${st.followUp ? ` · follow-ups ${st.followUp}` : ""}`);
    note(o.tty ? "Ctrl-C cancels, Ctrl-D exits, /steer or /queue sets what a message sent mid-run does, /model picks the model for your messages" : "reading messages from stdin");
  };

  const applyState = (next: Record<string, Schema.Json>) => {
    state = next;
    const st = Option.getOrUndefined(decodeState(state));
    if (!st) return;
    if (!headerShown) {
      headerShown = true;
      header(st);
    } else if (st.followUp && followUp !== null && st.followUp !== followUp) note(`follow-ups: ${st.followUp === "queue" ? "queued for the next turn" : "steer the running turn"}`);
    followUp = st.followUp ?? null;
    engines = st.engines ?? [];
    stopped = st.stopped ?? null;
    // a turn stopped on a usage limit or an offline device waits for /resume: why, said once
    const nowStuck = st.phase === "needs-model";
    const why = stopped ? `${stopped.label} stopped: ${clean(stopped.why)}. ` : "";
    if (nowStuck && !stuck) listModels(`${why}${o.tty ? "/resume tries it again, /resume <n> goes on with another, Ctrl-C stops:" : "A turn waits for a model; nothing here can resume it."}`);
    stuck = nowStuck;
    // ours that the server holds for the next turn while one runs: said once each
    for (const m of st.pending ?? [])
      if (m.queued && st.phase === "running" && m.clientId !== null && mine.includes(m.clientId) && !queued.has(m.clientId)) {
        queued.add(m.clientId);
        note(`queued for the next turn: ${row(clean(m.text))}`);
      }
    busy = st.phase !== "idle";
    // idle comes after the loop committed: whatever of ours it logged has had its answer, or had
    // its turn cancelled before it began (waiting for summaries: no run, so no run end)
    if (!busy) logging = 0;
    if (st.phase === "waiting" && st.waiting !== shownWaiting && st.waiting > 0) note(`waiting for ${st.waiting} summaries…`);
    shownWaiting = st.phase === "waiting" ? st.waiting : -1;
    showPrompt();
  };

  // the server says what became of a message: one sent from here is logged (and so not shown
  // again when its user entry follows) or could not be, and counts as answered with an error
  const acked = (clientId: string, messageId: string | null, error: string | null) => {
    const at = mine.indexOf(clientId);
    // one the log refused is acked again when a later turn logs it: not shown again either
    if (at === -1 && messageId !== null && refused.delete(clientId)) own.add(messageId);
    if (at === -1) return;
    mine.splice(at, 1);
    if (messageId !== null) {
      own.add(messageId);
      logging++;
      return;
    }
    failed++;
    refused.add(clientId);
    note(`not logged: ${clean(error ?? "")}`);
  };

  // the engine messages from here are for: the one /model chose, else the chain's first
  const current = () => model ?? engines[0]?.ref ?? null;
  // the engines, numbered for /model and /resume, the one in use here marked, a down one with why
  const listModels = (head: string) => {
    note(head);
    for (const [k, e] of engines.entries()) note(`  ${k + 1}. ${e.label}${e.ref === current() ? " (in use)" : ""}${e.down === null ? "" : ` (unavailable: ${clean(e.down)})`}`);
  };
  const engineAt = (arg: string) => engines[Number(arg) - 1] ?? engines.find((e) => e.ref === arg);
  // "/model" alone lists them; "/model 2" or "/model <ref>" picks the one this REPL's next
  // messages are for. It is this REPL's own choice: nothing is sent.
  const chooseModel = (arg: string) => {
    if (arg === "") {
      listModels("models (/model <n> picks the one for your next messages):");
      return;
    }
    const chosen = engineAt(arg);
    if (!chosen) {
      note(`no model ${arg}: /model lists them`);
      return;
    }
    model = chosen.ref;
    note(`model: ${chosen.label}, for your next messages`);
  };
  // "/resume" retries the engine that stopped the waiting turn; "/resume 2" or "/resume <ref>"
  // goes on with that one
  const resume = (arg: string): Action | null => {
    if (!stuck || !stopped) {
      note("no turn waits for a model");
      return null;
    }
    const chosen = arg === "" ? { ref: stopped.ref } : engineAt(arg);
    if (!chosen) {
      note(`no model ${arg}: /model lists them`);
      return null;
    }
    return { engine: chosen.ref, type: "resume" };
  };

  // a held message of ours that a client (another, or this one) took back: it is not answered
  const takenBack = (clientId: string, text: string | null) => {
    const at = mine.indexOf(clientId);
    if (at === -1 || text === null) return;
    mine.splice(at, 1);
    queued.delete(clientId);
    failed++;
    note(`taken back, not sent: ${row(clean(text))}`);
  };

  const sent = (text: string): Action => {
    const id = crypto.randomUUID();
    mine.push(id);
    busy = true;
    return model === null ? { id, text, type: "send" } : { engine: model, id, text, type: "send" };
  };

  return {
    get busy() {
      return busy;
    },

    // messages sent from here that are not answered yet: not logged, or logged and their run still
    // going. One counts as answered when the run that logged it ends (or the session goes idle after
    // logging it), never by the session's phase alone: the server may not have read it yet.
    get unanswered() {
      return mine.length + logging;
    },

    // messages sent from here that were not answered: not logged, or their run ended in an error
    get failed() {
      return failed;
    },

    // a turn waits for a model (piped, nothing will resume it)
    get stuck() {
      return stuck;
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
          if (users.has(e.messageId)) {
            if (!own.has(e.messageId)) note(`> ${row(clean(e.delta))}`); // from another client
          } else {
            thinking = false;
            print(clean(e.delta));
          }
          return;
        case "TEXT_MESSAGE_END":
          own.delete(e.messageId);
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
          logging = 0;
          return;
        case "RUN_ERROR":
          // a turn stopped for a resume is not over: its messages wait, and why was said with the models
          if (stuck) return;
          failed += logging; // ours that this run logged ended unanswered with it
          logging = 0;
          note(`error: ${clean(e.message)}`);
          return;
        case "CUSTOM":
          if (e.name === "info") note(clean(e.value));
          else if (e.name === "ack") acked(e.value.clientId, e.value.messageId, e.value.error);
          else if (e.name === "taken-back") takenBack(e.value.clientId, e.value.text);
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
      return sent(t);
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
          if (text === "/steer" || text === "/queue") {
            showPrompt();
            return { followUp: text === "/steer" ? "steer" : "queue", type: "follow-up" };
          }
          if (text === "/model" || text.startsWith("/model ")) {
            chooseModel(text.slice("/model".length).trim());
            showPrompt();
            return null;
          }
          if (text === "/resume" || text.startsWith("/resume ")) {
            const resumed = resume(text.slice("/resume".length).trim());
            showPrompt();
            return resumed;
          }
          return sent(text);
        }
        case "interrupt":
          if (busy) {
            armed = true;
            return { type: "abort" }; // `cancel` says whether it went out
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

    // the abort a Ctrl-C asked for went to the server, or was dropped: the socket was not open
    cancel(sent: boolean) {
      note(sent ? "cancel sent; a second Ctrl-C exits" : "not connected: the cancel was not sent");
    },

    // the /resume went to the server (the state will say it), or was dropped: not connected
    resumed(sent: boolean) {
      if (!sent) note("not connected: the resume was not sent; /resume again once connected");
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

    // the socket went away, or could not be opened: said once per outage
    disconnected(retrying: boolean) {
      busy = false;
      mine.length = 0;
      own.clear();
      logging = 0;
      users.clear();
      if (offline) return;
      offline = true;
      note(retrying ? "no connection to the server; trying again in the background…" : "no connection to the server");
    },

    // the socket is open again after an outage
    connected() {
      if (!offline) return;
      offline = false;
      note("connected to the server again");
    },
  };
}
export type Screen = ReturnType<typeof makeScreen>;

// runRepl: the screen wired to the terminal and the socket
const PASTE_ON = "\u001B[?2004h";
const PASTE_OFF = "\u001B[?2004l";
// a lost server is tried again after 2 s, then twice as long each time, up to 30 s
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 30_000;
const INTRO_LINES = 5;

class ReplError extends Data.TaggedError("ReplError")<{ readonly message: string }> {}

// the parts of a terminal the REPL uses: process.stdin and process.stdout, or a test's own
export type TermIn = {
  readonly isTTY?: boolean;
  setRawMode(raw: boolean): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  off(event: "data", listener: (chunk: Uint8Array) => void): void;
  pause(): void;
  resume(): void;
};
export type TermOut = { readonly isTTY?: boolean; readonly columns?: number; write(s: string): void };

export type ReplOptions = {
  readonly url: string; // http(s)://host:port of optchat-server
  readonly stdin?: TermIn;
  readonly stdout?: TermOut;
};

// What goes to the server's socket. A message sent while it is closed waits, and goes out in order
// when it opens again. An abort never waits: sent only while it is open (false otherwise), so a
// stale one never cancels the next turn (SPEC "Server, WebSocket API and CLI").
export type Wire = { readonly send: (frame: string) => void };
export const ABORT = JSON.stringify({ type: "abort" });
export function makeLink() {
  let socket: Wire | null = null;
  const outbox: string[] = [];
  return {
    opened(ws: Wire) {
      socket = ws;
      for (const f of outbox.splice(0)) ws.send(f);
    },
    closed() {
      socket = null;
    },
    send(frame: string) {
      if (socket) socket.send(frame);
      else outbox.push(frame);
    },
    abort() {
      return this.now(ABORT);
    },
    // a frame that only means something now (an abort, a resume: kept for later, it would settle
    // whatever turn waits after the reconnect); false when it was not sent
    now(frame: string) {
      if (!socket) return false;
      socket.send(frame);
      return true;
    },
  };
}

// a message with its forwardedProps: `engine` of the master's chain when /model chose one (else
// the server's first); an unset one is left out of the JSON
const runInput = (text: string, id: string, forwardedProps: { readonly engine?: string } = {}) =>
  JSON.stringify({
    context: [],
    forwardedProps,
    messages: [{ content: text, id, role: "user" }],
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
    const stdin: TermIn = o.stdin ?? process.stdin;
    const stdout: TermOut = o.stdout ?? process.stdout;
    const tty = stdin.isTTY === true;
    const write = (s: string) => {
      try {
        stdout.write(s);
      } catch {
        // the terminal is gone (SIGHUP when the window closes): nothing left to show
      }
    };
    const screen = makeScreen({ color: stdout.isTTY === true, columns: () => (stdout.columns !== undefined && stdout.columns > 0 ? stdout.columns : 80), tty, write });

    const view = yield* fetchIntro(o.url);
    if (Option.isSome(view)) {
      const lines = view.value.lines.filter((l) => l.n === 1).slice(-INTRO_LINES);
      screen.intro(
        lines.map((v) => `${v.id}+${v.n}|${v.text}`),
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

    yield* Effect.callback<"ended", ReplError>((resume) => {
      const wsUrl = new URL("/ws", o.url);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      let ws: WebSocket | null = null;
      const link = makeLink();
      let everOpen = false;
      let closing = false;
      let ended = false; // stdin ended (piped): exit once every message sent from here is answered
      let retries = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (failure?: string) => {
        if (closing) return;
        closing = true;
        clearTimeout(retryTimer);
        ws?.close();
        stdin.off("data", onData);
        stdin.pause();
        process.off("SIGCONT", onCont);
        resume(failure === undefined ? Effect.succeed("ended") : Effect.fail(new ReplError({ message: failure })));
      };
      // piped: the input is all sent and all answered; one the server could not log, or whose run
      // ended in an error (a refusal, a spent plan, a cancel), makes the exit code non-zero
      const finishedPiping = () => {
        if (ended && screen.stuck) done("a turn stopped and waits for a model (optchat at a terminal: /resume)");
        else if (ended && screen.unanswered === 0) done(screen.failed > 0 ? `${screen.failed} message(s) not answered: not logged, or their run ended in an error` : undefined);
      };
      const act = (a: Action | null) => {
        if (!a) return;
        switch (a.type) {
          case "send":
            link.send(runInput(a.text, a.id, { engine: a.engine }));
            return;
          case "abort":
            screen.cancel(link.abort());
            return;
          case "follow-up":
            link.send(JSON.stringify({ followUp: a.followUp, type: "settings" })); // a setting may wait for the connection, unlike an abort
            return;
          case "resume":
            screen.resumed(link.now(JSON.stringify({ engine: a.engine, type: "resume" })));
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
          finishedPiping();
        });
      stdin.resume();

      // Piped, a lost connection ends the run: what was sent may or may not have reached the server,
      // so it exits non-zero rather than guess. At a terminal it says so once and keeps trying,
      // backing off, until the server is back.
      const lost = () => {
        if (!tty) {
          if (ended && screen.unanswered === 0) finishedPiping();
          else if (everOpen) done(`the connection to ${o.url} closed with ${screen.unanswered} message(s) unanswered`);
          else done(`cannot reach the server at ${o.url}`);
          return;
        }
        screen.disconnected(true);
        retryTimer = setTimeout(connect, Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** retries));
        retries++;
      };

      const connect = () => {
        const socket = new WebSocket(wsUrl);
        ws = socket;
        socket.addEventListener("open", () => {
          everOpen = true;
          retries = 0;
          screen.connected();
          link.opened(socket);
        });
        socket.addEventListener("message", (m) => {
          Option.map(parseInbound(String(m.data)), (e) => {
            screen.event(e);
            finishedPiping();
          });
        });
        socket.addEventListener("close", () => {
          link.closed();
          if (!closing) lost();
        });
      };
      connect();
      return Effect.sync(() => {
        done();
      });
    });
  }).pipe(
    Effect.scoped,
    // the REPL's own failure: said on stderr, and the exit code is 1 (cli/optchat.ts needs nothing more)
    Effect.catchTag("ReplError", (e) =>
      Effect.sync(() => {
        process.stderr.write(`optchat: ${e.message}\n`);
        process.exitCode = 1;
      }),
    ),
  );
