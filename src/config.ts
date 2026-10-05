// The gist's constants (gist §1) and the reference's timings (ref §2, §7). Sizes are UTF-8
// bytes, cache marks are characters. Everything that may differ per machine is in
// optchat.config.ts instead.

// a summary line's target size, and the most a free node may hold
export const NODE = 512;
// the view's budget
export const VIEW = 128_000;
// compactor calls at once
export const JOBS = 8;
// tries per node to get a summary under NODE
export const TRIES = 5;
// the wait before a failed node is tried again: fixed, forever
export const RETRY = "10 seconds";
// the most characters of one tool result that get logged
export const CAP = 30_000;
// cache breakpoints inside the view
export const MARKS: readonly number[] = [50_000, 80_000, 100_000];

export const CALL_TIMEOUT = "5 minutes";
export const KILL_GRACE = "5 seconds";
export const PRIME_TIMEOUT = "30 seconds";
export const PRIME_IDLE = "1 second";
