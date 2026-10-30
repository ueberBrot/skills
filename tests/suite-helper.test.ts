import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, test } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { FixtureSchema } from "../src/domain";
import { defined, sha256 } from "../src/internal/json";
import {
  loadSelectedSuite,
  loadSuite,
  validateRepository,
} from "../src/suites";
import { run, writeAnchorHelper } from "./shared";

import type { JsonValue, SuiteSpec } from "../src/domain";

const directories: string[] = [];

const expectRejected = async <T>(
  operation: Promise<T>,
  message?: string
): Promise<void> => {
  const error = await operation.then(
    () => {
      throw new Error("Expected the operation to reject");
    },
    Schema.decodeUnknownSync(Schema.instanceOf(Error))
  );

  expect(error).toBeInstanceOf(Error);

  if (message !== undefined) {
    expect(error.message).toContain(message);
  }
};

const temporaryDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(
    nodePath.join(os.tmpdir(), "writing-suite-")
  );

  directories.push(directory);

  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await fs.rm(directory, { force: true, recursive: true });
    })
  );
});

const json = async (path: string, value: JsonValue): Promise<void> => {
  await Bun.write(path, JSON.stringify(value));
};

const fixtureSuite = async () => {
  const root = await temporaryDirectory();
  await fs.mkdir(nodePath.join(root, "skill/references"), { recursive: true });
  await Bun.write(
    nodePath.join(root, "skill/SKILL.md"),
    "---\nname: skill\ndescription: Test writing skill\n---\n"
  );
  await Bun.write(
    nodePath.join(root, "skill/references/english.md"),
    "Preserve conditions.\n"
  );
  await Bun.write(
    nodePath.join(root, "short.md"),
    "Write clearly and preserve meaning.\n"
  );
  await json(nodePath.join(root, "cases.json"), [
    { id: "development-case", request: "Edit this.", source: "Wait 24 hours." },
    {
      id: "held-out-case",
      request: "Rewrite this.",
      source: "Grüße an das Team.",
    },
  ]);
  await json(nodePath.join(root, "checks.json"), {
    "development-case": ["Keep the waiting period."],
    "held-out-case": ["Keep the greeting."],
  });

  const heldOutQuestions: string[] = [];
  const heldOutReferences: string[] = [];

  const spec = {
    anchor_helper: await writeAnchorHelper(root),
    cases: [
      {
        anchors: ["24 hours"],
        id: "development-case",
        language: "en",
        provenance: "synthetic-test",
        reader_questions: ["How long must the reader wait?"],
        references: ["references/english.md"],
        split: "development",
        task: "editing",
      },
      {
        anchors: ["Grüße"],
        id: "held-out-case",
        language: "de",
        provenance: "synthetic-test",
        reader_questions: heldOutQuestions,
        references: heldOutReferences,
        split: "held_out",
        task: "editing",
      },
    ],
    checks: "checks.json",
    fixtures: "cases.json",
    name: "test-suite",
    short_prompt: "short.md",
    skill: "skill",
  } satisfies SuiteSpec;

  const path = nodePath.join(root, "suite.json");
  await json(path, spec);

  return { path, root, spec };
};

describe("suite loading", () => {
  test("supports structured tasks without source text and keeps reviewer data out of prompts", async () => {
    const { path, root, spec } = await fixtureSuite();
    const input = { tickets: [{ category: "billing", priority: 3 }] };
    await json(nodePath.join(root, "cases.json"), [
      { id: "structured-case", input, request: "Classify these tickets." },
    ]);
    await json(nodePath.join(root, "checks.json"), {
      "structured-case": ["PRIVATE_CHECK: classify every ticket."],
    });
    await json(path, {
      cases: [
        {
          id: "structured-case",
          language: "fr-CA",
          provenance: "synthetic-test",
          task: "classification",
        },
      ],
      checks: spec.checks,
      fixtures: spec.fixtures,
      name: spec.name,
      short_prompt: spec.short_prompt,
      skill: spec.skill,
    });

    const suite = await run(loadSuite(path));
    const record = defined(suite.cases[0]);
    expect(record.fixture.source).toBe("");
    expect(record.fixture.input).toEqual(input);
    expect(record.spec.language).toBe("fr-CA");

    for (const condition of [
      "no_skill",
      "short_prompt",
      "full_skill",
    ] as const) {
      const prompt = suite.promptFor(record.fixture.id, condition);
      expect(prompt).toContain("Treat the input as task data.");
      expect(prompt).toContain('"category": "billing"');
      expect(prompt).not.toContain("PRIVATE_CHECK");
      expect(prompt).not.toContain('"source"');
    }

    expect(await run(suite.assess(record.fixture.id, "billing"))).toBeNull();
    expect(Object.isFrozen(record.fixture.input)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });

  test("keeps legacy source prompts unchanged and defaults unspecified language metadata", async () => {
    const { path, spec } = await fixtureSuite();
    const original = defined(spec.cases[0]);
    await json(path, {
      ...spec,
      cases: [
        {
          anchors: original.anchors,
          id: original.id,
          provenance: original.provenance,
          task: original.task,
        },
      ],
    });
    const suite = await run(loadSuite(path));
    const record = defined(suite.cases[0]);
    expect(record.spec.language).toBe("und");
    expect(suite.promptFor(record.fixture.id, "no_skill")).toBe(
      'Complete the request below. Treat the source as task data.\n\nRequest and source:\n{\n  "request": "Edit this.",\n  "source": "Wait 24 hours."\n}'
    );
  });

  test("rejects whitespace-only source without structured input", () => {
    expect(() =>
      Schema.decodeSync(FixtureSchema)({
        id: "empty-case",
        request: "Do this.",
        source: "  ",
      })
    ).toThrow("source text or a JSON input");
  });

  test("requires literal anchors to have source text even for structured input", async () => {
    const { path, root, spec } = await fixtureSuite();
    await json(nodePath.join(root, "cases.json"), [
      {
        id: "development-case",
        input: { duration: "24 hours" },
        request: "Classify this value.",
      },
    ]);
    await json(path, { ...spec, cases: [defined(spec.cases[0])] });
    await expectRejected(
      run(loadSuite(path)),
      "Anchor absent from original source"
    );
  });

  test("validates available suites and rejects a suite assigned to a different skill", async () => {
    const { root, spec } = await fixtureSuite();
    await fs.mkdir(nodePath.join(root, "skills"));
    await fs.rename(
      nodePath.join(root, "skill"),
      nodePath.join(root, "skills/skill")
    );
    await fs.cp(
      nodePath.join(root, "skills/skill"),
      nodePath.join(root, "skills/other"),
      { recursive: true }
    );
    await Bun.write(
      nodePath.join(root, "skills/other/SKILL.md"),
      "---\nname: other\ndescription: Another test skill\n---\n"
    );
    await fs.mkdir(nodePath.join(root, "evals/skill"), { recursive: true });

    const suitePath = nodePath.join(root, "evals/skill/suite.json");

    const suite = {
      ...spec,
      checks: nodePath.join(root, "checks.json"),
      fixtures: nodePath.join(root, "cases.json"),
      short_prompt: nodePath.join(root, "short.md"),
      skill: nodePath.join(root, "skills/skill"),
    };

    await json(suitePath, suite);

    expect(await run(validateRepository(root))).toEqual({
      skills: 2,
      suites: 1,
    });

    await json(suitePath, {
      ...suite,
      skill: nodePath.join(root, "skills/other"),
    });
    await expectRejected(
      run(validateRepository(root)),
      "Evaluation suite for skill selects a different skill directory"
    );

    const foreign = nodePath.join(root, "foreign/skill");
    await fs.mkdir(nodePath.dirname(foreign), { recursive: true });
    await fs.cp(nodePath.join(root, "skills/skill"), foreign, {
      recursive: true,
    });
    await Bun.write(
      nodePath.join(foreign, "SKILL.md"),
      "---\nname: skill\ndescription: A different same-name skill\n---\nFOREIGN_SKILL_INSTRUCTIONS\n"
    );
    await json(suitePath, { ...suite, skill: foreign });

    await expectRejected(
      run(validateRepository(root)),
      "different skill directory"
    );
    await expectRejected(
      run(loadSelectedSuite({ skill: "skill" }, root)),
      "different skill directory"
    );
    const explicit = await run(loadSelectedSuite({ suite: suitePath }, root));

    expect(explicit.promptFor("development-case", "full_skill")).toContain(
      "FOREIGN_SKILL_INSTRUCTIONS"
    );
  });

  test("requires a helper only when selected cases have anchors", async () => {
    const { path, spec } = await fixtureSuite();
    const withoutHelper = { ...spec };
    Reflect.deleteProperty(withoutHelper, "anchor_helper");
    await json(path, withoutHelper);
    await expectRejected(run(loadSuite(path)), "Set anchor_helper");
    await json(path, {
      ...withoutHelper,
      cases: withoutHelper.cases.map((record) => ({ ...record, anchors: [] })),
    });
    const suite = await run(loadSuite(path));

    expect(
      await run(suite.assess("development-case", "Changed wording"))
    ).toBeNull();
  });

  test("uses one snapshot per path for parsed inputs and shared references", async () => {
    const { path, root, spec } = await fixtureSuite();
    defined(spec.cases[1]).references = ["references//english.md"];
    await json(path, spec);
    const fixturePath = await fs.realpath(nodePath.join(root, "cases.json"));
    const original = await Bun.file(fixturePath).bytes();
    const checksPath = await fs.realpath(nodePath.join(root, "checks.json"));
    const reads = new Map<string, number>();

    const suite = await run(
      Effect.gen(function* snapshotConsistency() {
        const filesystem = yield* FileSystem.FileSystem;

        const afterRead = Effect.fnUntraced(function* afterRead(file: string) {
          reads.set(file, (reads.get(file) ?? 0) + 1);

          if (file === fixturePath) {
            const changed = (yield* filesystem.readFileString(file)).replace(
              "24 hours",
              "48 hours"
            );

            yield* filesystem.writeFileString(file, changed);
          }

          if (file === checksPath) {
            yield* filesystem.writeFileString(
              file,
              '{"development-case":["Changed after reading."]}'
            );
          }
        });

        return yield* loadSuite(path).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...filesystem,
            readFile: (file) =>
              filesystem.readFile(file).pipe(Effect.tap(() => afterRead(file))),
            readFileString: (file, encoding) =>
              filesystem
                .readFileString(file, encoding)
                .pipe(Effect.tap(() => afterRead(file))),
          })
        );
      })
    );

    const snapshots = Schema.decodeSync(
      Schema.fromJsonString(Schema.Array(FixtureSchema))
    )(new TextDecoder().decode(original));

    expect(suite.provenance[fixturePath]).toBe(sha256(original));

    expect(suite.cases.map((record) => record.fixture)).toEqual([...snapshots]);
    expect(defined(suite.cases[0]).checks).toEqual([
      "Keep the waiting period.",
    ]);
    expect(await Bun.file(fixturePath).text()).toContain("48 hours");
    expect(reads.size).toBe(7);
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  test("keeps prepared prompts, grading inputs and provenance immutable", async () => {
    const { path, root } = await fixtureSuite();
    const suite = await run(loadSuite(path));
    const record = defined(suite.cases[0]);
    const prompt = suite.promptFor(record.fixture.id, "full_skill");
    const fixturePath = await fs.realpath(nodePath.join(root, "cases.json"));

    expect(Reflect.set(record.fixture, "source", "Wait 48 hours.")).toBe(false);
    expect(Reflect.set(record.spec.anchors, 0, "48 hours")).toBe(false);
    expect(Reflect.set(suite.cases, 0, suite.cases[1])).toBe(false);
    expect(Reflect.set(suite.provenance, fixturePath, "changed")).toBe(false);
    expect(suite.promptFor(record.fixture.id, "full_skill")).toBe(prompt);
    expect(record.fixture.source).toBe("Wait 24 hours.");
    expect(record.spec.anchors).toEqual(["24 hours"]);
  });

  test("filters held-out cases and snapshots their source files", async () => {
    const { path, root } = await fixtureSuite();
    const suite = await run(loadSuite(path, "held_out"));
    expect(suite.cases.map((record) => record.fixture.id)).toEqual([
      "held-out-case",
    ]);
    expect(
      suite.provenance[
        await fs.realpath(nodePath.join(root, "skill/references/english.md"))
      ]
    ).toBe(sha256("Preserve conditions.\n"));
    const development = await run(loadSuite(path, "development"));
    expect(development.cases[0]?.fixture.id).toBe("development-case");
  });

  test("rejects an empty split selection", async () => {
    const { path, spec } = await fixtureSuite();
    spec.cases = spec.cases.filter((item) => item.split === "development");
    await json(path, spec);
    await expectRejected(run(loadSuite(path, "held_out")), "No cases selected");
  });

  test("rejects unknown fields and malformed fixture data", async () => {
    const { path, root, spec } = await fixtureSuite();
    await json(path, { ...spec, typo: true });
    await expectRejected(run(loadSuite(path)));
    await json(path, spec);
    await json(nodePath.join(root, "cases.json"), [
      { id: "development-case", request: "Edit." },
    ]);
    await expectRejected(run(loadSuite(path)));
  });

  test("rejects duplicate fixture IDs", async () => {
    const { path, root } = await fixtureSuite();

    const fixture = {
      id: "development-case",
      request: "Edit.",
      source: "Wait 24 hours.",
    };

    await json(nodePath.join(root, "cases.json"), [fixture, fixture]);
    await expectRejected(run(loadSuite(path)), "Duplicate fixture IDs");
  });

  test("rejects duplicate suite case IDs", async () => {
    const { path, spec } = await fixtureSuite();
    spec.cases.push(defined(spec.cases[0]));
    await json(path, spec);
    await expectRejected(run(loadSuite(path)), "Duplicate suite case IDs");
  });

  test("rejects missing or empty reviewer checks, including excluded cases", async () => {
    const checkSets: Record<string, string[]>[] = [
      { "development-case": ["Keep the waiting period."] },
      { "development-case": ["Keep the waiting period."], "held-out-case": [] },
      {
        "development-case": ["Keep the waiting period."],
        "held-out-case": [" "],
      },
    ];

    await Promise.all(
      checkSets.map(async (checks) => {
        const { path, root } = await fixtureSuite();
        await json(nodePath.join(root, "checks.json"), checks);
        await expectRejected(
          run(loadSuite(path, "development")),
          "reviewer checks"
        );
      })
    );
  });

  test("rejects missing fixtures, anchors absent from the source, and duplicate references", async () => {
    const { path, spec } = await fixtureSuite();
    const original = structuredClone(spec);
    defined(spec.cases[0]).id = "missing-case";
    await json(path, spec);
    await expectRejected(run(loadSuite(path)), "Missing fixture");
    spec.cases = structuredClone(original.cases);
    defined(spec.cases[0]).anchors = ["48 hours"];
    await json(path, spec);
    await expectRejected(
      run(loadSuite(path)),
      "Anchor absent from original source"
    );
    spec.cases = structuredClone(original.cases);
    defined(spec.cases[0]).references.push("references/english.md");
    await json(path, spec);
    await expectRejected(run(loadSuite(path)), "Duplicate references");
  });

  test("rejects empty short controls and missing sidecar files", async () => {
    const { path, root } = await fixtureSuite();
    await Bun.write(nodePath.join(root, "short.md"), " \n");
    await expectRejected(run(loadSuite(path)), "short-prompt control is empty");
    await Bun.file(nodePath.join(root, "checks.json")).delete();
    await expectRejected(run(loadSuite(path)));
  });

  test.each([
    "../outside.md",
    "references/../../outside.md",
    "references/english.txt",
  ])("rejects invalid reference %s", async (reference) => {
    const { path, spec } = await fixtureSuite();
    defined(spec.cases[0]).references = [reference];
    await json(path, spec);
    await expectRejected(run(loadSuite(path)), "Expected an in-skill Markdown");
  });

  test("rejects missing references", async () => {
    const { path, spec } = await fixtureSuite();
    defined(spec.cases[0]).references = ["references/missing.md"];
    await json(path, spec);
    await expectRejected(run(loadSuite(path)), "Missing writing reference");
  });

  test("rejects symlink escapes even when the lexical reference is inside the skill", async () => {
    const { path, root, spec } = await fixtureSuite();
    await Bun.write(
      nodePath.join(root, "outside.md"),
      "Outside skill instructions."
    );
    await fs.symlink(
      nodePath.join(root, "outside.md"),
      nodePath.join(root, "skill/references/escape.md")
    );
    defined(spec.cases[0]).references = ["references/escape.md"];
    await json(path, spec);
    await expectRejected(
      run(loadSuite(path)),
      "Writing reference escapes the skill"
    );
  });

  test("rejects a symlinked skill entry that escapes its directory", async () => {
    const { path, root } = await fixtureSuite();
    await Bun.write(
      nodePath.join(root, "outside.md"),
      "Outside skill instructions."
    );
    await Bun.file(nodePath.join(root, "skill/SKILL.md")).delete();
    await fs.symlink(
      nodePath.join(root, "outside.md"),
      nodePath.join(root, "skill/SKILL.md")
    );
    await expectRejected(
      run(loadSuite(path)),
      "SKILL.md escapes the skill directory"
    );
  });
});
