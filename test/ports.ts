// A port nothing listens on right now, for a server a test starts (or for one that is offline).
export const freePort = () => {
  const s = Bun.serve({ fetch: () => new Response(), hostname: "127.0.0.1", port: 0 });
  const port = s.port ?? 0;
  void s.stop(true);
  return port;
};
