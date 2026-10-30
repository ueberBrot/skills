import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option, Path, Schema } from "effect";
import {
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from "effect/cli";

import {
  exportReview,
  gradeRun,
  ReviewInputSchema,
  writeReport,
} from "./assessment";
import { ConditionSchema, JsonObjectSchema } from "./domain";
import { HarnessError } from "./errors";
import { executeSuite, replaySuite } from "./runs";
import { discoverSkills } from "./skills";
import { loadSelectedSuite, validateRepository } from "./suites";
import { builtinWriterNames, writerLayer } from "./writers";

import type { Condition } from "./domain";
import type { WriterConfig } from "./writers";

const optionalString = (name: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));

const requiredString = (name: string) =>
  Flag.String(name).pipe(
    Flag.withSchema(
      Schema.String.check(
        Schema.isPattern(/\S/u, { message: `--${name} is required` })
      )
    )
  );

const positiveInt = (name: string, fallback: number) =>
  Flag.Int(name).pipe(
    Flag.withSchema(
      Schema.Int.check(
        Schema.isGreaterThan(0, {
          message: `--${name} must be a positive integer`,
        })
      )
    ),
    Flag.withDefault(fallback)
  );

const suiteFlags = {
  skill: optionalString("skill"),
  split: Flag.Literals("split", ["development", "held_out"]).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  ),
  suite: optionalString("suite"),
};

const outputFlags = {
  logEvents: Flag.Boolean("log-events").pipe(
    Flag.withDescription(
      "Write run lifecycle diagnostics to OUT/events.jsonl."
    ),
    Flag.withDefault(false)
  ),
  out: requiredString("out"),
  seed: Flag.Int("seed").pipe(Flag.withDefault(42)),
  settings: Flag.String("settings").pipe(
    Flag.withSchema(Schema.fromJsonString(JsonObjectSchema)),
    Flag.withDefault({})
  ),
};

const replaySources = Effect.fnUntraced(function* replaySources(
  values: readonly string[]
) {
  const path = yield* Path.Path;
  const sources: Partial<Record<Condition, string>> = {};

  for (const value of values) {
    const separator = value.indexOf("=");

    if (separator === -1 || value.slice(separator + 1).length === 0) {
      return yield* new HarnessError({ message: "Expected CONDITION=path" });
    }

    const condition = yield* Schema.decodeUnknownEffect(ConditionSchema)(
      value.slice(0, separator)
    );

    if (sources[condition] !== undefined) {
      return yield* new HarnessError({
        message: `Duplicate replay condition: ${condition}`,
      });
    }

    sources[condition] = path.resolve(value.slice(separator + 1));
  }

  return sources;
});

const cliProgram = (argv: readonly string[] = process.argv.slice(2)) => {
  const commandIndex = argv.indexOf("--command");

  const command =
    commandIndex === -1 ? undefined : argv.slice(commandIndex + 1);

  const args = commandIndex === -1 ? argv : argv.slice(0, commandIndex + 1);
  let exitCode = 0;

  const list = Command.make(
    "list",
    {},
    Effect.fnUntraced(function* list() {
      const path = yield* Path.Path;
      const skills = yield* discoverSkills(path.resolve("."));

      yield* Console.log(
        JSON.stringify(
          skills.map(({ name, description, suite }) => ({
            description,
            name,
            suite,
          })),
          null,
          2
        )
      );
    })
  ).pipe(
    Command.withDescription("List repository skills and available evaluations.")
  );

  const validate = Command.make(
    "validate",
    suiteFlags,
    Effect.fnUntraced(function* validate(values) {
      const path = yield* Path.Path;

      if (values.skill === undefined && values.suite === undefined) {
        if (values.split !== undefined) {
          return yield* new HarnessError({
            message: "--split requires --skill or --suite",
          });
        }

        const result = yield* validateRepository(path.resolve("."));

        return yield* Console.log(JSON.stringify(result));
      }

      const suite = yield* loadSelectedSuite(
        values,
        path.resolve("."),
        values.split
      );

      return yield* Console.log(
        JSON.stringify({ cases: suite.cases.length, suite: suite.name })
      );
    })
  ).pipe(
    Command.withDescription(
      "Validate repository skills or a selected evaluation suite."
    )
  );

  const run = Command.make(
    "run",
    {
      ...suiteFlags,
      ...outputFlags,
      command: Flag.Boolean("command").pipe(
        Flag.withDescription(
          "Execute remaining arguments: --command EXECUTABLE [ARGS...]."
        ),
        Flag.withDefault(false)
      ),
      concurrency: positiveInt("concurrency", 1),
      conditions: Flag.String("conditions").pipe(
        Flag.withDescription("Condition names, repeated or comma-separated."),
        Flag.atLeast(0)
      ),
      executor: Flag.Literals("executor", builtinWriterNames).pipe(
        Flag.optional,
        Flag.map(Option.getOrUndefined)
      ),
      model: requiredString("model"),
      repetitions: positiveInt("repetitions", 1),
      timeout: Flag.Finite("timeout").pipe(
        Flag.withSchema(
          Schema.Finite.check(
            Schema.isGreaterThan(0, { message: "--timeout must be positive" })
          )
        ),
        Flag.withDefault(120)
      ),
    },
    Effect.fnUntraced(function* run(values) {
      const path = yield* Path.Path;

      if (values.command && (command === undefined || command.length === 0)) {
        return yield* new HarnessError({
          message: "--command needs an executable",
        });
      }

      const suite = yield* loadSelectedSuite(
        values,
        path.resolve("."),
        values.split
      );

      const output = path.resolve(values.out);

      let conditions: Condition[] | undefined;

      if (values.conditions.length > 0) {
        conditions = [];

        for (const value of values.conditions.flatMap((item) =>
          item.split(",")
        )) {
          conditions.push(
            yield* Schema.decodeUnknownEffect(ConditionSchema)(value)
          );
        }
      }

      if (values.command && values.executor !== undefined) {
        return yield* new HarnessError({ message: "Choose one executor" });
      }

      let writer: WriterConfig;

      if (values.command) {
        writer = { _tag: "Command", argv: command ?? [] };
      } else {
        if (values.executor === undefined) {
          return yield* new HarnessError({ message: "Choose one executor" });
        }

        writer = { _tag: "Builtin", name: values.executor };
      }

      const { exitCode: code, summary } = yield* executeSuite(suite, output, {
        concurrency: values.concurrency,
        conditions,
        logEvents: values.logEvents,
        model: values.model,
        repetitions: values.repetitions,
        seed: values.seed,
        settings: values.settings,
        timeout: values.timeout,
      }).pipe(Effect.provide(writerLayer(writer)));

      exitCode = code;
      yield* Console.log(JSON.stringify(summary));

      return yield* Effect.void;
    })
  ).pipe(
    Command.withDescription(
      "Generate fresh outputs using a command adapter or the existing Codex ChatGPT login."
    )
  );

  const replay = Command.make(
    "replay",
    {
      ...suiteFlags,
      ...outputFlags,
      model: optionalString("model"),
      outputs: Flag.String("outputs").pipe(
        Flag.withDescription(
          "Recorded outputs as CONDITION=PATH; repeat for each condition."
        ),
        Flag.atLeast(1)
      ),
    },
    Effect.fnUntraced(function* replay(values) {
      const path = yield* Path.Path;

      const suite = yield* loadSelectedSuite(
        values,
        path.resolve("."),
        values.split
      );

      const output = path.resolve(values.out);
      const sources = yield* replaySources(values.outputs);

      const { exitCode: code, summary } = yield* replaySuite(
        suite,
        output,
        sources,
        {
          logEvents: values.logEvents,
          model: values.model,
          seed: values.seed,
          settings: values.settings,
        }
      );

      exitCode = code;
      yield* Console.log(JSON.stringify(summary));
    })
  ).pipe(
    Command.withDescription(
      "Evaluate recorded outputs offline without calling a model."
    )
  );

  const review = Command.make(
    "review",
    {
      conditions: optionalString("conditions").pipe(
        Flag.withDescription("Two condition names separated by a comma.")
      ),
      out: requiredString("out"),
      run: requiredString("run"),
      seed: Flag.Int("seed").pipe(Flag.withDefault(42)),
    },
    Effect.fnUntraced(function* review(values) {
      const conditions =
        values.conditions === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.Array(ConditionSchema))(
              values.conditions.split(",")
            );

      const result = yield* exportReview({
        conditions,
        out: values.out,
        run: values.run,
        seed: values.seed,
      });

      yield* Console.log(JSON.stringify(result));
    })
  ).pipe(
    Command.withDescription("Export concealed-condition assessment packets.")
  );

  const report = Command.make(
    "report",
    {
      decoding: optionalString("decoding"),
      reviews: optionalString("reviews"),
      run: requiredString("run"),
    },
    Effect.fnUntraced(function* report(values) {
      const submission =
        values.reviews === undefined && values.decoding === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(ReviewInputSchema)({
              decoding: values.decoding,
              path: values.reviews,
            });

      const summary = yield* writeReport({
        review: submission,
        run: values.run,
      });

      return yield* Console.log(JSON.stringify(summary, null, 2));
    })
  ).pipe(
    Command.withDescription(
      "Summarize execution, literal checks, and submitted assessments."
    )
  );

  const grade = Command.make(
    "grade",
    {
      answerKeys: optionalString("answer-keys"),
      concurrency: positiveInt("concurrency", 2),
      executor: Flag.Literals("executor", builtinWriterNames).pipe(
        Flag.withDefault("codex")
      ),
      model: requiredString("model"),
      out: requiredString("out"),
      resume: Flag.Boolean("resume").pipe(Flag.withDefault(false)),
      run: requiredString("run"),
      settings: outputFlags.settings,
      timeout: positiveInt("timeout", 300),
    },
    Effect.fnUntraced(function* grade(values) {
      const { exitCode: code, summary } = yield* gradeRun({
        answerKeys: values.answerKeys,
        concurrency: values.concurrency,
        model: values.model,
        out: values.out,
        resume: values.resume,
        run: values.run,
        settings: values.settings,
        timeout: values.timeout,
      }).pipe(
        Effect.provide(writerLayer({ _tag: "Builtin", name: values.executor }))
      );

      exitCode = code;
      yield* Console.log(JSON.stringify(summary, null, 2));
    })
  ).pipe(
    Command.withDescription(
      "Grade saved outputs with evidence and anonymous model comparisons."
    )
  );

  const root = Command.make("skills").pipe(
    Command.withDescription(
      "Validate agent skills and run development evaluations."
    ),
    Command.withSubcommands([
      list,
      validate,
      run,
      replay,
      review,
      report,
      grade,
    ]),
    Command.withExamples([
      {
        command: "vp run skills validate",
        description: "Validate all skills and available suites.",
      },
      {
        command:
          "vp run skills run --skill NAME --out DIR --model ID --executor codex",
        description: "Use an existing ChatGPT login.",
      },
      {
        command:
          "vp run skills run --suite PATH --out DIR --model ID --command EXECUTABLE [ARGS...]",
        description: "Use a JSON command adapter.",
      },
      {
        command:
          "vp run skills replay --suite PATH --out DIR --outputs no_skill=PATH",
        description: "Replay recorded outputs offline.",
      },
    ])
  );

  const presenter = CliOutput.layerPresenter({
    present: (event) =>
      event._tag === "Help" && event.reason === "Implicit"
        ? Effect.void
        : CliOutput.defaultPresenter.present(event),
  });

  return Command.runWith(root, { renderErrors: false, version: "" })(
    args.length > 0 ? args : ["--help"]
  ).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const message =
          CliError.isCliError(error) && error._tag === "ShowHelp"
            ? error.errors.map((item) => item.message).join("\n") ||
              "Choose a command or request --help"
            : error.message;

        return Console.error(JSON.stringify({ error: message })).pipe(
          Effect.as(2)
        );
      },
      onSuccess: () => Effect.succeed(exitCode),
    }),
    Effect.provide(
      Layer.mergeAll(
        presenter,
        BunServices.layer,
        CliConfig.layer({
          builtIns: GlobalFlag.BuiltIns.filter(
            (flag) => flag !== GlobalFlag.Version
          ),
        })
      )
    )
  );
};

if (import.meta.main) {
  BunRuntime.runMain(
    cliProgram().pipe(
      Effect.tap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        })
      )
    ),
    { disableErrorReporting: true }
  );
}
