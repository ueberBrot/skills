import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import { forEach as traverse } from "effect/Effect";

import { FixtureSchema, SuiteSpecSchema } from "../domain";
import { HarnessError } from "../errors";
import { assessWriting } from "../evaluation";
import { defined, sha256 } from "../internal/json";
import { REPO } from "../paths";
import { discoverSkills, parseSkill, selectSuite } from "../skills";
import { preparePrompts } from "./prompts";

import type { CaseRecord, Condition, JsonValue, Split } from "../domain";
import type { WritingAssessment, WritingPlatform } from "../evaluation";
import type { SkillEntry, SuiteSelection } from "../skills";

export interface LoadedSuite {
  readonly name: string;
  readonly cases: readonly CaseRecord[];
  readonly provenance: Readonly<Record<string, string>>;
  readonly skillName: string;
  readonly promptFor: (caseId: string, condition: Condition) => string;
  readonly assess: (
    caseId: string,
    output: string
  ) => Effect.Effect<WritingAssessment | null, HarnessError>;
}

const freezeInput = (value: JsonValue): void => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return;
  }

  for (const child of Object.values(value)) {
    freezeInput(child);
  }

  Object.freeze(value);
};

const within = (path: Path.Path, root: string, target: string): boolean => {
  const difference = path.relative(root, target);

  return (
    difference !== ".." &&
    !difference.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(difference)
  );
};

/** Resolve on disk before testing containment, including symlink targets. */
const skillReference = Effect.fn("skillReference")(function* skillReference(
  skill: string,
  reference: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (
    !reference.startsWith("references/") ||
    path.extname(reference) !== ".md" ||
    reference.split(/[\\/]/u).includes("..")
  ) {
    return yield* new HarnessError({
      message: `Expected an in-skill Markdown writing reference: ${reference}`,
    });
  }

  const lexicalPath = path.resolve(skill, reference);

  const actualPath = yield* fs.realPath(lexicalPath).pipe(
    Effect.mapError(
      () =>
        new HarnessError({
          message: `Missing writing reference: ${reference}`,
        })
    )
  );

  const information = yield* fs.stat(actualPath).pipe(
    Effect.mapError(
      () =>
        new HarnessError({
          message: `Missing writing reference: ${reference}`,
        })
    )
  );

  if (information.type !== "File") {
    return yield* new HarnessError({
      message: `Missing writing reference: ${reference}`,
    });
  }

  if (!within(path, skill, actualPath)) {
    return yield* new HarnessError({
      message: `Writing reference escapes the skill: ${reference}`,
    });
  }

  return lexicalPath;
});

export const loadSuite = Effect.fn("loadSuite")(function* loadSuite(
  suiteFile: string,
  split?: Split,
  expectedSkill?: SkillEntry
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const suitePath = yield* fs.realPath(suiteFile);
  const suiteBytes = yield* fs.readFile(suitePath);
  const files = new Map([[suitePath, suiteBytes]]);
  const decoder = new TextDecoder();

  const spec = yield* Schema.decodeEffect(
    Schema.fromJsonString(SuiteSpecSchema),
    { onExcessProperty: "error" }
  )(decoder.decode(suiteBytes));

  const root = path.dirname(suitePath);

  const [fixturesPath, checksPath, shortPath, skill] = yield* Effect.all(
    [
      fs.realPath(path.resolve(root, spec.fixtures)),
      fs.realPath(path.resolve(root, spec.checks)),
      fs.realPath(path.resolve(root, spec.short_prompt)),
      fs.realPath(path.resolve(root, spec.skill)),
    ],
    { concurrency: "unbounded" }
  );

  const skillEntry = path.join(skill, "SKILL.md");

  if (expectedSkill !== undefined && skill !== expectedSkill.directory) {
    return yield* new HarnessError({
      message: `Evaluation suite for ${expectedSkill.name} selects a different skill directory`,
    });
  }

  if (!within(path, skill, yield* fs.realPath(skillEntry))) {
    return yield* new HarnessError({
      message: "SKILL.md escapes the skill directory",
    });
  }

  const referenceFiles = yield* traverse(
    new Set(spec.cases.flatMap((item) => item.references)),
    (reference) => skillReference(skill, reference),
    { concurrency: "unbounded" }
  );

  const anchorHelper =
    spec.anchor_helper === undefined
      ? null
      : yield* fs.realPath(path.resolve(root, spec.anchor_helper));

  if (anchorHelper !== null && (yield* fs.stat(anchorHelper)).type !== "File") {
    return yield* new HarnessError({
      message: "The anchor helper must be a file",
    });
  }

  yield* traverse(
    new Set([
      fixturesPath,
      checksPath,
      shortPath,
      skillEntry,
      ...referenceFiles,
      ...(anchorHelper === null ? [] : [anchorHelper]),
    ]),
    Effect.fnUntraced(function* readSnapshot(file) {
      if (!files.has(file)) {
        files.set(file, yield* fs.readFile(file));
      }
    }),
    { concurrency: "unbounded" }
  );

  const fixtures = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(FixtureSchema)),
    { onExcessProperty: "error" }
  )(decoder.decode(defined(files.get(fixturesPath))));

  const checks = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Record(Schema.String, Schema.Array(Schema.String))
    ),
    { onExcessProperty: "error" }
  )(decoder.decode(defined(files.get(checksPath))));

  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

  if (byId.size !== fixtures.length) {
    return yield* new HarnessError({ message: "Duplicate fixture IDs" });
  }

  if (new Set(spec.cases.map((item) => item.id)).size !== spec.cases.length) {
    return yield* new HarnessError({ message: "Duplicate suite case IDs" });
  }

  const shortPrompt = decoder.decode(defined(files.get(shortPath)));

  if (!shortPrompt.trim()) {
    return yield* new HarnessError({
      message: "The short-prompt control is empty",
    });
  }

  const allRecords = yield* traverse(
    spec.cases,
    Effect.fn(function* loadRecord(item) {
      const fixture = byId.get(item.id);
      const reviewerChecks = checks[item.id];

      if (fixture === undefined || reviewerChecks === undefined) {
        return yield* new HarnessError({
          message: `Missing fixture or reviewer checks for ${item.id}`,
        });
      }

      if (
        reviewerChecks.length === 0 ||
        reviewerChecks.some((check) => !check.trim())
      ) {
        return yield* new HarnessError({
          message: `Empty reviewer checks for ${item.id}`,
        });
      }

      if (
        item.anchors.some(
          (anchor) => !anchor || !fixture.source.includes(anchor)
        )
      ) {
        return yield* new HarnessError({
          message: `Anchor absent from original source for ${item.id}`,
        });
      }

      const references = item.references.map((reference) =>
        path.relative(skill, path.resolve(skill, reference))
      );

      if (new Set(references).size !== references.length) {
        return yield* new HarnessError({
          message: `Duplicate references for ${item.id}`,
        });
      }

      if (fixture.input !== undefined) {
        freezeInput(fixture.input);
      }

      return Object.freeze({
        checks: Object.freeze([...reviewerChecks]),
        fixture: Object.freeze(fixture),
        spec: Object.freeze({
          ...item,
          anchors: Object.freeze(item.anchors),
          reader_questions: Object.freeze(item.reader_questions),
          references: Object.freeze(references),
        }),
      } satisfies CaseRecord);
    }),
    { concurrency: "unbounded" }
  );

  const records = allRecords.filter(
    (record) => split === undefined || split === record.spec.split
  );

  if (records.length === 0) {
    return yield* new HarnessError({
      message: `No cases selected for split ${split ?? "all"}`,
    });
  }

  if (
    anchorHelper === null &&
    records.some((record) => record.spec.anchors.length > 0)
  ) {
    return yield* new HarnessError({
      message: "Set anchor_helper for cases with literal anchors",
    });
  }

  const skillText = decoder.decode(defined(files.get(skillEntry)));
  const metadata = yield* parseSkill(skillText, path.basename(skill));
  const context = yield* Effect.context<WritingPlatform>();

  const byCaseId = new Map(
    records.map((record) => [record.fixture.id, record])
  );

  const helper =
    anchorHelper === null ? null : defined(files.get(anchorHelper));

  const assess = Effect.fn("assess")(function* assess(
    caseId: string,
    output: string
  ) {
    const record = byCaseId.get(caseId);

    if (record === undefined) {
      return yield* new HarnessError({
        message: `Unknown evaluation case: ${caseId}`,
      });
    }

    return yield* assessWriting(
      helper,
      record.fixture.source,
      output,
      record.spec.anchors
    ).pipe(Effect.provide(context));
  });

  const promptFor = preparePrompts({
    cases: records,
    reference: (name) =>
      decoder.decode(defined(files.get(path.join(skill, name)))),
    shortPrompt,
    skill: skillText,
  });

  return Object.freeze({
    assess,
    cases: Object.freeze(records),
    name: spec.name,
    promptFor,
    provenance: Object.freeze(
      Object.fromEntries(
        [...files].map(([file, bytes]) => [file, sha256(bytes)])
      )
    ),
    skillName: metadata.name,
  } satisfies LoadedSuite);
});

export const loadSelectedSuite = Effect.fn("loadSelectedSuite")(
  function* loadSelectedSuite(
    selection: SuiteSelection,
    root: string = REPO,
    split?: Split
  ) {
    const selected = yield* selectSuite(selection, root);

    return yield* loadSuite(selected.file, split, selected.skill ?? undefined);
  }
);

export const validateRepository = Effect.fn("validateRepository")(
  function* validateRepository(root: string = REPO) {
    const skills = yield* discoverSkills(root);
    let suites = 0;

    for (const skill of skills) {
      if (skill.suite !== null) {
        yield* loadSuite(skill.suite, undefined, skill);

        suites += 1;
      }
    }

    return { skills: skills.length, suites };
  }
);
