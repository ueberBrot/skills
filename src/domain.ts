import { Effect, Schema } from "effect";

export const CONDITIONS = ["no_skill", "short_prompt", "full_skill"] as const;
export const ConditionSchema = Schema.Literals(CONDITIONS);

export type Condition = typeof ConditionSchema.Type;

export const sampleKey = (
  caseId: string,
  repetition: number,
  condition: Condition
): string => JSON.stringify([caseId, repetition, condition]);

export const comparisonKey = (caseId: string, repetition: number): string =>
  JSON.stringify([caseId, repetition]);

const SplitSchema = Schema.Literals(["development", "held_out"]);

export type Split = typeof SplitSchema.Type;

export const JsonObjectSchema = Schema.Record(
  Schema.String,
  Schema.mutableKey(Schema.Json)
);

export type JsonObject = typeof JsonObjectSchema.Type;

export type JsonValue = Schema.Json;

const strings = Schema.mutable(Schema.Array(Schema.String));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const nullableString = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null))
);

const nullableObject = Schema.NullOr(JsonObjectSchema).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null))
);

const defaultStrings = strings.pipe(
  Schema.withDecodingDefaultKey(Effect.sync(() => []))
);

const defaultCaseStrings = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefaultKey(Effect.sync(() => []))
);

const defaultObject = JsonObjectSchema.pipe(
  Schema.withDecodingDefaultKey(Effect.sync(() => ({})))
);

export const FixtureSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)),
  input: Schema.optionalKey(Schema.Json),
  request: Schema.NonEmptyString,
  source: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
}).check(
  Schema.makeFilter(
    (fixture) =>
      fixture.source.trim().length > 0 ||
      fixture.input !== undefined ||
      "A fixture requires nonempty source text or a JSON input"
  )
);

export type Fixture = typeof FixtureSchema.Type;

const LanguageSchema = Schema.String.check(
  Schema.isPattern(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu)
);

export const CaseSpecSchema = Schema.Struct({
  anchors: defaultCaseStrings,
  id: Schema.String,
  language: LanguageSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("und"))
  ),
  provenance: Schema.NonEmptyString,
  reader_questions: defaultCaseStrings,
  references: defaultCaseStrings,
  split: SplitSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("development"))
  ),
  task: Schema.NonEmptyString,
});

export const SuiteSpecSchema = Schema.Struct({
  anchor_helper: Schema.optionalKey(Schema.NonEmptyString),
  cases: Schema.Array(CaseSpecSchema).check(Schema.isMinLength(1)),
  checks: Schema.String,
  fixtures: Schema.String,
  name: Schema.NonEmptyString,
  short_prompt: Schema.String,
  skill: Schema.String,
});

export type SuiteSpec = typeof SuiteSpecSchema.Type;

const CaseRecordSchema = Schema.Struct({
  checks: Schema.Array(Schema.String),
  fixture: FixtureSchema,
  spec: CaseSpecSchema,
});

export type CaseRecord = typeof CaseRecordSchema.Type;

export const WriterInputSchema = Schema.Struct({
  model: Schema.mutableKey(nullableString),
  prompt: Schema.mutableKey(Schema.String),
  settings: Schema.mutableKey(defaultObject),
});

export type WriterInput = typeof WriterInputSchema.Type;

export const WriterOutputSchema = Schema.Struct({
  executor_metadata: Schema.mutableKey(nullableObject),
  model: Schema.mutableKey(nullableString),
  output: Schema.mutableKey(Schema.String.check(Schema.isPattern(/\S/u))),
  settings: Schema.mutableKey(nullableObject),
  usage: Schema.mutableKey(nullableObject),
});

export type WriterOutput = typeof WriterOutputSchema.Type;

export const ResultSchema = Schema.Struct({
  anchors_pass: Schema.mutableKey(
    Schema.NullOr(Schema.Boolean).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null))
    )
  ),
  case_id: Schema.mutableKey(Schema.String),
  completed_at: Schema.mutableKey(nullableString),
  condition: Schema.mutableKey(ConditionSchema),
  duration_seconds: Schema.mutableKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  error: Schema.mutableKey(nullableString),
  error_stage: Schema.mutableKey(
    Schema.NullOr(Schema.Literals(["execution", "evaluation"])).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null))
    )
  ),
  executor_metadata: Schema.mutableKey(nullableObject),
  language: Schema.mutableKey(LanguageSchema),
  missing_anchors: Schema.mutableKey(defaultStrings),
  output: Schema.mutableKey(nullableString),
  repetition: Schema.mutableKey(positiveInt),
  reported_model: Schema.mutableKey(nullableString),
  reported_settings: Schema.mutableKey(nullableObject),
  split: Schema.mutableKey(SplitSchema),
  started_at: Schema.mutableKey(nullableString),
  status: Schema.mutableKey(Schema.Literals(["success", "error"])),
  task: Schema.mutableKey(Schema.String),
  usage: Schema.mutableKey(nullableObject),
});

export type Result = typeof ResultSchema.Type;

export const ManifestSchema = Schema.Struct({
  completed_at: Schema.mutableKey(nullableString),
  concurrency: Schema.mutableKey(positiveInt),
  conditions: Schema.mutableKey(
    Schema.mutable(Schema.Array(ConditionSchema)).check(Schema.isMinLength(1))
  ),
  executor_argv: Schema.mutableKey(
    Schema.NullOr(strings).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null))
    )
  ),
  executor_metadata: Schema.mutableKey(nullableObject),
  executor_name: Schema.mutableKey(nullableString),
  executor_timeout_seconds: Schema.mutableKey(
    Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null))
    )
  ),
  file_hashes: Schema.mutableKey(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.String))
  ),
  git_commit: Schema.mutableKey(nullableString),
  git_dirty: Schema.mutableKey(
    Schema.NullOr(Schema.Boolean).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null))
    )
  ),
  limitations: Schema.mutableKey(strings),
  mode: Schema.mutableKey(Schema.Literals(["execute", "replay"])),
  package_versions: Schema.mutableKey(
    Schema.Record(Schema.String, Schema.mutableKey(Schema.String))
  ),
  repetitions: Schema.mutableKey(positiveInt),
  requested_model: Schema.mutableKey(nullableString),
  requested_settings: Schema.mutableKey(defaultObject),
  run_id: Schema.mutableKey(Schema.String),
  schema_version: Schema.mutableKey(Schema.Literal(2)),
  seed: Schema.mutableKey(Schema.Int),
  skill_name: Schema.mutableKey(Schema.NonEmptyString),
  skill_version: Schema.mutableKey(nullableString),
  started_at: Schema.mutableKey(Schema.String),
  suite: Schema.mutableKey(Schema.String),
});

export const RunArtifactSchema = Schema.Struct({
  cases: Schema.mutableKey(Schema.mutable(Schema.Array(CaseRecordSchema))),
  manifest: Schema.mutableKey(ManifestSchema),
  results: Schema.mutableKey(
    Schema.mutable(Schema.Array(ResultSchema)).pipe(
      Schema.withDecodingDefaultKey(Effect.sync(() => []))
    )
  ),
});

export type RunArtifact = typeof RunArtifactSchema.Type;
