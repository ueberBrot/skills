import { BunRuntime } from "@effect/platform-bun";
import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Path,
  Schedule,
  Schema,
} from "effect";

import { writeJson } from "../src/internal/json";
import { platform } from "../src/internal/platform";
import { replaySuite } from "../src/runs";

import type { CaseRecord, RunArtifact } from "../src/domain";
import type { LoadedSuite } from "../src/suites";

const ParametersSchema = Schema.Struct({
  concurrency: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
  mode: Schema.Literals(["replay", "snapshot"]),
  samples: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
  snapshotSpace: Schema.Literals(["0", "2"]),
});

const parameters = Schema.decodeUnknownSync(ParametersSchema)({
  concurrency: Bun.argv[4] ?? "1",
  mode: Bun.argv[2] ?? "replay",
  samples: Bun.argv[3] ?? "100",
  snapshotSpace: Bun.argv[5] ?? "2",
});

const payload = "x".repeat(1024);

const makeSuite = (samples: number): LoadedSuite => {
  const cases: CaseRecord[] = Array.from({ length: samples }, (_, index) => ({
    checks: ["Preserve the supplied value."],
    fixture: {
      id: `case-${index}`,
      request: "Return the supplied value.",
      source: payload,
    },
    spec: {
      anchors: [],
      id: `case-${index}`,
      language: "en",
      provenance: "synthetic-performance-workload",
      reader_questions: [],
      references: [],
      split: "development",
      task: "echo",
    },
  }));

  return {
    assess: () => Effect.succeed(null),
    name: "replay-scaling",
    promptFor: (id) => `Return ${id}: ${payload}`,
    provenance: {},
    skillName: "synthetic-performance-workload",
    cases,
  };
};

const writes: { bytes: number; duration_ms: number; checkpoint: boolean }[] =
  [];

let peakRss = process.memoryUsage().rss;
let peakHeap = process.memoryUsage().heapUsed;

const sampleMemory = () => {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
};

const benchmark = Effect.gen(function* benchmark() {
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = yield* filesystem.makeTempDirectoryScoped({
    prefix: "skills-replay-benchmark-",
  });

  const destination = path.join(directory, "run");
  const source = path.join(directory, "outputs.json");

  const suite = makeSuite(
    parameters.mode === "replay" ? parameters.samples : 1
  );

  yield* filesystem.writeFileString(
    source,
    JSON.stringify(
      suite.cases.map(({ fixture }) => ({ id: fixture.id, output: payload }))
    )
  );
  yield* Effect.forkChild(
    Effect.repeat(Effect.sync(sampleMemory), Schedule.spaced("5 millis"))
  );
  const started = yield* Clock.currentTimeNanos;

  const measured = Effect.gen(function* measured() {
    const { artifact: initial } = yield* replaySuite(
      suite,
      destination,
      { no_skill: source },
      { concurrency: parameters.concurrency }
    );

    let artifact = initial;
    let serializationMs: number | null = null;
    let snapshotMs: number | null = null;

    if (parameters.mode === "snapshot") {
      const { cases } = makeSuite(parameters.samples);
      const [result] = initial.results;

      if (result === undefined) {
        throw new Error("Benchmark setup produced no result");
      }

      artifact = {
        ...initial,
        cases: [...cases],
        results: cases.map(({ fixture }) => ({
          ...result,
          case_id: fixture.id,
        })),
      } satisfies RunArtifact;
      writes.length = 0;
      const encodeStart = yield* Clock.currentTimeNanos;
      yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Json, {
          space: Number(parameters.snapshotSpace),
        })
      )(artifact);
      serializationMs =
        Number((yield* Clock.currentTimeNanos) - encodeStart) / 1e6;
      const snapshotStart = yield* Clock.currentTimeNanos;
      yield* writeJson(
        path.join(directory, "run.json"),
        artifact,
        Number(parameters.snapshotSpace)
      );
      snapshotMs =
        Number((yield* Clock.currentTimeNanos) - snapshotStart) / 1e6;
    }

    return { artifact, serializationMs, snapshotMs };
  });

  const measuredWithFilesystem = Effect.gen(function* instrument() {
    return yield* measured.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...filesystem,
        writeFileString: (file, data, options) =>
          Effect.gen(function* timedWrite() {
            const start = yield* Clock.currentTimeNanos;
            yield* filesystem.writeFileString(file, data, options);
            writes.push({
              bytes: Buffer.byteLength(data),
              checkpoint: path.basename(file).startsWith("run.json."),
              duration_ms:
                Number((yield* Clock.currentTimeNanos) - start) / 1e6,
            });
            sampleMemory();
          }),
      })
    );
  });

  const result = yield* measuredWithFilesystem;

  sampleMemory();
  const checkpointWrites = writes.filter((write) => write.checkpoint);

  const latencies = checkpointWrites
    .map((write) => write.duration_ms)
    .toSorted((left, right) => left - right);

  const percentile = (fraction: number) =>
    latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)] ?? 0;

  const artifactFile =
    parameters.mode === "snapshot"
      ? path.join(directory, "run.json")
      : path.join(destination, "run.json");

  const artifactStats = yield* filesystem.stat(artifactFile);

  yield* Console.log(
    JSON.stringify({
      ...parameters,
      artifact_bytes: Number(artifactStats.size),
      bun: Bun.version,
      checkpoint_bytes_written: checkpointWrites.reduce(
        (total, write) => total + write.bytes,
        0
      ),
      checkpoint_writes: checkpointWrites.length,
      output_bytes_per_sample: Buffer.byteLength(payload),
      peak_sampled_heap_bytes: peakHeap,
      peak_sampled_rss_bytes: peakRss,
      serialization_ms: result.serializationMs,
      snapshot_ms: result.snapshotMs,
      wall_ms: Number((yield* Clock.currentTimeNanos) - started) / 1e6,
      write_latency_p50_ms: percentile(0.5),
      write_latency_p95_ms: percentile(0.95),
      write_ms: checkpointWrites.reduce(
        (total, write) => total + write.duration_ms,
        0
      ),
    })
  );
});

BunRuntime.runMain(benchmark.pipe(Effect.scoped, Effect.provide(platform)));
