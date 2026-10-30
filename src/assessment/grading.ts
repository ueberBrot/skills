import { DateTime, Effect, FileSystem, Path, Schema } from "effect";

import packageInfo from "../../package.json";
import { JsonObjectSchema, sampleKey } from "../domain";
import { HarnessError } from "../errors";
import { canonicalJson, readJson, sha256, writeJson } from "../internal/json";
import { loadRun } from "../runs";
import { Writer } from "../writers";
import { makeGrader } from "./grading-call";
import {
  answerPrompt,
  comparisonPrompt,
  decodeAnswers,
  decodeComparison,
  decodeFidelity,
  decodeScores,
  fidelityPrompt,
  scoringPrompt,
} from "./grading-prompts";
import { gradingSummary } from "./grading-summary";
import { acquireGradingOwnership } from "./ownership";

import type { CaseRecord, Condition, JsonObject, Result } from "../domain";
import type { CallResult, Grader } from "./grading-call";
import type {
  Answer,
  ComparisonAssessment,
  ScoredAnswer,
} from "./grading-prompts";

const AnswerKeysSchema = Schema.Struct({
  cases: Schema.Record(
    Schema.String,
    Schema.Struct({
      questions: Schema.Array(
        Schema.Struct({
          question: Schema.NonEmptyString,
          reference_answer: Schema.NonEmptyString,
        })
      ),
    })
  ),
  scoring: JsonObjectSchema,
});

const GradingIdentitySchema = Schema.Struct({
  answer_keys_hash: Schema.NullOr(Schema.String),
  executor: Schema.Json,
  requested_model: Schema.String,
  requested_settings: JsonObjectSchema,
  run_hash: Schema.String,
});

type AnswerKeys = typeof AnswerKeysSchema.Type;

export interface GradingOptions {
  readonly run: string;
  readonly out: string;
  readonly model: string;
  readonly settings: JsonObject;
  readonly concurrency: number;
  readonly timeout: number;
  readonly answerKeys?: string;
  readonly resume?: boolean;
}

interface AssessedSample {
  readonly result: Result;
  readonly record: CaseRecord;
}

interface Pair {
  readonly a: AssessedSample;
  readonly b: AssessedSample;
  readonly record: CaseRecord;
  readonly repetition: number;
}

const assessSample = Effect.fn("assessSample")(function* assessSample(
  grader: Grader,
  keys: AnswerKeys | null,
  { record, result }: AssessedSample
) {
  const identity = {
    case_id: result.case_id,
    conditions: [result.condition],
    repetition: result.repetition,
  };

  const output = result.output ?? "";

  const fidelity = yield* grader.execute(
    { ...identity, task: "fidelity" },
    fidelityPrompt(record, output),
    (text) => decodeFidelity(text, record)
  );

  let answers: CallResult<readonly Answer[]> | null = null;
  let scores: CallResult<readonly ScoredAnswer[]> | null = null;

  if (keys !== null && record.spec.reader_questions.length > 0) {
    answers = yield* grader.execute(
      { ...identity, task: "answer" },
      answerPrompt(output, record.spec.reader_questions),
      (text) => decodeAnswers(text, record.spec.reader_questions)
    );

    if (answers.status === "success") {
      const reference = keys.cases[result.case_id];

      const answered = answers.data.map((answer, index) => ({
        ...answer,
        reference_answer: reference?.questions[index]?.reference_answer ?? "",
      }));

      scores = yield* grader.execute(
        { ...identity, task: "score" },
        scoringPrompt(answered, keys.scoring, output),
        (text) => decodeScores(text, answered)
      );
    }
  }

  return {
    answers,
    case_id: result.case_id,
    condition: result.condition,
    fidelity,
    language: result.language,
    questions_expected: record.spec.reader_questions.length,
    repetition: result.repetition,
    scores,
    split: result.split,
    task: result.task,
  };
});

const winner = (
  judgment: CallResult<ComparisonAssessment>,
  order: readonly string[]
): string => {
  if (judgment.status === "error") {
    return "inconclusive";
  }

  if (judgment.data.preference === "A") {
    return order[0] ?? "inconclusive";
  }

  if (judgment.data.preference === "B") {
    return order[1] ?? "inconclusive";
  }

  return judgment.data.preference;
};

const comparePair = Effect.fn("comparePair")(function* comparePair(
  grader: Grader,
  { a, b, record, repetition }: Pair
) {
  const conditions = [a.result.condition, b.result.condition];

  const identity = {
    case_id: record.fixture.id,
    repetition,
    task: "comparison" as const,
  };

  const forward = yield* grader.execute(
    { ...identity, conditions },
    comparisonPrompt(record, a.result.output ?? "", b.result.output ?? ""),
    decodeComparison
  );

  const reverse = yield* grader.execute(
    { ...identity, conditions: conditions.toReversed() },
    comparisonPrompt(record, b.result.output ?? "", a.result.output ?? ""),
    decodeComparison
  );

  const normal = winner(forward, conditions);
  const flipped = winner(reverse, conditions.toReversed());

  return {
    case_id: record.fixture.id,
    conditions,
    forward,
    language: record.spec.language,
    preference: normal === flipped ? normal : "inconclusive",
    repetition,
    reverse,
    split: record.spec.split,
    task: record.spec.task,
  };
});

const samplePairs = (
  samples: readonly AssessedSample[],
  records: Iterable<CaseRecord>,
  conditions: readonly Condition[],
  repetitions: number
): Pair[] => {
  const bySample = new Map(
    samples.map((item) => [
      sampleKey(
        item.result.case_id,
        item.result.repetition,
        item.result.condition
      ),
      item,
    ])
  );

  const pairs: Pair[] = [];

  const conditionsToCompare = conditions.flatMap((first, index) =>
    conditions.slice(index + 1).map((second) => [first, second] as const)
  );

  for (const record of records) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      for (const [first, second] of conditionsToCompare) {
        const a = bySample.get(sampleKey(record.fixture.id, repetition, first));

        const b = bySample.get(
          sampleKey(record.fixture.id, repetition, second)
        );

        if (a !== undefined && b !== undefined) {
          pairs.push({ a, b, record, repetition });
        }
      }
    }
  }

  return pairs;
};

export const gradeRun = Effect.fn("gradeRun")(function* gradeRun(
  options: GradingOptions
) {
  yield* Schema.decodeEffect(
    Schema.Struct({
      concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
      model: Schema.NonEmptyString,
      timeout: Schema.Finite.check(Schema.isGreaterThan(0)),
    })
  )(options);

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writer = yield* Writer;
  const loaded = yield* loadRun(options.run);
  const { artifact, cases } = loaded.view;
  const output = path.resolve(options.out);

  const rawKeys =
    options.answerKeys === undefined
      ? null
      : yield* fs.readFileString(options.answerKeys);

  const keys =
    rawKeys === null
      ? null
      : yield* Schema.decodeEffect(Schema.fromJsonString(AnswerKeysSchema))(
          rawKeys
        );

  for (const record of cases.values()) {
    if (
      keys !== null &&
      canonicalJson(
        keys.cases[record.fixture.id]?.questions.map((item) => item.question) ??
          []
      ) !== canonicalJson(record.spec.reader_questions)
    ) {
      return yield* new HarnessError({
        message: `Answer keys do not match run questions for ${record.fixture.id}`,
      });
    }
  }

  yield* writer.validate({ model: options.model, settings: options.settings });

  const identity = {
    answer_keys_hash: rawKeys === null ? null : sha256(rawKeys),
    executor: yield* Schema.decodeUnknownEffect(Schema.Json)(writer.descriptor),
    requested_model: options.model,
    requested_settings: options.settings,
    run_hash: sha256(canonicalJson(artifact)),
  };

  const manifestPath = path.join(output, "manifest.json");

  const previous =
    options.resume === true ? yield* readJson(manifestPath) : null;

  if (previous === null) {
    yield* fs.makeDirectory(path.dirname(output), { recursive: true });
    yield* fs.makeDirectory(output, { mode: 0o700 }).pipe(
      Effect.mapError(
        () =>
          new HarnessError({
            message: `Refusing to overwrite grading directory: ${output}`,
          })
      )
    );
    yield* fs.makeDirectory(path.join(output, "calls"), { mode: 0o700 });
  } else {
    const prior = yield* Schema.decodeUnknownEffect(GradingIdentitySchema)(
      previous
    );

    if (canonicalJson(prior) !== canonicalJson(identity)) {
      return yield* new HarnessError({
        message:
          "Cannot resume grading with different run, answer keys, model, settings, or executor",
      });
    }
  }

  yield* acquireGradingOwnership(output);

  const grader = yield* makeGrader({ ...options, out: output });

  const graderFileHashes: Record<string, string> = {};

  for (const file of [
    "grading.ts",
    "grading-call.ts",
    "grading-prompts.ts",
    "grading-summary.ts",
    "ownership.ts",
  ]) {
    graderFileHashes[file] = sha256(
      yield* fs.readFile(Bun.fileURLToPath(new URL(file, import.meta.url)))
    );
  }

  const manifest = {
    ...identity,
    completed_at: null,
    concurrency: options.concurrency,
    grader_file_hashes: graderFileHashes,
    kind: "model",
    package_versions: { ...packageInfo.dependencies, bun: Bun.version },
    resumed_from: previous,
    run_id: artifact.manifest.run_id,
    schema_version: 1,
    started_at: DateTime.formatIso(yield* DateTime.now),
    timeout_seconds: options.timeout,
  };

  yield* writeJson(
    manifestPath,
    yield* Schema.decodeUnknownEffect(Schema.Json)(manifest)
  );

  const successful: AssessedSample[] = artifact.results.flatMap((result) => {
    const record = cases.get(result.case_id);

    return result.status === "success" &&
      result.output !== null &&
      record !== undefined
      ? [{ record, result }]
      : [];
  });

  const samples = yield* Effect.all(
    successful.map((item) => assessSample(grader, keys, item)),
    { concurrency: options.concurrency }
  );

  const pairs = samplePairs(
    successful,
    cases.values(),
    artifact.manifest.conditions,
    artifact.manifest.repetitions
  );

  const comparisons = yield* Effect.all(
    pairs.map((pair) => comparePair(grader, pair)),
    { concurrency: options.concurrency }
  );

  const summary = {
    ...gradingSummary(samples, comparisons, grader.calls),
    generation_samples_expected:
      cases.size *
      artifact.manifest.conditions.length *
      artifact.manifest.repetitions,
    generation_samples_graded: samples.length,
    generation_samples_not_graded:
      cases.size *
        artifact.manifest.conditions.length *
        artifact.manifest.repetitions -
      samples.length,
  };

  const completedManifest = {
    ...manifest,
    completed_at: DateTime.formatIso(yield* DateTime.now),
  };

  const grading = {
    calls: grader.calls.toSorted((a, b) => a.id - b.id),
    comparisons,
    manifest: completedManifest,
    samples,
    summary,
  };

  yield* writeJson(
    path.join(output, "grading.json"),
    yield* Schema.decodeUnknownEffect(Schema.Json)(grading)
  );
  yield* writeJson(
    manifestPath,
    yield* Schema.decodeUnknownEffect(Schema.Json)(completedManifest)
  );
  yield* writeJson(path.join(output, "summary.json"), summary);

  return {
    exitCode: grader.calls.some((call) => call.status === "error") ? 1 : 0,
    summary: { ...summary, assessment: output },
  };
}, Effect.scoped);
