import { BunCrypto, BunServices } from "@effect/platform-bun";
import { Layer } from "effect";

import type { Digest, SecureRandom } from "effect/crypto";

export type Services =
  | BunServices.BunServices
  | Digest.Digest
  | SecureRandom.SecureRandom;

export const platform = Layer.mergeAll(
  BunServices.layer,
  BunCrypto.layerDigest,
  BunCrypto.layerSecureRandom
);
