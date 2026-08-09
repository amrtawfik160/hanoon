import { z } from "zod";

export const executionProfileSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningLevel: z
      .enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"])
      .optional(),
    serviceTier: z.enum(["default", "fast"]).optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
  })
  .strict();

export const projectPolicySchema = z
  .object({
    projectId: z.string().startsWith("proj_"),
    alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
    enabled: z.boolean(),
    githubRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1),
    implementation: executionProfileSchema,
    review: executionProfileSchema,
    validationCommands: z
      .array(
        z
          .object({
            name: z.string().min(1).max(40),
            command: z.string().min(1),
            timeoutMs: z.number().int().min(1_000).max(3_600_000),
          })
          .strict(),
      )
      .max(20),
    requiredChecks: z.array(z.string().min(1)).max(50),
    outputRedactionPatterns: z.array(z.string().min(1).max(200)).max(20),
    workerLivenessWatchdogMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
    maxReviewCycles: z.number().int().min(1).max(10).default(3),
    mergeMethod: z.enum(["merge", "rebase", "squash"]),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [index, pattern] of policy.outputRedactionPatterns.entries()) {
      try {
        new RegExp(pattern, "g");
      } catch {
        context.addIssue({
          code: "custom",
          path: ["outputRedactionPatterns", index],
          message: "Invalid regular expression",
        });
      }
    }
  });

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;
