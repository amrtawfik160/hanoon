import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CapabilityRepository,
  CapabilityRevisionConflictError,
  CapabilityTerminalConflictError,
  type CreateCapabilityProfileInput,
} from "../src/storage/capability-repository";
import { CAPABILITY_MIGRATIONS } from "../src/storage/migrations";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

const baseProfile: CreateCapabilityProfileInput = {
  subjectKind: "worker_attempt",
  subjectId: "attempt_1",
  threadId: "thread_1",
  recipeId: "bounded",
  recipeVersion: 1,
  registryDigest: SHA_A,
  graphDigest: SHA_B,
  mode: "shadow",
  model: {
    pool: "strong",
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    serviceTier: "fast",
  },
  assignments: [
    {
      capabilityId: "test-driven-development",
      descriptorDigest: SHA_C,
      capabilityKind: "skill",
      mandatory: true,
    },
    {
      capabilityId: "telegram_agent_job_status",
      descriptorDigest: SHA_D,
      capabilityKind: "tool",
      mandatory: false,
    },
  ],
  reasonCodes: ["logic_change", "bounded_default", "logic_change"],
  traits: ["logic", "existing_flow", "logic"],
  now: 1_000,
};

type Harness = Readonly<{
  primary: Database.Database;
  secondary: Database.Database;
  primaryRepository: CapabilityRepository;
  secondaryRepository: CapabilityRepository;
  close(): void;
}>;

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "capability-repository-"));
  const databasePath = join(directory, "capabilities.sqlite");
  const primary = new Database(databasePath);
  let secondary: Database.Database | null = null;
  try {
    primary.pragma("journal_mode = WAL");
    primary.pragma("foreign_keys = ON");
    for (const migration of CAPABILITY_MIGRATIONS) primary.exec(migration);
    secondary = new Database(databasePath);
    secondary.pragma("journal_mode = WAL");
    secondary.pragma("foreign_keys = ON");
    let closed = false;
    return {
      primary,
      secondary,
      primaryRepository: new CapabilityRepository(primary),
      secondaryRepository: new CapabilityRepository(secondary),
      close: () => {
        if (closed) return;
        closed = true;
        secondary?.close();
        primary.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    secondary?.close();
    primary.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

describe("CapabilityRepository", () => {
  it("persists an intentionally empty strict-worker profile", () => {
    const testHarness = harness();
    try {
      const profile = testHarness.primaryRepository.createProfile({
        ...baseProfile,
        subjectId: "stage:job_1:2:spawn_critique",
        threadId: null,
        recipeId: "architectural",
        assignments: [],
        reasonCodes: ["strict_role"],
        traits: ["strict-json"],
      });

      expect(profile.assignments).toEqual([]);
      expect(testHarness.primaryRepository.listReceipts(profile.id, 10)).toEqual([]);
      expect(testHarness.primaryRepository.listMissingMandatoryOutcomes(profile.id)).toEqual([]);
    } finally {
      testHarness.close();
    }
  });

  it("atomically creates an immutable normalized profile and selection receipts", () => {
    const fixture = harness();
    try {
      const profile = fixture.primaryRepository.createProfile(baseProfile);

      expect(profile).toMatchObject({
        subjectKind: "worker_attempt",
        subjectId: "attempt_1",
        threadId: "thread_1",
        revision: 1,
        recipeId: "bounded",
        recipeVersion: 1,
        registryDigest: SHA_A,
        graphDigest: SHA_B,
        mode: "shadow",
        reasonCodes: ["bounded_default", "logic_change"],
        traits: ["existing_flow", "logic"],
      });
      expect(profile.assignments.map((assignment) => assignment.capabilityId)).toEqual([
        "telegram_agent_job_status",
        "test-driven-development",
      ]);
      expect(fixture.primaryRepository.listReceipts(profile.id, 20)).toMatchObject([
        { capabilityId: "telegram_agent_job_status", eventType: "selected", mandatory: false },
        { capabilityId: "test-driven-development", eventType: "selected", mandatory: true },
      ]);
      expect(() => fixture.primary.prepare(
        "UPDATE capability_profiles SET mode = 'active' WHERE id = ?",
      ).run(profile.id)).toThrow(/append-only/i);
      expect(() => fixture.primary.prepare(
        "DELETE FROM capability_receipts WHERE profile_id = ?",
      ).run(profile.id)).toThrow(/append-only/i);
    } finally {
      fixture.close();
    }
  });

  it("increments revisions and resolves the latest active and thread-bound profiles", () => {
    const fixture = harness();
    try {
      const shadow = fixture.primaryRepository.createProfile(baseProfile);
      const active = fixture.primaryRepository.createProfile({
        ...baseProfile,
        mode: "active",
        now: 2_000,
      });

      expect(shadow.revision).toBe(1);
      expect(active.revision).toBe(2);
      expect(fixture.primaryRepository.getActiveProfile("worker_attempt", "attempt_1")?.id)
        .toBe(active.id);
      expect(fixture.primaryRepository.getProfileForThread("thread_1")?.id).toBe(active.id);
    } finally {
      fixture.close();
    }
  });

  it("accepts exactly one evidenced terminal outcome for an exact selected assignment", () => {
    const fixture = harness();
    try {
      const profile = fixture.primaryRepository.createProfile(baseProfile);
      expect(fixture.primaryRepository.appendTerminalOutcome({
        profileId: profile.id,
        capabilityId: "test-driven-development",
        descriptorDigest: SHA_C,
        outcome: "passed",
        evidenceRefs: ["command:test", "artifact:coverage"],
        now: 2_000,
      })).toBe(true);
      expect(() => fixture.primaryRepository.appendTerminalOutcome({
        profileId: profile.id,
        capabilityId: "test-driven-development",
        descriptorDigest: SHA_C,
        outcome: "passed",
        evidenceRefs: ["command:test-again"],
        now: 3_000,
      })).toThrow(CapabilityTerminalConflictError);
      expect(() => fixture.primaryRepository.appendTerminalOutcome({
        profileId: profile.id,
        capabilityId: "telegram_agent_job_status",
        descriptorDigest: SHA_C,
        outcome: "passed",
        evidenceRefs: ["tool:status"],
        now: 3_000,
      })).toThrow(/descriptor/i);
      expect(() => fixture.primaryRepository.appendTerminalOutcome({
        profileId: profile.id,
        capabilityId: "telegram_agent_job_status",
        descriptorDigest: SHA_D,
        outcome: "passed",
        evidenceRefs: [],
        now: 3_000,
      })).toThrow(/evidence/i);
    } finally {
      fixture.close();
    }
  });

  it("rolls back profile creation when any assignment is invalid", () => {
    const fixture = harness();
    try {
      expect(() => fixture.primaryRepository.createProfile({
        ...baseProfile,
        assignments: [baseProfile.assignments[0], baseProfile.assignments[0]],
      })).toThrow(/duplicate/i);
      expect(fixture.primary.prepare("SELECT count(*) AS count FROM capability_profiles").get())
        .toEqual({ count: 0 });
      expect(fixture.primary.prepare("SELECT count(*) AS count FROM capability_receipts").get())
        .toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });

  it("fails closed when another connection already consumed an expected revision", () => {
    const fixture = harness();
    try {
      const first = fixture.primaryRepository.createProfile({ ...baseProfile, expectedRevision: 1 });
      expect(first.revision).toBe(1);
      expect(() => fixture.secondaryRepository.createProfile({
        ...baseProfile,
        expectedRevision: 1,
        now: 2_000,
      })).toThrow(CapabilityRevisionConflictError);
      expect(fixture.secondaryRepository.createProfile({
        ...baseProfile,
        expectedRevision: 2,
        now: 3_000,
      }).revision).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("projects only skill selections and outcomes through the compatibility view", () => {
    const fixture = harness();
    try {
      const profile = fixture.primaryRepository.createProfile(baseProfile);
      fixture.primaryRepository.appendTerminalOutcome({
        profileId: profile.id,
        capabilityId: "test-driven-development",
        descriptorDigest: SHA_C,
        outcome: "findings",
        evidenceRefs: ["finding:test-gap"],
        now: 2_000,
      });

      expect(fixture.primaryRepository.listSkillReceiptProjection(profile.id, 20)).toMatchObject([
        {
          profileId: profile.id,
          capabilityId: "test-driven-development",
          descriptorDigest: SHA_C,
          mandatory: true,
          outcome: "findings",
        },
      ]);
    } finally {
      fixture.close();
    }
  });

  it("records guard fingerprint recurrence transactionally and saturates at the third occurrence", () => {
    const fixture = harness();
    try {
      const profile = fixture.primaryRepository.createProfile(baseProfile);
      const input = {
        profileId: profile.id,
        scopeId: "review-lineage:job-1",
        fingerprint: "f".repeat(64),
        capabilityId: "test-driven-development",
        ruleId: "tests.rule-1",
        subjectIdentity: "tests/feature.test.ts",
        requirementClass: "evidence:test-contract",
        now: 2_000,
      };

      expect(fixture.primaryRepository.recordGuardFingerprint(input)).toBe(1);
      expect(fixture.secondaryRepository.recordGuardFingerprint({ ...input, now: 3_000 })).toBe(2);
      expect(fixture.primaryRepository.recordGuardFingerprint({ ...input, now: 4_000 })).toBe(3);
      expect(fixture.secondaryRepository.recordGuardFingerprint({ ...input, now: 5_000 })).toBe(3);
      expect(fixture.primary.prepare(
        "SELECT occurrences, first_seen_at, last_seen_at FROM guard_fingerprints WHERE scope_id = ? AND fingerprint = ?",
      ).get(input.scopeId, input.fingerprint)).toEqual({
        occurrences: 3,
        first_seen_at: 2_000,
        last_seen_at: 4_000,
      });
      expect(() => fixture.primaryRepository.recordGuardFingerprint({
        ...input,
        ruleId: "tests.rule-spoofed",
        now: 6_000,
      })).toThrow(/identity/i);
    } finally {
      fixture.close();
    }
  });

  it("creates all durable capability tables without replacing tool receipts", () => {
    const fixture = harness();
    try {
      const objects = fixture.primary.prepare(
        `SELECT type, name FROM sqlite_master
          WHERE name IN (
            'capability_profiles', 'capability_profile_assignments', 'capability_receipts',
            'capability_inventory', 'recipe_promotions', 'model_route_trials',
            'guard_fingerprints', 'skill_receipts'
          ) ORDER BY name`,
      ).all();
      expect(objects).toEqual([
        { type: "table", name: "capability_inventory" },
        { type: "table", name: "capability_profile_assignments" },
        { type: "table", name: "capability_profiles" },
        { type: "table", name: "capability_receipts" },
        { type: "table", name: "guard_fingerprints" },
        { type: "table", name: "model_route_trials" },
        { type: "table", name: "recipe_promotions" },
        { type: "view", name: "skill_receipts" },
      ]);
    } finally {
      fixture.close();
    }
  });
});
