export const INGESTION_SOURCE_STATUSES = ["disabled", "enabled"] as const;
export type IngestionSourceStatus = (typeof INGESTION_SOURCE_STATUSES)[number];

export const DEFAULT_INGESTION_SOURCE_STATUS: IngestionSourceStatus = "disabled";

/** One retrieval unit, matching a reference passage. */
export const MAX_INGESTION_EXCERPT_CHARACTERS = 2_000;

export type IngestionSource = Readonly<{
  id: string;
  chatRef: string;
  projectId: string;
  capturedAt: number;
  excerpt: string;
  status: IngestionSourceStatus;
}>;

export type RecordIngestionSourceInput = Readonly<{
  chatRef: string;
  projectId: string;
  excerpt: string;
  now: number;
}>;
