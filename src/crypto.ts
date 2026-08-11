import { createHash, randomBytes } from "node:crypto";

export function createSecret(bytes = 24, random = randomBytes): string {
  return random(bytes).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
