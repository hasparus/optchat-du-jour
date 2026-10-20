// A raw HTTP/1.1 server on a free port that answers each request from a script, for what Bun.serve
// can't do: drop a connection without an answer, stall a stream after its first bytes, cut one
// off halfway (a chunked body with no last chunk, which a client reads as a broken connection).
// It keeps every request's body. No model.
import type { Socket } from "bun";

export type Step =
  // a whole answer
  | { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body: string }
  // the connection closes before any answer
  | { readonly drop: true }
  // a 200 event stream: these chunks, then its end, nothing more (the socket stays open), or a cut
  | { readonly chunks: readonly string[]; readonly after: "end" | "hang" | "cut" };

type Pending = { text: string };

export function fakeHttp() {
  const script: Step[] = [];
  const bodies: string[] = [];
  const open = new Set<Socket<Pending>>();
  const answer = (socket: Socket<Pending>, step: Step) => {
    if ("drop" in step) {
      socket.terminate();
      return;
    }
    if ("body" in step) {
      const headers = Object.entries({ "content-type": "application/json", ...step.headers }).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      socket.write(`HTTP/1.1 ${step.status} X\r\n${headers}content-length: ${Buffer.byteLength(step.body)}\r\nconnection: close\r\n\r\n${step.body}`);
      socket.end();
      return;
    }
    socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n");
    for (const chunk of step.chunks) socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
    if (step.after === "end") {
      socket.write("0\r\n\r\n");
      socket.end();
    } else if (step.after === "cut") socket.terminate();
  };
  const server = Bun.listen<Pending>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      close: (socket) => {
        open.delete(socket);
      },
      data: (socket, data) => {
        socket.data.text += data.toString("utf8");
        const head = socket.data.text.indexOf("\r\n\r\n");
        if (head === -1) return;
        const length = Number(/content-length: (\d+)/i.exec(socket.data.text.slice(0, head))?.[1] ?? 0);
        const body = socket.data.text.slice(head + 4);
        if (Buffer.byteLength(body) < length) return;
        bodies.push(body);
        socket.data.text = "";
        answer(socket, script.shift() ?? { body: '{"error":{"message":"the script ran out"}}', status: 500 });
      },
      open: (socket) => {
        socket.data = { text: "" };
        open.add(socket);
      },
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    bodies,
    script,
    stop: () => {
      for (const s of open) s.terminate();
      server.stop(true);
    },
  };
}

// one server-sent event
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export const sse = (event: { readonly type: string; readonly [key: string]: Json }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
