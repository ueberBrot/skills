import { Effect, Schema } from "effect";

import { ConditionSchema, JsonObjectSchema, sampleKey } from "../domain";
import { HarnessError } from "../errors";
import { canonicalJson, sha256, shuffle } from "../internal/json";

import type { CaseRecord, Condition, Result, RunArtifact } from "../domain";
import type { RunView } from "../runs";

const SkippedSchema = Schema.Struct({
  case_id: Schema.mutableKey(Schema.String),
  reason: Schema.mutableKey(
    Schema.Literals([
      "fewer_than_two_conditions",
      "missing_or_failed_condition",
    ])
  ),
  repetition: Schema.mutableKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

type Skipped = typeof SkippedSchema.Type;

const LabelMappingSchema = Schema.Struct({
  condition: Schema.mutableKey(ConditionSchema),
});

const TrialMappingSchema = Schema.Struct({
  case_id: Schema.mutableKey(Schema.String),
  labels: Schema.mutableKey(
    Schema.Record(Schema.String, Schema.mutableKey(LabelMappingSchema))
  ),
  repetition: Schema.mutableKey(Schema.Int.check(Schema.isGreaterThan(0))),
  trial_id: Schema.mutableKey(Schema.String),
});

const ComprehensionMappingSchema = Schema.Struct({
  item_id: Schema.mutableKey(Schema.String),
  label: Schema.mutableKey(Schema.String),
  trial_id: Schema.mutableKey(Schema.String),
});

export const DecodingSchema = Schema.Struct({
  comprehension: Schema.mutableKey(
    Schema.mutable(Schema.Array(ComprehensionMappingSchema))
  ),
  conditions: Schema.mutableKey(
    Schema.optionalKey(Schema.mutable(Schema.Array(ConditionSchema)))
  ),
  review_id: Schema.mutableKey(Schema.String),
  run_hash: Schema.mutableKey(Schema.String),
  run_id: Schema.mutableKey(Schema.String),
  schema_version: Schema.mutableKey(Schema.Literal(2)),
  seed: Schema.mutableKey(Schema.Int),
  skipped: Schema.mutableKey(Schema.mutable(Schema.Array(SkippedSchema))),
  trials: Schema.mutableKey(Schema.mutable(Schema.Array(TrialMappingSchema))),
});

export type Decoding = typeof DecodingSchema.Type;

const FidelityJudgmentSchema = Schema.Struct({
  passed: Schema.mutableKey(Schema.NullOr(Schema.Boolean)),
  reason: Schema.mutableKey(Schema.String),
});

const TrialJudgmentSchema = Schema.Struct({
  fidelity: Schema.mutableKey(
    Schema.Record(Schema.String, Schema.mutableKey(FidelityJudgmentSchema))
  ),
  preference: Schema.mutableKey(Schema.NullOr(Schema.String)),
  preference_reason: Schema.mutableKey(Schema.String),
  trial_id: Schema.mutableKey(Schema.String),
});

const AssessorSchema = Schema.Struct({
  executor_name: Schema.NonEmptyString,
  kind: Schema.Literal("model"),
  reported_model: Schema.NullOr(Schema.NonEmptyString),
  reported_settings: Schema.NullOr(JsonObjectSchema),
  requested_model: Schema.NullOr(Schema.NonEmptyString),
  requested_settings: JsonObjectSchema,
});

export const JudgmentsSchema = Schema.Struct({
  assessor: Schema.mutableKey(
    Schema.optionalKey(Schema.NullOr(AssessorSchema))
  ),
  review_id: Schema.mutableKey(Schema.String),
  trials: Schema.mutableKey(Schema.mutable(Schema.Array(TrialJudgmentSchema))),
});

export type Judgments = typeof JudgmentsSchema.Type;

const ReaderQuestionSchema = Schema.Struct({
  answer: Schema.mutableKey(Schema.NullOr(Schema.String)),
  question: Schema.mutableKey(Schema.String),
});

const ComprehensionItemSchema = Schema.Struct({
  item_id: Schema.mutableKey(Schema.String),
  output: Schema.mutableKey(Schema.String),
  questions: Schema.mutableKey(
    Schema.mutable(Schema.Array(ReaderQuestionSchema))
  ),
});

export const ComprehensionPacketSchema = Schema.Struct({
  items: Schema.mutableKey(
    Schema.mutable(Schema.Array(ComprehensionItemSchema))
  ),
  review_id: Schema.mutableKey(Schema.String),
});

export type ComprehensionPacket = typeof ComprehensionPacketSchema.Type;

const runHash = (run: RunArtifact): string => sha256(canonicalJson(run));

interface PairedGroup {
  record: CaseRecord;
  repetition: number;
  results: Result[];
}

export const pairedGroups = (
  view: RunView,
  conditions: readonly Condition[] = view.artifact.manifest.conditions
) => {
  const { artifact: run, cases, results } = view;
  const complete: PairedGroup[] = [];
  const skipped: Skipped[] = [];

  for (const record of cases.values()) {
    for (
      let repetition = 1;
      repetition <= run.manifest.repetitions;
      repetition += 1
    ) {
      const group = conditions.map((condition) =>
        results.get(sampleKey(record.fixture.id, repetition, condition))
      );

      if (
        group.length < 2 ||
        group.some((result) => !result || result.status !== "success")
      ) {
        skipped.push({
          case_id: record.fixture.id,
          reason:
            group.length < 2
              ? "fewer_than_two_conditions"
              : "missing_or_failed_condition",
          repetition,
        });
      } else {
        complete.push({
          record,
          repetition,
          results: group.filter(
            (result): result is Result => result !== undefined
          ),
        });
      }
    }
  }

  return { complete, skipped };
};

const ComparisonSchema = Schema.Struct({
  checks: Schema.Array(Schema.String),
  input: Schema.mutableKey(Schema.optionalKey(Schema.Json)),
  outputs: Schema.Record(Schema.String, Schema.String),
  request: Schema.String,
  source: Schema.String,
  trial_id: Schema.String,
});

interface LabeledOutput {
  label: string;
  output: string;
  result: Result;
}

export const planReview = Effect.fn("planReview")(function* planReview(
  view: RunView,
  seed: number,
  conditions?: readonly Condition[]
) {
  const run = view.artifact;

  if (!Number.isInteger(seed)) {
    return yield* new HarnessError({
      message: "Review seed must be an integer",
    });
  }

  if (
    conditions !== undefined &&
    (conditions.length !== 2 ||
      new Set(conditions).size !== 2 ||
      conditions.some(
        (condition) => !run.manifest.conditions.includes(condition)
      ))
  ) {
    return yield* new HarnessError({
      message:
        "Review conditions must select exactly two distinct run conditions",
    });
  }

  const selected =
    conditions === undefined
      ? run.manifest.conditions
      : run.manifest.conditions.filter((condition) =>
          conditions.includes(condition)
        );

  const { complete, skipped } = pairedGroups(view, selected);

  const hash = runHash(run);

  const selection =
    conditions === undefined ? "" : `:${canonicalJson(selected)}`;

  const reviewId = sha256(`${hash}:${seed}${selection}`).slice(0, 20);
  const comparisons: (typeof ComparisonSchema.Type)[] = [];
  const judgments: Judgments["trials"] = [];
  const trials: Decoding["trials"] = [];
  const readerItems: ComprehensionPacket["items"] = [];
  const readerMapping: Decoding["comprehension"] = [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const orderedGroups = yield* shuffle(complete, `${seed}:trials`);

  for (const [index, group] of orderedGroups.entries()) {
    const trialId = `T${String(index + 1).padStart(4, "0")}`;

    const orderedResults = yield* shuffle(
      group.results,
      `${seed}:${group.record.fixture.id}:${group.repetition}:labels`
    );

    const labeled: LabeledOutput[] = [];

    for (const [labelIndex, result] of orderedResults.entries()) {
      const output = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        result.output
      );

      labeled.push({ label: letters.charAt(labelIndex), output, result });
    }

    const comparison: typeof ComparisonSchema.Type = {
      checks: [...group.record.checks],
      outputs: Object.fromEntries(
        labeled.map(({ label, output }) => [label, output])
      ),
      request: group.record.fixture.request,
      source: group.record.fixture.source,
      trial_id: trialId,
    };

    if (group.record.fixture.input !== undefined) {
      comparison.input = group.record.fixture.input;
    }

    comparisons.push(comparison);
    judgments.push({
      fidelity: Object.fromEntries(
        labeled.map(({ label }) => [label, { passed: null, reason: "" }])
      ),
      preference: null,
      preference_reason: "",
      trial_id: trialId,
    });
    trials.push({
      case_id: group.record.fixture.id,
      labels: Object.fromEntries(
        labeled.map(({ label, result }) => [
          label,
          { condition: result.condition },
        ])
      ),
      repetition: group.repetition,
      trial_id: trialId,
    });

    for (const { label, output } of labeled) {
      const itemId = `R${String(readerItems.length + 1).padStart(4, "0")}`;
      readerItems.push({
        item_id: itemId,
        output,
        questions: group.record.spec.reader_questions.map((question) => ({
          answer: null,
          question,
        })),
      });
      readerMapping.push({ item_id: itemId, label, trial_id: trialId });
    }
  }

  const mapping: Decoding = {
    comprehension: readerMapping,
    review_id: reviewId,
    run_hash: hash,
    run_id: run.manifest.run_id,
    schema_version: 2,
    seed,
    skipped,
    trials,
  };

  if (conditions !== undefined) {
    mapping.conditions = [...selected];
  }

  const decoding = yield* Schema.decodeEffect(DecodingSchema)(mapping);

  return {
    comparisons: { review_id: reviewId, trials: comparisons },
    comprehension: {
      items: yield* shuffle(readerItems, `${seed}:readers`),
      review_id: reviewId,
    },
    decoding,
    judgments: { review_id: reviewId, trials: judgments },
  };
});
