import type { ControllerTurnSource } from "./models";

/**
 * How a burst of owner messages is grouped, measured, and rendered.
 *
 * Grouping happens at claim time: the oldest queued owner turn plus every
 * following queued owner turn whose arrival was within the quiet gap of the
 * previous one, in ordinal order, stopping at the count cap, the text cap, the
 * attachment cap, an incomplete voice item, or a turn that cannot join (a
 * system or thread-follow-up turn). The values are fixed, documented defaults,
 * not settings.
 */

/** Messages closer than this arrive together; the claim also waits this long past the newest one. */
export const CONTROLLER_BURST_QUIET_GAP_MS = 2_000;
/** A burst carries at most this many messages, leader included. */
export const CONTROLLER_BURST_MAX_MEMBERS = 25;
/** A burst's rendered transcript stays within this many characters. */
export const CONTROLLER_BURST_MAX_TEXT_CHARS = 32 * 1024;
/** A burst carries at most this many attachments; further attachment-bearing turns start the next burst. */
export const CONTROLLER_BURST_MAX_ATTACHMENTS = 10;

/** The gap and caps a burst is selected under; they always travel together. */
export type ControllerBurstLimits = {
  quietGapMs: number;
  maxMembers: number;
  maxAttachments: number;
  maxTextChars: number;
};

export const CONTROLLER_BURST_LIMITS: ControllerBurstLimits = Object.freeze({
  quietGapMs: CONTROLLER_BURST_QUIET_GAP_MS,
  maxMembers: CONTROLLER_BURST_MAX_MEMBERS,
  maxAttachments: CONTROLLER_BURST_MAX_ATTACHMENTS,
  maxTextChars: CONTROLLER_BURST_MAX_TEXT_CHARS,
});

/**
 * What the composer needs to know about one burst member. File contents are
 * deliberately absent: they are inlined only into the dispatch text at send
 * time and never persisted, so a forwarded document cannot leak through the
 * plugin's records.
 */
export type ControllerBurstMemberView = {
  inputText: string;
  source: ControllerTurnSource | null;
  attachmentNames: readonly string[];
  inlineText: string | null;
  inlineFileName: string | null;
};

/**
 * The composer's view of one turn: its words, its provenance, and the names of
 * the files it carries. Inline bodies are added later by the dispatcher alone.
 */
export function burstMemberView(member: {
  inputText: string;
  source: ControllerTurnSource | null;
  image: { fileName: string } | null;
  document: { fileName: string } | null;
}): ControllerBurstMemberView {
  return {
    inputText: member.inputText,
    source: member.source,
    attachmentNames: [member.image?.fileName ?? null, member.document?.fileName ?? null]
      .filter((name): name is string => name !== null),
    inlineText: null,
    inlineFileName: null,
  };
}

function attribution(view: ControllerBurstMemberView): string {
  const source = view.source;
  if (source === null) return "You:";
  if (source.kind === "forwarded") {
    if (source.forwardedFrom !== null) return `Forwarded from ${source.forwardedFrom}:`;
    if (source.forwardedHidden) return "Forwarded from a sender who hid their name:";
    return "Forwarded from an unknown sender:";
  }
  if (source.kind === "reply") {
    if (source.quotedFromAgent) return "Reply to your message above:";
    if (source.quotedAuthor !== null) return `Reply to ${source.quotedAuthor}'s message above:`;
    return "Reply to an earlier message:";
  }
  return "You:";
}

function indented(lines: readonly string[]): string[] {
  return lines.map((line) => (line.length === 0 ? "" : `  ${line}`));
}

function inlineBlock(view: ControllerBurstMemberView): string[] {
  if (view.inlineText === null || view.inlineFileName === null) return [];
  return [
    `--- Attached file: ${view.inlineFileName} ---`,
    ...view.inlineText.split("\n"),
    `--- End of ${view.inlineFileName} ---`,
  ];
}

/** A message whose words are not simply the owner's own: a forward or a reply. */
function attributed(view: ControllerBurstMemberView): boolean {
  const kind = view.source?.kind;
  return kind === "forwarded" || kind === "reply";
}

/**
 * One member's entry. Numbered inside a burst, where continuation lines are
 * indented so member text cannot forge a new entry; unnumbered and flush-left
 * for a lone attributed message, which has no neighbours to forge.
 */
function entry(view: ControllerBurstMemberView, position: number | null): string {
  const header = position === null ? attribution(view) : `${position}. ${attribution(view)}`;
  const continued = position === null ? (lines: readonly string[]) => [...lines] : indented;
  const prefixed: string[] = [];
  for (const name of view.attachmentNames) prefixed.push(`File attached: ${name}`);
  const quoted = view.source?.quotedText ?? null;
  if (quoted !== null) prefixed.push(...quoted.split("\n").map((line) => `> ${line}`));
  const text: string[] = [...view.inputText.split("\n"), ...inlineBlock(view)];
  // The header line carries the message's first line when nothing structural
  // sits between them; a file line or a quote always starts on its own line so
  // the attribution reads as a label, not as part of the message.
  if (prefixed.length === 0) {
    if (text.every((line) => line.length === 0)) return header;
    const [first, ...rest] = text;
    return [`${header}${first.length === 0 ? "" : ` ${first}`}`, ...continued(rest)].join("\n");
  }
  return [header, ...continued([...prefixed, ...text])].join("\n");
}

/**
 * One attributed transcript for the whole burst. A lone message in the owner's
 * own words renders exactly as it did before bursts existed — plus, for an
 * inlined document, the readable body under a clear fence. A lone forward or
 * reply keeps its attribution: who wrote it, and what it answers.
 */
export function renderBurstTranscript(members: readonly ControllerBurstMemberView[]): string {
  if (members.length === 0) return "";
  const single = members[0]!;
  if (members.length === 1) {
    if (attributed(single)) return entry(single, null);
    const block = inlineBlock(single);
    if (block.length === 0) return single.inputText;
    return [single.inputText, ...block].join("\n");
  }
  return members.map((view, index) => entry(view, index + 1)).join("\n");
}

export type BurstCandidateInput = {
  id: string;
  ordinal: number;
  createdAt: number;
  /** False for a system or thread-follow-up turn, which can never join a burst. */
  joinable: boolean;
  /** False while the turn is held back by its own dispatch backoff. */
  dispatchable: boolean;
  attachmentCount: number;
};

export type BurstSelection = {
  memberIds: string[];
  /** When the burst tail is still fresh, the moment it becomes claimable; null when quiet. */
  holdUntil: number | null;
};

export function selectBurstMembers(input: {
  candidates: readonly BurstCandidateInput[];
  leaderCreatedAt: number;
  /** Files the leader itself carries; they count toward the burst's attachment cap. */
  leaderAttachmentCount: number;
  now: number;
  /** Smallest ordinal of an incomplete voice item; a claim never passes it. */
  voiceBlockOrdinal: number | null;
  limits: ControllerBurstLimits;
  /** Rendered transcript length if this candidate joined, measured by the caller. */
  transcriptChars: (candidate: BurstCandidateInput) => number;
  allowAttachments: boolean;
}): BurstSelection {
  const { quietGapMs, maxMembers, maxAttachments, maxTextChars } = input.limits;
  const hold = (createdAt: number): number => createdAt + quietGapMs;
  const leaderFresh = input.now - input.leaderCreatedAt < quietGapMs;
  if (leaderFresh) return { memberIds: [], holdUntil: hold(input.leaderCreatedAt) };

  const memberIds: string[] = [];
  let attachments = input.leaderAttachmentCount;
  let previousCreatedAt = input.leaderCreatedAt;
  for (const candidate of input.candidates) {
    if (!candidate.joinable) break;
    if (!candidate.dispatchable) break;
    if (input.voiceBlockOrdinal !== null && candidate.ordinal >= input.voiceBlockOrdinal) break;
    if (memberIds.length + 1 >= maxMembers) break;
    if (candidate.attachmentCount > 0 &&
        (input.allowAttachments === false || attachments + candidate.attachmentCount > maxAttachments)) {
      break;
    }
    if (input.transcriptChars(candidate) > maxTextChars) break;
    const fresh = input.now - candidate.createdAt < quietGapMs;
    const connected = candidate.createdAt - previousCreatedAt <= quietGapMs;
    if (fresh && connected) {
      // The burst is still growing; hold the claim until its tail goes quiet.
      return { memberIds, holdUntil: hold(candidate.createdAt) };
    }
    if (!connected) break;
    memberIds.push(candidate.id);
    attachments += candidate.attachmentCount;
    previousCreatedAt = candidate.createdAt;
  }
  return { memberIds, holdUntil: null };
}
