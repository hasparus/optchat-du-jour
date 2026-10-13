import { Array as Arr, Data, Result, Schema } from "effect";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atRoleEffort, duplicateRefs, isEffort, parseRef, type Settings } from "../src/config.ts";
import { Kind } from "../src/records.ts";

export type Contender = { readonly name: string; readonly byLevel: Settings["compactor"]["byLevel"] };

export class BakeoffOptionsError extends Data.TaggedError("BakeoffOptionsError")<{}> {}

export const USAGE =
  "usage: bun dev/bakeoff.ts --from <data dir | LOG.txt> --chain name=chain [--chain …] --out file.json --max-requests N [--no-fail-fast] [--overwrite] [--effort medium] [--n 500] [--skip 0] [--kinds user] [--questions 50] [--deadline 120 (minutes)]";
export const HELP = `${USAGE}\n\nRuns contenders sequentially with a single global authorized-request cap.\n--no-fail-fast continues with the next contender after a contender-local failure.\nArtifacts use V2 running, complete, completed-with-failures, and aborted outcomes.`;

export function parseContender(spec: string): Contender {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`--chain ${spec}: expected name=chain`);
  const name = spec.slice(0, eq);
  if (name.length > 100) throw new Error("--chain name is too long");
  const byLevel = spec
    .slice(eq + 1)
    .split(";")
    .map((part) => {
      const match = /^(\d+):(?=[a-z])/.exec(part);
      const from = match ? Number(match[1]) : 0;
      if (!Number.isSafeInteger(from) || from < 0) throw new Error(`--chain ${spec}: levels must be nonnegative safe integers`);
      const refs = (match ? part.slice(match[0].length) : part).split(",").map((raw) => {
        const parsed = parseRef(raw.trim());
        if (Result.isFailure(parsed)) throw new Error(`--chain ${spec}: ${parsed.failure}`);
        return parsed.success;
      });
      const [first, ...rest] = refs;
      if (first === undefined) throw new Error(`--chain ${spec}: an empty chain`);
      return { chain: [first, ...rest] as const, from };
    });
  const [head, ...tail] = byLevel;
  if (head?.from !== 0) throw new Error(`--chain ${spec}: the first chain must start at level 0`);
  for (let index = 1; index < byLevel.length; index++)
    if ((byLevel[index - 1]?.from ?? 0) >= (byLevel[index]?.from ?? 0)) throw new Error(`--chain ${spec}: levels must strictly increase`);
  return { byLevel: [head, ...tail], name };
}

const count = (raw: string, min: number) => {
  const value = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= min ? value : undefined;
};

type ParsedValues = {
  readonly chain?: string[] | undefined;
  readonly deadline: string;
  readonly effort?: string | undefined;
  readonly from?: string | undefined;
  readonly help: boolean;
  readonly kinds: string;
  readonly "max-requests"?: string | undefined;
  readonly n: string;
  readonly "no-fail-fast": boolean;
  readonly out?: string | undefined;
  readonly overwrite: boolean;
  readonly questions: string;
  readonly skip: string;
};
export type BakeoffCommand = { readonly type: "help" } | { readonly type: "run"; readonly values: ParsedValues };

/** The CLI's only argv parser. It performs no settings, filesystem, or keychain work. */
export function parseBakeoffCommand(argv: readonly string[]): BakeoffCommand {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        chain: { multiple: true, type: "string" },
        deadline: { default: "120", type: "string" },
        effort: { type: "string" },
        from: { type: "string" },
        help: { default: false, short: "h", type: "boolean" },
        kinds: { default: "user", type: "string" },
        "max-requests": { type: "string" },
        n: { default: "500", type: "string" },
        "no-fail-fast": { default: false, type: "boolean" },
        out: { type: "string" },
        overwrite: { default: false, type: "boolean" },
        questions: { default: "50", type: "string" },
        skip: { default: "0", type: "string" },
      },
      strict: true,
    });
    const parsed = values as ParsedValues;
    return parsed.help ? { type: "help" } : { type: "run", values: parsed };
  } catch {
    throw new BakeoffOptionsError();
  }
}

export type BakeoffOptions = {
  readonly contenders: readonly Contender[];
  readonly deadlineMinutes: number;
  readonly failFast: boolean;
  readonly from: string;
  readonly kinds: readonly Kind[];
  readonly maxRequests: number;
  readonly messageCount: number;
  readonly out: string;
  readonly overwrite: boolean;
  readonly questionCount: number;
  readonly settings: Settings;
  readonly skip: number;
};

export type BakeoffFiles = {
  readonly sourceExists: (path: string) => boolean;
  readonly outputExists: (path: string) => boolean;
  readonly sameFile?: (source: string, output: string) => boolean;
};

export const sameSourceAndOutput = (source: string, output: string): boolean => {
  const sourceReal = realpathSync(source);
  const outputExists = existsSync(output);
  const outputReal = outputExists ? realpathSync(output) : resolve(realpathSync(dirname(output)), basename(output));
  if (sourceReal === outputReal) return true;
  if (!outputExists) return false;
  const sourceStat = statSync(sourceReal);
  const outputStat = statSync(outputReal);
  return sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino;
};

export function resolveBakeoffOptions(command: Extract<BakeoffCommand, { readonly type: "run" }>, loaded: Settings, files: BakeoffFiles): BakeoffOptions {
  try {
    const values = command.values;
    const maxRequests = values["max-requests"] === undefined ? undefined : count(values["max-requests"], 1);
    const messageCount = count(values.n, 1);
    const skip = count(values.skip, 0);
    const questionCount = count(values.questions, 0);
    const deadlineMinutes = count(values.deadline, 1);
    if (
      values.out === undefined ||
      values.from === undefined ||
      !files.sourceExists(values.from) ||
      !values.chain?.length ||
      maxRequests === undefined ||
      messageCount === undefined ||
      skip === undefined ||
      questionCount === undefined ||
      deadlineMinutes === undefined ||
      (files.outputExists(values.out) && !values.overwrite) ||
      (files.sameFile?.(values.from, values.out) ?? (() => { try { return sameSourceAndOutput(values.from!, values.out!); } catch { return false; } })())
    ) throw new BakeoffOptionsError();

    const contenders = values.chain.map(parseContender);
    if (new Set(contenders.map((contender) => contender.name)).size !== contenders.length) throw new BakeoffOptionsError();
    const effort = values.effort ?? loaded.compactor.effort;
    if (!isEffort(effort)) throw new BakeoffOptionsError();
    const canonical = contenders.map((contender) => ({
      ...contender,
      byLevel: Arr.map(contender.byLevel, (level) => ({ ...level, chain: atRoleEffort(level.chain, effort) })),
    }));
    const duplicates = canonical.flatMap((contender) =>
      contender.byLevel.flatMap((level) => duplicateRefs(`${contender.name}, from level ${level.from}`, level.chain, effort)),
    );
    if (duplicates.length > 0) throw new BakeoffOptionsError();
    const kinds = values.kinds.split(",").map((kind) => Schema.decodeUnknownSync(Kind)(kind));
    if (new Set(kinds).size !== kinds.length) throw new BakeoffOptionsError();
    return {
      contenders: canonical,
      deadlineMinutes,
      failFast: !values["no-fail-fast"],
      from: values.from,
      kinds,
      maxRequests,
      messageCount,
      out: values.out,
      overwrite: values.overwrite,
      questionCount,
      settings: { ...loaded, compactor: { ...loaded.compactor, effort } },
      skip,
    };
  } catch (error) {
    if (error instanceof BakeoffOptionsError) throw error;
    throw new BakeoffOptionsError();
  }
}

/** Test/programmatic convenience; CLI code uses parseBakeoffCommand and resolveBakeoffOptions separately. */
export function parseBakeoffOptions(argv: readonly string[], loaded: Settings, files: BakeoffFiles): BakeoffOptions {
  const command = parseBakeoffCommand(argv);
  if (command.type === "help") throw new BakeoffOptionsError();
  return resolveBakeoffOptions(command, loaded, files);
}
