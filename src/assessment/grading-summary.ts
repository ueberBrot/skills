import type { JsonObject } from "../domain";
import type { FidelityAssessment, ScoredAnswer } from "./grading-prompts";

type Assessment<A> =
  | { readonly data: A; readonly status: "success" }
  | { readonly status: "error" };

interface GradedSample {
  readonly condition: string;
  readonly fidelity: Assessment<FidelityAssessment>;
  readonly language: string;
  readonly questions_expected: number;
  readonly scores: Assessment<readonly ScoredAnswer[]> | null;
  readonly split: string;
  readonly task: string;
}

interface GradedComparison {
  readonly conditions: readonly string[];
  readonly forward: { readonly status: "success" | "error" };
  readonly language: string;
  readonly preference: string;
  readonly reverse: { readonly status: "success" | "error" };
  readonly split: string;
  readonly task: string;
}

const sampleGroup = (sample: GradedSample) => ({
  answerability_correct: 0,
  answerability_incorrect: 0,
  answerability_not_applicable: 0,
  answerability_not_scored: 0,
  answerability_partial: 0,
  answerability_questions_expected: 0,
  answerability_questions_not_scored: 0,
  answerability_questions_scored: 0,
  answerability_unanswerable: 0,
  condition: sample.condition,
  eval_feedback: 0,
  expectations_checked: 0,
  expectations_failed: 0,
  expectations_passed: 0,
  fidelity_assessed: 0,
  fidelity_errors: 0,
  fidelity_failed: 0,
  fidelity_passed: 0,
  language: sample.language,
  samples: 0,
  split: sample.split,
  task: sample.task,
  unsupported_claims: 0,
});

type SampleGroup = ReturnType<typeof sampleGroup>;

const countFidelity = (
  group: SampleGroup,
  fidelity: Assessment<FidelityAssessment>
): void => {
  if (fidelity.status === "error") {
    group.fidelity_errors += 1;

    return;
  }

  const { expectations, unsupported_claims, eval_feedback } = fidelity.data;

  const passed = expectations.filter(
    (expectation) => expectation.passed
  ).length;

  const failed = expectations.length - passed;

  group.fidelity_assessed += 1;
  group.expectations_checked += expectations.length;
  group.expectations_passed += passed;
  group.expectations_failed += failed;
  group.unsupported_claims += unsupported_claims.length;
  group.eval_feedback += eval_feedback.length;

  if (failed > 0 || unsupported_claims.length > 0) {
    group.fidelity_failed += 1;
  } else {
    group.fidelity_passed += 1;
  }
};

const countAnswerability = (group: SampleGroup, sample: GradedSample): void => {
  group.answerability_questions_expected += sample.questions_expected;

  if (sample.questions_expected === 0) {
    group.answerability_not_applicable += 1;

    return;
  }

  if (sample.scores === null || sample.scores.status === "error") {
    group.answerability_not_scored += 1;
    group.answerability_questions_not_scored += sample.questions_expected;

    return;
  }

  group.answerability_questions_scored += sample.scores.data.length;
  group.answerability_questions_not_scored += Math.max(
    0,
    sample.questions_expected - sample.scores.data.length
  );

  for (const answer of sample.scores.data) {
    group[`answerability_${answer.score}`] += 1;
  }
};

const comparisonGroup = (comparison: GradedComparison) => ({
  comparisons: 0,
  conditions: [...comparison.conditions],
  error_pairs: 0,
  inconclusive: 0,
  language: comparison.language,
  losses: Object.fromEntries(
    comparison.conditions.map((condition) => [condition, 0])
  ),
  split: comparison.split,
  task: comparison.task,
  ties: 0,
  wins: Object.fromEntries(
    comparison.conditions.map((condition) => [condition, 0])
  ),
});

type ComparisonGroup = ReturnType<typeof comparisonGroup>;

const countComparison = (
  group: ComparisonGroup,
  comparison: GradedComparison
): void => {
  group.comparisons += 1;

  if (
    comparison.forward.status === "error" ||
    comparison.reverse.status === "error"
  ) {
    group.error_pairs += 1;
  }

  if (comparison.preference === "tie") {
    group.ties += 1;

    return;
  }

  if (!comparison.conditions.includes(comparison.preference)) {
    group.inconclusive += 1;

    return;
  }

  for (const condition of comparison.conditions) {
    const counts =
      condition === comparison.preference ? group.wins : group.losses;

    counts[condition] = (counts[condition] ?? 0) + 1;
  }
};

export const gradingSummary = (
  samples: readonly GradedSample[],
  comparisons: readonly GradedComparison[],
  calls: readonly { readonly status: "success" | "error" }[]
): JsonObject => {
  const groups = new Map<string, SampleGroup>();

  for (const sample of samples) {
    const key = JSON.stringify([
      sample.condition,
      sample.language,
      sample.task,
      sample.split,
    ]);

    const group = groups.get(key) ?? sampleGroup(sample);
    groups.set(key, group);
    group.samples += 1;
    countFidelity(group, sample.fidelity);
    countAnswerability(group, sample);
  }

  const pairs = new Map<string, ComparisonGroup>();

  for (const comparison of comparisons) {
    const key = JSON.stringify([
      comparison.conditions,
      comparison.language,
      comparison.task,
      comparison.split,
    ]);

    const group = pairs.get(key) ?? comparisonGroup(comparison);
    pairs.set(key, group);
    countComparison(group, comparison);
  }

  return {
    calls: calls.length,
    comparisons: comparisons.length,
    grading_errors: calls.filter((call) => call.status === "error").length,
    groups: [...groups.values()],
    kind: "model",
    pairs: [...pairs.values()],
    samples: samples.length,
  };
};
