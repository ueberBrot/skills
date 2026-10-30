import { Cause, Clock, Effect, Exit, FileSystem, Path, Schema } from "effect";

import { ConditionSchema, WriterOutputSchema } from "../domain";
import { HarnessError } from "../errors";
import { canonicalJson, readJson, sha256, writeJson } from "../internal/json";
import { Writer } from "../writers";

import type { JsonObject, JsonValue, WriterOutput } from "../domain";

export interface CallIdentity {
  readonly task: (typeof CallIdentitySchema.Type)["task"];
  readonly case_id: string;
  readonly repetition: number;
  readonly conditions: readonly string[];
}

interface GradingCall extends CallIdentity {
  readonly id: number;
  readonly prompt_hash: string;
  readonly status: "success" | "error";
  readonly error: string | null;
  readonly response: WriterOutput | null;
  readonly duration_seconds: number;
  readonly assessment: JsonValue;
}

export type CallResult<A> =
  | { readonly data: A; readonly status: "success" }
  | { readonly status: "error" };

interface GraderOptions {
  readonly out: string;
  readonly model: string;
  readonly settings: JsonObject;
  readonly timeout: number;
  readonly resume?: boolean;
}

const identityFields = {
  case_id: Schema.NonEmptyString,
  conditions: Schema.Array(ConditionSchema),
  repetition: Schema.Int.check(Schema.isGreaterThan(0)),
  task: Schema.Literals(["fidelity", "comparison", "answer", "score"]),
};

const identityCheck = Schema.makeFilter(
  (identity: CallIdentity) =>
    (identity.conditions.length === (identity.task === "comparison" ? 2 : 1) &&
      new Set(identity.conditions).size === identity.conditions.length) ||
    "Grading call conditions do not match its task"
);

const CallIdentitySchema = Schema.Struct(identityFields).check(identityCheck);

const callFields = {
  ...identityFields,
  assessment: Schema.Json,
  duration_seconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  error: Schema.NullOr(Schema.String),
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  prompt_hash: Schema.NonEmptyString,
  response: Schema.NullOr(WriterOutputSchema),
  status: Schema.Literals(["success", "error"]),
};

const GradingCallSchema = Schema.Struct(callFields).check(identityCheck);

const CachedCallSchema = Schema.Struct({
  ...callFields,
  prompt: Schema.String,
}).check(
  identityCheck,
  Schema.makeFilter(
    (call) =>
      call.prompt_hash === sha256(call.prompt) ||
      "Stored grading prompt differs from its hash"
  )
);

type CachedCall = typeof CachedCallSchema.Type;

const callKey = (identity: CallIdentity, hash: string): string =>
  canonicalJson({
    case_id: identity.case_id,
    conditions: [...identity.conditions],
    prompt_hash: hash,
    repetition: identity.repetition,
    task: identity.task,
  });

const loadCache = Effect.fn("loadGradingCache")(function* loadGradingCache(
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new Map<string, CachedCall>();
  const ids = new Set<number>();
  let sequence = 0;

  const files = yield* fs.readDirectory(directory);

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    yield* Schema.decodeEffect(
      Schema.String.check(Schema.isPattern(/^\d+\.json$/u))
    )(file);

    const call = yield* Schema.decodeUnknownEffect(CachedCallSchema)(
      yield* readJson(path.join(directory, file)),
      { onExcessProperty: "error" }
    );

    if (Number(file.slice(0, -5)) !== call.id || ids.has(call.id)) {
      return yield* new HarnessError({
        message: `Invalid or duplicate grading call ID in ${file}`,
      });
    }

    ids.add(call.id);
    sequence = Math.max(sequence, call.id);

    if (call.status !== "success" || call.response === null) {
      continue;
    }

    const key = callKey(call, call.prompt_hash);
    const previous = cache.get(key);

    if (previous === undefined || call.id > previous.id) {
      cache.set(key, call);
    }
  }

  return { cache, sequence };
});

const saveCall = Effect.fn("saveCall")(function* saveCall(
  file: string,
  call: GradingCall,
  prompt: string
) {
  const data = yield* Schema.decodeEffect(Schema.Json)({
    ...call,
    prompt,
  });

  yield* writeJson(file, data);
});

const decodeAssessment = Effect.fn("decodeAssessment")(
  function* decodeAssessment<A>(
    text: string,
    decode: (text: string) => Effect.Effect<A, HarnessError>
  ) {
    const data = yield* decode(text);

    const json = yield* Schema.decodeUnknownEffect(Schema.Json)(data).pipe(
      Effect.mapError(
        () => new HarnessError({ message: "Grading result is not valid JSON" })
      )
    );

    return { data, json };
  }
);

interface GraderState {
  readonly options: GraderOptions;
  readonly writer: Writer["Service"];
  readonly path: Path.Path;
  readonly calls: GradingCall[];
  readonly cache: Map<string, CachedCall>;
  readonly used: Set<number>;
  sequence: number;
}

const reuseCall = Effect.fn("reuseGradingCall")(function* reuseGradingCall<A>(
  state: GraderState,
  identity: CallIdentity,
  prompt: string,
  decode: (text: string) => Effect.Effect<A, HarnessError>
) {
  const previous = state.cache.get(callKey(identity, sha256(prompt)));

  if (previous === undefined || previous.response === null) {
    return null;
  }

  const outcome = yield* Effect.result(
    decodeAssessment(previous.response.output, decode)
  );

  if (outcome._tag === "Failure") {
    return null;
  }

  if (!state.used.has(previous.id)) {
    const call = yield* Schema.decodeEffect(GradingCallSchema)(previous);
    state.used.add(previous.id);
    state.calls.push({ ...call, assessment: outcome.success.json });
  }

  return {
    data: outcome.success.data,
    status: "success" as const,
  } satisfies CallResult<A>;
});

const executeCall = <A>(
  state: GraderState,
  identity: CallIdentity,
  prompt: string,
  decode: (text: string) => Effect.Effect<A, HarnessError>
) =>
  Effect.gen(function* executeGradingCall() {
    const validated = yield* Schema.decodeUnknownEffect(CallIdentitySchema)(
      identity,
      { onExcessProperty: "error" }
    );

    const cached = yield* reuseCall(state, validated, prompt, decode);

    if (cached !== null) {
      return cached;
    }

    state.sequence += 1;
    const id = state.sequence;
    const started = yield* Clock.currentTimeNanos;

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* commitGradingCall() {
        const generated = yield* Effect.exit(
          restore(
            state.writer.execute(
              {
                model: state.options.model,
                prompt,
                settings: state.options.settings,
              },
              state.options.timeout
            )
          )
        );

        const response = Exit.isSuccess(generated) ? generated.value : null;

        const outcome: Exit.Exit<{ data: A; json: JsonValue }, HarnessError> =
          Exit.isSuccess(generated)
            ? yield* Effect.exit(
                decodeAssessment(generated.value.output, decode)
              )
            : Exit.failCause(generated.cause);

        const call: GradingCall = {
          ...validated,
          assessment: Exit.isSuccess(outcome) ? outcome.value.json : null,
          duration_seconds:
            Number((yield* Clock.currentTimeNanos) - started) / 1e9,
          error: Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : null,
          id,
          prompt_hash: sha256(prompt),
          response,
          status: Exit.isSuccess(outcome) ? "success" : "error",
        };

        yield* saveCall(
          state.path.join(
            state.options.out,
            "calls",
            `${String(id).padStart(4, "0")}.json`
          ),
          call,
          prompt
        );

        state.calls.push(call);

        if (Exit.isSuccess(outcome)) {
          return {
            data: outcome.value.data,
            status: "success" as const,
          } satisfies CallResult<A>;
        }

        if (Cause.hasInterrupts(outcome.cause)) {
          return yield* Effect.failCause(outcome.cause);
        }

        return { status: "error" as const } satisfies CallResult<A>;
      })
    );
  });

export const makeGrader = Effect.fn("makeGrader")(function* makeGrader(
  options: GraderOptions
) {
  const path = yield* Path.Path;

  const stored =
    options.resume === true
      ? yield* loadCache(path.join(options.out, "calls"))
      : { cache: new Map<string, CachedCall>(), sequence: 0 };

  const state: GraderState = {
    cache: stored.cache,
    calls: [],
    options,
    path,
    sequence: stored.sequence,
    used: new Set(),
    writer: yield* Writer,
  };

  const execute = <A>(
    identity: CallIdentity,
    prompt: string,
    decode: (text: string) => Effect.Effect<A, HarnessError>
  ) => executeCall(state, identity, prompt, decode);

  return { calls: state.calls, execute };
});

export type Grader = Effect.Success<ReturnType<typeof makeGrader>>;
