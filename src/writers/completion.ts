import { EventType } from "@tanstack/ai/client";
import { Duration, Effect, Schema, Stream } from "effect";

import { HarnessError } from "../errors";

import type { JsonObject } from "../domain";
import type { StreamChunk } from "@tanstack/ai";

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const UsageSchema = Schema.Struct({
  cached_input_tokens: Schema.optionalKey(TokenCount),
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  reasoning_output_tokens: Schema.optionalKey(TokenCount),
  total_tokens: TokenCount,
});

interface CompletionState {
  completed: number;
  messages: Map<string, string[]>;
  output: string;
  usage: JsonObject | null;
}

interface TokenCounts {
  cached_input_tokens?: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  total_tokens: number;
}

type RunUsage = Extract<
  StreamChunk,
  { type: typeof EventType.RUN_FINISHED }
>["usage"];

const executionError = () =>
  new HarnessError({
    message: "Agent execution failed; diagnostics were not saved",
  });

const normalizeUsage = Effect.fnUntraced(function* normalizeUsage(
  values: RunUsage
) {
  if (Array.isArray(values)) {
    return yield* executionError();
  }

  if (values === undefined) {
    return null;
  }

  const counts: TokenCounts = {
    input_tokens: values.promptTokens,
    output_tokens: values.completionTokens,
    total_tokens: values.totalTokens,
  };

  if (values.promptTokensDetails?.cachedTokens !== undefined) {
    counts.cached_input_tokens = values.promptTokensDetails.cachedTokens;
  }

  if (values.completionTokensDetails?.reasoningTokens !== undefined) {
    counts.reasoning_output_tokens =
      values.completionTokensDetails.reasoningTokens;
  }

  return yield* Schema.decodeEffect(UsageSchema)(counts, {
    onExcessProperty: "error",
  });
});

const collectChunk = Effect.fnUntraced(function* collectChunk(
  state: CompletionState,
  chunk: StreamChunk
) {
  if (chunk.type === EventType.RUN_ERROR) {
    return yield* executionError();
  }

  if (
    chunk.type === EventType.TEXT_MESSAGE_START &&
    chunk.role === "assistant"
  ) {
    state.messages.set(chunk.messageId, []);
  }

  if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
    state.messages.get(chunk.messageId)?.push(chunk.delta);
  }

  if (chunk.type === EventType.TEXT_MESSAGE_END) {
    const message = state.messages.get(chunk.messageId);

    if (message !== undefined) {
      state.output = message.join("");
      state.messages.delete(chunk.messageId);
    }
  }

  if (chunk.type === EventType.RUN_FINISHED) {
    state.completed += 1;
    state.usage = yield* normalizeUsage(chunk.usage);
  }

  return state;
});

const finishIterator = Effect.fnUntraced(function* finishIterator(
  controller: AbortController,
  iterator: AsyncIterator<StreamChunk>
) {
  controller.abort();
  const close = iterator.return?.bind(iterator);

  if (close !== undefined) {
    yield* Effect.tryPromise({
      catch: executionError,
      try: async () => await close(),
    }).pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
  }
});

export const consumeCompletion = Effect.fnUntraced(function* consumeCompletion(
  stream: AsyncIterable<StreamChunk>,
  controller: AbortController
) {
  const iterator = stream[Symbol.asyncIterator]();

  yield* Effect.addFinalizer(() => finishIterator(controller, iterator));

  const state = yield* Stream.fromAsyncIterable(
    { [Symbol.asyncIterator]: () => iterator },
    executionError
  ).pipe(
    Stream.runFoldEffect(
      (): CompletionState => ({
        completed: 0,
        messages: new Map(),
        output: "",
        usage: null,
      }),
      collectChunk
    )
  );

  if (
    state.completed !== 1 ||
    state.messages.size !== 0 ||
    state.output.trim().length === 0
  ) {
    return yield* executionError();
  }

  return { output: state.output, usage: state.usage };
}, Effect.scoped);
