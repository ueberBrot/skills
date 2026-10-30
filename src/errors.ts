import { Schema } from "effect";
import { TaggedError as taggedError } from "effect/Schema";

export class HarnessError extends taggedError<
  HarnessError,
  { readonly brand: unique symbol }
>()("HarnessError", {
  message: Schema.String,
}) {}
