import { expect, it } from "vitest";
import {
  controllerExecutionProfiles,
  credentialBrokerConfigFingerprint,
  parseGlobalConfig,
  selfDiagnosisMode,
} from "../src/config";
import {
  CONTROLLER_MODELS,
  controllerExecutionArguments,
  controllerProviderFor,
  supportsServiceTier,
} from "../src/controller/execution-profile";
import {
  parseCredentialBrokerConfig,
  type CredentialBrokerConfigResult,
  type CredentialBrokerSettingsInput,
} from "../src/credentials/config";

function globalValues(overrides: Record<string, string | undefined> = {}) {
  return {
    botToken: "123:test-token",
    bbAppBaseUrl: "",
    ...overrides,
  };
}

const VALID_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIBgzCCASmgAwIBAgIUW1L4gC6MeV+Ud+wNnC7kU0bN+s0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMdGVzdC1maXh0dXJlMB4XDTI2MDgxNDEwMjgxM1oXDTM2MDgx
MTEwMjgxM1owFzEVMBMGA1UEAwwMdGVzdC1maXh0dXJlMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE8lgFiCsSPUTzcud3u5as3wowffShCJSevZVfHPT+spDqbRZJ
fAzqwAu69fjGsYzIcwKZYzvJUDcZBC5qSgN+W6NTMFEwHQYDVR0OBBYEFF2WLMZE
SeS3kyKKUuEBBoycc7noMB8GA1UdIwQYMBaAFF2WLMZESeS3kyKKUuEBBoycc7no
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgYXNP228YLyxkgGok
1Xlri/3ef+vGvZVkHplqiULz634CIQCNkG7RoRpzRaKQVkMZiZ/E8PdOmJuzCLhx
ydSY0UJMrA==
-----END CERTIFICATE-----`;
const VALID_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkiiRRwUsXJ7S1v9d
bcXTZYgtaanNlGvgyK86g4TddduhRANCAATyWAWIKxI9RPNy53e7lqzfCjB99KEI
lJ69lV8c9P6ykOptFkl8DOrAC7r1+MaxjMhzApljO8lQNxkELmpKA35b
-----END PRIVATE KEY-----`;
const KEY_CANARY = "kiiRRwUsXJ7S1v9dbcXTZYg";

function isolatedSettings(overrides: Partial<CredentialBrokerSettingsInput> = {}): CredentialBrokerSettingsInput {
  return {
    credentialBrokerMode: "isolated",
    credentialBrokerEndpoint: "https://broker.example.com",
    credentialBrokerInstallationId: "install_1",
    credentialBrokerTopologyReceiptDigest: "a".repeat(64),
    credentialBrokerTopologyReceiptExpiresAt: "9999999999999",
    credentialBrokerClientCertificate: VALID_PEM_CERT,
    credentialBrokerClientKey: VALID_KEY_PEM,
    credentialBrokerCaCertificate: VALID_PEM_CERT,
    ...overrides,
  };
}

it("fingerprints the disabled state as a stable sentinel", () => {
  const result = parseCredentialBrokerConfig({});
  expect(credentialBrokerConfigFingerprint(result)).toBe("disabled");
  expect(credentialBrokerConfigFingerprint(result)).toBe(credentialBrokerConfigFingerprint(result));
});

it("distinguishes invalid reasons from each other and from disabled", () => {
  const missingSetting = parseCredentialBrokerConfig({ credentialBrokerMode: "isolated" });
  const badPem = parseCredentialBrokerConfig(isolatedSettings({ credentialBrokerClientCertificate: "not-a-cert" }));
  const disabled = parseCredentialBrokerConfig({});

  expect(missingSetting.state).toBe("invalid");
  expect(badPem.state).toBe("invalid");
  const missingFingerprint = credentialBrokerConfigFingerprint(missingSetting);
  const badPemFingerprint = credentialBrokerConfigFingerprint(badPem);
  expect(missingFingerprint).not.toBe(badPemFingerprint);
  expect(missingFingerprint).not.toBe(credentialBrokerConfigFingerprint(disabled));
});

it("is stable for identical isolated settings and changes when any field changes", () => {
  const base = parseCredentialBrokerConfig(isolatedSettings());
  const same = parseCredentialBrokerConfig(isolatedSettings());
  const differentEndpoint = parseCredentialBrokerConfig(
    isolatedSettings({ credentialBrokerEndpoint: "https://broker-2.example.com" }),
  );

  expect(base.state).toBe("isolated");
  expect(credentialBrokerConfigFingerprint(base)).toBe(credentialBrokerConfigFingerprint(same));
  expect(credentialBrokerConfigFingerprint(base)).not.toBe(credentialBrokerConfigFingerprint(differentEndpoint));
});

it("detects a client key rotation even when every other field is unchanged", () => {
  const original = parseCredentialBrokerConfig(isolatedSettings());
  if (original.state !== "isolated") throw new Error("fixture must parse as isolated");
  // Fingerprinting operates on the already-parsed result, so the "rotated"
  // fixture only needs a different key string, not a second real keypair.
  const rotated: CredentialBrokerConfigResult = {
    state: "isolated",
    value: { ...original.value, clientKeyPem: `${VALID_KEY_PEM}\n` },
  };

  expect(credentialBrokerConfigFingerprint(original)).not.toBe(credentialBrokerConfigFingerprint(rotated));
});

it("never embeds the raw client key in the fingerprint", () => {
  const result = parseCredentialBrokerConfig(isolatedSettings());
  const fingerprint = credentialBrokerConfigFingerprint(result);

  expect(fingerprint).not.toContain(KEY_CANARY);
  expect(fingerprint).not.toContain("PRIVATE KEY");
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it("defaults controller execution when only public connection settings are present", () => {
  const parsed = parseGlobalConfig(globalValues({ maxConcurrentJobs: undefined }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.value).toMatchObject({
    maxConcurrentJobs: 5,
    controllerModel: "claude-opus-5[1m]",
    controllerFallbackModel1: "gpt-5.6-sol",
    controllerFallbackModel2: "disabled",
    controllerReasoningLevel: "xhigh",
    controllerServiceTier: "default",
    controllerPermissionMode: "auto",
  });
});

it("builds the ordered controller fallback chain with one shared execution policy", () => {
  const parsed = parseGlobalConfig(globalValues({
    controllerModel: "claude-opus-5[1m]",
    controllerFallbackModel1: "gpt-5.6-terra",
    controllerFallbackModel2: "claude-sonnet-5",
    controllerReasoningLevel: "high",
    controllerServiceTier: "fast",
    controllerPermissionMode: "accept-edits",
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(controllerExecutionProfiles(parsed.value)).toEqual([
    {
      model: "claude-opus-5[1m]",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
    {
      model: "gpt-5.6-terra",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
    {
      model: "claude-sonnet-5",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
  ]);
});

it("does not retry a disabled or duplicate fallback model", () => {
  const parsed = parseGlobalConfig(globalValues({
    controllerModel: "gpt-5.6-sol",
    controllerFallbackModel1: "gpt-5.6-sol",
    controllerFallbackModel2: "disabled",
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(controllerExecutionProfiles(parsed.value).map((profile) => profile.model)).toEqual([
    "gpt-5.6-sol",
  ]);
});

it("does not let fallback settings weaken the strong-only routing kill switch", () => {
  const parsed = parseGlobalConfig(globalValues({
    capabilityModelRouting: "strong-only",
    controllerFallbackModel1: "gpt-5.6-terra",
    controllerFallbackModel2: "claude-sonnet-5",
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(controllerExecutionProfiles(parsed.value).map((profile) => profile.model)).toEqual([
    "gpt-5.6-sol",
  ]);
});

it.each(["auto", "accept-edits", "full"] as const)("preserves an explicit controller permission mode: %s", (permissionMode) => {
  const parsed = parseGlobalConfig(globalValues({
    controllerModel: "gpt-5.6-terra",
    controllerReasoningLevel: "high",
    controllerServiceTier: "default",
    controllerPermissionMode: permissionMode,
    maxConcurrentJobs: undefined,
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.value).toMatchObject({
    controllerModel: "gpt-5.6-terra",
    controllerReasoningLevel: "high",
    controllerServiceTier: "default",
    controllerPermissionMode: permissionMode,
  });
});

it.each(["cursor-grok-4.6-medium", "grok-4.6", "claude-opus-5-thinking-medium"] as const)(
  "accepts the catalogued controller model %s",
  (controllerModel) => {
    const parsed = parseGlobalConfig(globalValues({ controllerModel }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.value.controllerModel).toBe(controllerModel);
  },
);

it("keeps every controller model in the pipeline catalog on a supported provider", () => {
  for (const model of CONTROLLER_MODELS) {
    expect(controllerProviderFor(model)).toMatch(/^(?:claude-code|codex|acp-cursor|acp-grok)$/);
  }
});

it("maps Cursor Claude and Grok models to their own providers", () => {
  expect(controllerProviderFor("claude-opus-5[1m]")).toBe("claude-code");
  expect(controllerProviderFor("claude-opus-5-thinking-medium")).toBe("acp-cursor");
  expect(controllerProviderFor("cursor-grok-4.6-medium")).toBe("acp-cursor");
  expect(controllerProviderFor("grok-4.6")).toBe("acp-grok");
  expect(controllerProviderFor("gpt-5.6-sol")).toBe("codex");
  expect(supportsServiceTier("claude-opus-5[1m]")).toBe(false);
  expect(supportsServiceTier("cursor-grok-4.6-medium")).toBe(true);
  expect(supportsServiceTier("grok-4.6")).toBe(true);
});

it("sends accept-edits when the controller default auto is used on Cursor or Grok", () => {
  const cursor = controllerExecutionArguments({
    model: "cursor-grok-4.6-medium",
    reasoningLevel: "high",
    serviceTier: "default",
    permissionMode: "auto",
  }, { includeProvider: true });
  const grok = controllerExecutionArguments({
    model: "grok-4.6",
    reasoningLevel: "xhigh",
    serviceTier: "default",
    permissionMode: "auto",
  }, { includeProvider: true });
  expect(cursor).toMatchObject({
    providerId: "acp-cursor",
    model: "cursor-grok-4.6-medium",
    permissionMode: "accept-edits",
    serviceTier: "default",
  });
  expect(grok).toMatchObject({
    providerId: "acp-grok",
    model: "grok-4.6",
    permissionMode: "accept-edits",
  });
});

it.each([
  ["primary", { controllerModel: "made-up-model" }],
  ["fallback", { controllerFallbackModel1: "made-up-model" }],
] as const)("rejects an unknown %s controller model", (_label, invalidModel) => {
  expect(parseGlobalConfig({
    ...globalValues({ maxConcurrentJobs: undefined }),
    ...invalidModel,
  })).toEqual({
    ok: false,
    message: "Fix the Telegram Agent URL or controller execution settings.",
  });
});

it.each(["1", "2", "3", "4", "5", "6", "7", "8"]) (
  "accepts maxConcurrentJobs=%s",
  (maxConcurrentJobs) => {
    const parsed = parseGlobalConfig(globalValues({ maxConcurrentJobs }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.value.maxConcurrentJobs).toBe(Number(maxConcurrentJobs));
  },
);

it.each(["0", "9", "1.5", "not-a-number", ""]) (
  "rejects invalid maxConcurrentJobs=%s",
  (maxConcurrentJobs) => {
    expect(parseGlobalConfig(globalValues({ maxConcurrentJobs })).ok).toBe(false);
  },
);

it("leaves a diagnosis as a draft pull request unless the setting says otherwise", () => {
  const parsed = parseGlobalConfig(globalValues());

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(selfDiagnosisMode(parsed.value)).toBe("draft-pr");
});

it("keeps an explicit self-diagnosis mode", () => {
  const parsed = parseGlobalConfig(globalValues({ selfDiagnosisMode: "pipeline" }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(selfDiagnosisMode(parsed.value)).toBe("pipeline");
});

it("refuses a self-diagnosis mode it does not know", () => {
  expect(parseGlobalConfig(globalValues({ selfDiagnosisMode: "merge-it" })).ok).toBe(false);
});
