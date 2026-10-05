// What the server and the device runner share about HTTP: who counts as this machine, the 403
// they answer, and the router's `use` under a name the lint rules leave alone.
import { HttpRouter, HttpServerResponse } from "effect/http";

// a caller on this machine
export const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const forbidden = HttpServerResponse.text("forbidden", { status: 403 });

// HttpRouter.use, renamed: the React hooks rule takes any `use(` call for a hook
export const mount = HttpRouter.use;
