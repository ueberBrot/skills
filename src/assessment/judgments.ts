import { Effect, FileSystem, Path, Predicate, Schema } from "effect";

import { comparisonKey, sampleKey } from "../domain";
import { HarnessError } from "../errors";
import { canonicalJson, defined, readJson } from "../internal/json";
import {
  ComprehensionPacketSchema,
  DecodingSchema,
  JudgmentsSchema,
  planReview,
} from "./plan";

import type { Condition } from "../domain";
import type { RunView } from "../runs";
import type { ComprehensionPacket, Decoding, Judgments } from "./plan";

export const ReviewInputSchema = Schema.Struct({
  decoding: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
});

export type ReviewInput = typeof ReviewInputSchema.Type;

const exists = Effect.fnUntraced(function* exists(target: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.lstat(target).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false))
  );
});

const loadReviewFiles = Effect.fn("loadReviewFiles")(function* loadReviewFiles(
  review: ReviewInput
) {
  const { path: reviewPath, decoding: decodingPath } =
    yield* Schema.decodeEffect(ReviewInputSchema)(review, {
      onExcessProperty: "error",
    });

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const decoding = yield* Schema.decodeUnknownEffect(DecodingSchema)(
    yield* readJson(decodingPath),
    { onExcessProperty: "error" }
  );

  const reviewStat = yield* fs.stat(reviewPath);

  const judgmentPath =
    reviewStat.type === "Directory"
      ? path.join(reviewPath, "judgments.json")
      : reviewPath;

  const judgments = yield* Schema.decodeUnknownEffect(JudgmentsSchema)(
    yield* readJson(judgmentPath),
    { onExcessProperty: "error" }
  );

  const readerPath = path.join(
    path.dirname(judgmentPath),
    "comprehension.json"
  );

  let comprehension: ComprehensionPacket | null = null;
  const inputs = [decodingPath, judgmentPath];

  if (yield* exists(readerPath)) {
    inputs.push(readerPath);
    comprehension = yield* Schema.decodeUnknownEffect(
      ComprehensionPacketSchema
    )(yield* readJson(readerPath), { onExcessProperty: "error" });
  }

  return { comprehension, decoding, inputs, judgments };
});

const conditionForLabel = (
  trial: Decoding["trials"][number],
  label: string
): Condition => {
  const mapping = trial.labels[label];

  if (mapping === undefined) {
    throw new Error("Unknown review label");
  }

  return mapping.condition;
};

const validateDecoding = Effect.fn("validateDecoding")(
  function* validateDecoding(view: RunView, decoding: Decoding) {
    const expected = (yield* planReview(
      view,
      decoding.seed,
      decoding.conditions
    )).decoding;

    if (
      decoding.run_id !== expected.run_id ||
      decoding.run_hash !== expected.run_hash
    ) {
      return yield* new HarnessError({
        message: "Private decoding does not match this run",
      });
    }

    if (canonicalJson(decoding) !== canonicalJson(expected)) {
      return yield* new HarnessError({
        message: "Private decoding mapping was altered or is incomplete",
      });
    }

    return decoding;
  }
);

const sameMembers = (
  actual: Iterable<string>,
  expected: Iterable<string>
): boolean =>
  canonicalJson([...actual].toSorted()) ===
  canonicalJson([...expected].toSorted());

const validateComprehension = (
  view: RunView,
  decoding: Decoding,
  comprehension: ComprehensionPacket
) => {
  if (comprehension.review_id !== decoding.review_id) {
    throw new Error("Comprehension packet has a different review ID");
  }

  const expectedReader = new Map(
    decoding.comprehension.map((item) => [item.item_id, item])
  );

  if (
    new Set(comprehension.items.map((item) => item.item_id)).size !==
      comprehension.items.length ||
    !sameMembers(
      comprehension.items.map((item) => item.item_id),
      expectedReader.keys()
    )
  ) {
    throw new Error(
      "Comprehension contains duplicate, unknown, or missing items"
    );
  }

  const mappings = new Map(
    decoding.trials.map((trial) => [trial.trial_id, trial])
  );

  const { cases, results } = view;

  for (const item of comprehension.items) {
    const mapping = defined(expectedReader.get(item.item_id));
    const trial = defined(mappings.get(mapping.trial_id));
    const condition = conditionForLabel(trial, mapping.label);
    const record = defined(cases.get(trial.case_id));

    const result = defined(
      results.get(sampleKey(trial.case_id, trial.repetition, condition))
    );

    if (
      item.output !== result.output ||
      canonicalJson(item.questions.map((question) => question.question)) !==
        canonicalJson(record.spec.reader_questions)
    ) {
      throw new Error("Comprehension content differs from the exported trial");
    }
  }

  return comprehension;
};

const validateTrial = (
  judgment: Judgments["trials"][number],
  trial: Decoding["trials"][number]
): void => {
  if (!sameMembers(Object.keys(judgment.fidelity), Object.keys(trial.labels))) {
    throw new Error("Judgment fidelity labels are unknown or missing");
  }

  if (
    judgment.preference !== null &&
    judgment.preference !== "tie" &&
    !Object.hasOwn(trial.labels, judgment.preference)
  ) {
    throw new Error("Unknown preference label");
  }

  if (judgment.preference !== null && !judgment.preference_reason.trim()) {
    throw new Error("A preference judgment requires a reason");
  }

  if (
    Object.values(judgment.fidelity).some(
      (value) => value.passed !== null && !value.reason.trim()
    )
  ) {
    throw new Error("A fidelity judgment requires a reason");
  }
};

const acceptJudgments = (decoding: Decoding, judgments: Judgments) => {
  if (judgments.review_id !== decoding.review_id) {
    throw new Error("Different review IDs in judgments and decoding");
  }

  const mappings = new Map(
    decoding.trials.map((trial) => [trial.trial_id, trial])
  );

  if (
    new Set(judgments.trials.map((trial) => trial.trial_id)).size !==
      judgments.trials.length ||
    !sameMembers(
      judgments.trials.map((trial) => trial.trial_id),
      mappings.keys()
    )
  ) {
    throw new Error("Judgments contain duplicate, unknown, or missing trials");
  }

  for (const judgment of judgments.trials) {
    validateTrial(judgment, defined(mappings.get(judgment.trial_id)));
  }

  const fidelity = new Map<string, boolean | null>();
  const preferences = new Map<string, Condition | "tie" | null>();

  for (const judgment of judgments.trials) {
    const trial = defined(mappings.get(judgment.trial_id));

    for (const [label, value] of Object.entries(judgment.fidelity)) {
      fidelity.set(
        sampleKey(
          trial.case_id,
          trial.repetition,
          conditionForLabel(trial, label)
        ),
        value.passed
      );
    }

    preferences.set(
      comparisonKey(trial.case_id, trial.repetition),
      judgment.preference === null || judgment.preference === "tie"
        ? judgment.preference
        : conditionForLabel(trial, judgment.preference)
    );
  }

  return { fidelity, preferences };
};

export const loadJudgments = Effect.fn("loadJudgments")(function* loadJudgments(
  view: RunView,
  review: ReviewInput
) {
  const { comprehension, decoding, inputs, judgments } =
    yield* loadReviewFiles(review);

  yield* validateDecoding(view, decoding);

  const accepted = yield* Effect.try({
    catch: (error) =>
      new HarnessError({
        message: Predicate.isError(error) ? error.message : String(error),
      }),
    try: () => {
      const result = acceptJudgments(decoding, judgments);

      if (comprehension !== null) {
        validateComprehension(view, decoding, comprehension);
      }

      return result;
    },
  });

  const comprehensionAnswered =
    comprehension?.items.reduce(
      (total, item) =>
        total +
        item.questions.filter((question) => Boolean(question.answer?.trim()))
          .length,
      0
    ) ?? 0;

  return {
    assessor: judgments.assessor ?? null,
    comprehensionAnswered,
    conditions: decoding.conditions ?? view.artifact.manifest.conditions,
    ...accepted,
    inputs,
  };
});
