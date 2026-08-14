import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;

export type BrokerReferenceAad = Readonly<{
  installationId: string;
  bindingId: string;
  generation: number;
}>;

export type EncryptBrokerReferenceInput = Readonly<{
  reference: string;
  key: Uint8Array;
  aad: BrokerReferenceAad;
}>;

export type DecryptBrokerReferenceInput = Readonly<{
  ciphertext: string;
  key: Uint8Array;
  aad: BrokerReferenceAad;
}>;

function assertKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) {
    throw new Error("invalid_broker_key");
  }
  return Buffer.from(key);
}

function assertAad(aad: BrokerReferenceAad): string {
  if (!aad || typeof aad.installationId !== "string" || aad.installationId.length === 0 ||
      typeof aad.bindingId !== "string" || aad.bindingId.length === 0 ||
      !Number.isSafeInteger(aad.generation) || aad.generation < 0) {
    throw new Error("invalid_broker_aad");
  }
  return `${aad.installationId}\0${aad.bindingId}\0${aad.generation}`;
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error("invalid_broker_ciphertext");
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new Error("invalid_broker_ciphertext");
  }
}

export function encryptBrokerReference(input: EncryptBrokerReferenceInput): string {
  if (typeof input.reference !== "string" || input.reference.length === 0) throw new Error("invalid_broker_reference");
  const key = assertKey(input.key);
  const aad = Buffer.from(assertAad(input.aad), "utf8");
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(input.reference, "utf8"), cipher.final()]);
  return `v1.${encode(iv)}.${encode(cipher.getAuthTag())}.${encode(ciphertext)}`;
}

export function decryptBrokerReference(input: DecryptBrokerReferenceInput): string {
  const parts = input.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("invalid_broker_ciphertext");
  const iv = decode(parts[1]);
  const tag = decode(parts[2]);
  const ciphertext = decode(parts[3]);
  if (iv.length !== AES_IV_BYTES || tag.length !== AES_TAG_BYTES) throw new Error("invalid_broker_ciphertext");
  const key = assertKey(input.key);
  const aad = Buffer.from(assertAad(input.aad), "utf8");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("invalid_broker_ciphertext");
  }
}

export function fingerprintResolvedVersion(
  resolvedVersion: string | Uint8Array,
  auditKey: Uint8Array,
): string {
  const key = assertKey(auditKey);
  const bytes = typeof resolvedVersion === "string" ? Buffer.from(resolvedVersion, "utf8") : Buffer.from(resolvedVersion);
  return createHmac("sha256", key).update(bytes).digest("hex");
}
