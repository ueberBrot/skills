import { expect, it } from "@effect/vitest";
import { EventType } from "@tanstack/ai/client";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { consumeCompletion } from "../src/writers/completion";

import type { RunFinishedEvent, StreamChunk } from "@tanstack/ai";

const assistantMessage: readonly StreamChunk[] = [
  {
    messageId: "answer",
    role: "assistant",
    type: EventType.TEXT_MESSAGE_START,
  },
  {
    delta: "Completed response",
    messageId: "answer",
    type: EventType.TEXT_MESSAGE_CONTENT,
  },
  { messageId: "answer", type: EventType.TEXT_MESSAGE_END },
];

const finished: RunFinishedEvent = {
  runId: "run",
  threadId: "thread",
  type: EventType.RUN_FINISHED,
};

const trackedStream = (chunks: readonly StreamChunk[]) => {
  let closed = false;

  return {
    closed: () => closed,
    stream: Stream.unwrap(
      Effect.acquireRelease(Effect.succeed(Stream.fromIterable(chunks)), () =>
        Effect.sync(() => {
          closed = true;
        })
      )
    ),
  };
};

it.effect("completed agent streams release their resources", () =>
  Effect.gen(function* completedStream() {
    const tracked = trackedStream([...assistantMessage, finished]);

    const completion = yield* consumeCompletion(tracked.stream);

    expect(completion.output).toBe("Completed response");
    expect(tracked.closed()).toBe(true);
  })
);

it.effect.each([
  {
    chunks: [...assistantMessage, finished, finished],
    name: "duplicate terminal events",
  },
  {
    chunks: [...assistantMessage, { ...finished, usage: [] }],
    name: "ambiguous usage",
  },
  {
    chunks: [
      ...assistantMessage,
      {
        ...finished,
        usage: { completionTokens: -1, promptTokens: 2, totalTokens: 1 },
      },
    ],
    name: "invalid usage counts",
  },
  { chunks: assistantMessage, name: "missing terminal event" },
  {
    chunks: [
      ...assistantMessage,
      {
        type: EventType.RUN_ERROR,
        message: "Provider failed",
      },
    ],
    name: "provider error event",
  },
  {
    chunks: [
      ...assistantMessage.filter(
        (chunk) => chunk.type !== EventType.TEXT_MESSAGE_CONTENT
      ),
      finished,
    ],
    name: "empty final response",
  },
  {
    chunks: [...assistantMessage.slice(0, 2), finished],
    name: "unfinished assistant message",
  },
] satisfies readonly { chunks: readonly StreamChunk[]; name: string }[])(
  "rejects $name and releases the stream",
  ({ chunks }) =>
    Effect.gen(function* rejectedStream() {
      const tracked = trackedStream(chunks);

      const error = yield* Effect.flip(consumeCompletion(tracked.stream));

      expect(error).toBeInstanceOf(Error);

      expect(tracked.closed()).toBe(true);
    })
);

it.effect("interruption releases a pending stream", () =>
  Effect.gen(function* interruptedStream() {
    const reading = yield* Deferred.make<undefined>();
    let closed = false;

    const stream = Stream.unwrap(
      Effect.acquireRelease(
        Effect.succeed(
          Stream.fromEffect(Deferred.succeed(reading, undefined)).pipe(
            Stream.flatMap(() => Stream.never)
          )
        ),
        () =>
          Effect.sync(() => {
            closed = true;
          })
      )
    );

    const fiber = yield* Effect.forkChild(consumeCompletion(stream));
    yield* Deferred.await(reading);
    yield* Fiber.interrupt(fiber);
    expect(closed).toBe(true);
  })
);

it.effect("preserves native stream failures", () =>
  Effect.gen(function* failedStream() {
    const failure = new Error("provider failed");
    const result = yield* Effect.flip(consumeCompletion(Stream.fail(failure)));
    expect(result).toBe(failure);
  })
);
