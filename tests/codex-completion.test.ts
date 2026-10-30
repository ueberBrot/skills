import { expect, it } from "@effect/vitest";
import { EventType } from "@tanstack/ai/client";
import { Effect, Fiber } from "effect";

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
  let index = 0;
  let closed = false;

  const iterator: AsyncIterator<StreamChunk> = {
    next: async () => {
      const chunk = chunks[index];
      index += 1;

      return await Promise.resolve(
        chunk === undefined
          ? { done: true, value: null }
          : { done: false, value: chunk }
      );
    },
    return: async () => {
      closed = true;

      return await Promise.resolve({ done: true, value: null });
    },
  };

  return {
    closed: () => closed,
    stream: { [Symbol.asyncIterator]: () => iterator },
  };
};

it.effect(
  "completed agent streams release their iterator and abort controller",
  () =>
    Effect.gen(function* completedStream() {
      const controller = new AbortController();
      const tracked = trackedStream([...assistantMessage, finished]);

      const completion = yield* consumeCompletion(tracked.stream, controller);

      expect(completion.output).toBe("Completed response");
      expect(tracked.closed()).toBe(true);
      expect(controller.signal.aborted).toBe(true);
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
      const controller = new AbortController();
      const tracked = trackedStream(chunks);

      const error = yield* Effect.flip(
        consumeCompletion(tracked.stream, controller)
      );

      expect(error).toBeInstanceOf(Error);

      expect(tracked.closed()).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    })
);

it.effect("interruption aborts a pending read and closes the iterator", () =>
  Effect.gen(function* interruptedStream() {
    const controller = new AbortController();
    const reading = Promise.withResolvers<undefined>();
    let closed = false;

    const iterator: AsyncIterator<StreamChunk> = {
      next: async () => {
        const pending = Promise.withResolvers<IteratorResult<StreamChunk>>();

        controller.signal.addEventListener(
          "abort",
          () => {
            pending.resolve({ done: true, value: null });
          },
          { once: true }
        );

        reading.resolve(undefined);

        return await pending.promise;
      },
      return: async () => {
        closed = true;

        return await Promise.resolve({ done: true, value: null });
      },
    };

    const fiber = yield* Effect.forkChild(
      consumeCompletion({ [Symbol.asyncIterator]: () => iterator }, controller)
    );

    yield* Effect.promise(async () => {
      await reading.promise;
    });
    yield* Fiber.interrupt(fiber);

    expect(controller.signal.aborted).toBe(true);
    expect(closed).toBe(true);
  })
);
