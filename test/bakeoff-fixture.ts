import type { Metrics } from "../dev/bakeoff-artifact.ts";

export const metrics: Metrics = {
  cost: { callsPerMessage: 1, cold: 0, dollarsPerMessage: 0, failovers: 0, tokensPerMessage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 } },
  findability: { asked: 0, found: 0, share: 0 },
  messages: 1,
  nodes: 1,
  overLimit: 0,
  reportCount: 0,
  tries: { max: 1, mean: 1, nodes: 1, p95: 1 },
  wordsKept: [],
};
