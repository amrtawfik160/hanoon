import { capabilityDescriptorById } from "../capabilities/catalog";
import type { ManagedAutomationAuthority, ManagedAutomationCapabilityEvidence } from "./managed-automation";

const SYSTEM_MAINTENANCE_CAPABILITY_ID = "telegram_agent_watch";
const SYSTEM_MAINTENANCE_AUTHORITY_REVISION = 1;
type SystemMaintenanceAuthority = Extract<ManagedAutomationAuthority, { origin: "system-maintenance" }>;

export function systemMaintenanceCapabilityEvidence(systemKey: string): ManagedAutomationCapabilityEvidence {
  const descriptor = capabilityDescriptorById(SYSTEM_MAINTENANCE_CAPABILITY_ID);
  if (!descriptor || descriptor.status !== "admitted") {
    throw new Error("system-maintenance capability is not admitted");
  }
  return {
    version: 1,
    profileId: `system-maintenance:${systemKey}`,
    profileRevision: SYSTEM_MAINTENANCE_AUTHORITY_REVISION,
    capabilityId: descriptor.id,
    descriptorVersion: descriptor.version,
    descriptorDigest: descriptor.digest,
    evidenceRefs: [
      `capability-admission:${descriptor.id}:${descriptor.version}:${descriptor.digest}`,
      `system-maintenance:${systemKey}:standing-authority:${SYSTEM_MAINTENANCE_AUTHORITY_REVISION}`,
    ],
  };
}

export function systemMaintenanceAuthority(input: Readonly<{
  systemKey: string;
  controllerKey: string;
  projectId: string;
  hostId: string;
}>): SystemMaintenanceAuthority {
  return {
    version: 1,
    origin: "system-maintenance",
    controllerKey: input.controllerKey,
    projectId: input.projectId,
    hostId: input.hostId,
    taskAuthority: null,
    standingAuthority: {
      version: 1,
      kind: "system-maintenance",
      systemKey: input.systemKey,
      revision: SYSTEM_MAINTENANCE_AUTHORITY_REVISION,
    },
    capabilityEvidence: systemMaintenanceCapabilityEvidence(input.systemKey),
    mayWidenAutomation: false,
  };
}
