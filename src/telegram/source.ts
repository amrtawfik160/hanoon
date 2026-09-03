import {
  CONTROLLER_SOURCE_NAME_MAX_CHARS as MAX_NAME,
  CONTROLLER_SOURCE_QUOTE_MAX_CHARS as MAX_QUOTED_TEXT,
  type ControllerTurnSource,
} from "../controller/models";
import type { TelegramMessage } from "./types";

function displayName(user: { first_name?: string; last_name?: string } | undefined): string | null {
  const name = [user?.first_name, user?.last_name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();
  return name.length === 0 ? null : name.slice(0, MAX_NAME);
}

function chatTitle(chat: { title?: string } | undefined): string | null {
  const title = chat?.title?.trim();
  return title === undefined || title.length === 0 ? null : title.slice(0, MAX_NAME);
}

/**
 * Structured provenance for one owner message, so a burst can be rendered as
 * one attributed transcript: who forwarded it, what a reply quotes, and which
 * album a photo belongs to. Nothing here carries file bytes, tokens, or
 * callback data.
 */
export function controllerSourceFromMessage(message: TelegramMessage): ControllerTurnSource | null {
  const forward = message.forward_origin;
  const reply = message.reply_to_message;
  const albumId = message.media_group_id ?? null;
  if (forward === undefined && reply === undefined && albumId === null) return null;

  let kind: ControllerTurnSource["kind"] = "owner";
  let forwardedFrom: string | null = null;
  let forwardedHidden = false;
  if (forward !== undefined) {
    kind = "forwarded";
    if (forward.type === "user") {
      forwardedFrom = displayName(forward.sender_user);
    } else if (forward.type === "hidden_user") {
      forwardedHidden = true;
      const name = forward.sender_user_name?.trim();
      forwardedFrom = name === undefined || name.length === 0 ? null : name.slice(0, MAX_NAME);
    } else if (forward.type === "chat") {
      forwardedFrom = chatTitle(forward.sender_chat);
    } else {
      forwardedFrom = chatTitle(forward.chat);
    }
  } else if (reply !== undefined) {
    kind = "reply";
  } else {
    kind = "album";
  }

  let quotedAuthor: string | null = null;
  let quotedFromAgent = false;
  let quotedText: string | null = null;
  let replyToMessageId: number | null = null;
  if (reply !== undefined) {
    replyToMessageId = reply.message_id;
    quotedFromAgent = reply.from?.is_bot === true;
    quotedAuthor = quotedFromAgent ? null : displayName(reply.from);
    const quote = (reply.text ?? reply.caption ?? "").trim();
    quotedText = quote.length === 0 ? null : quote.slice(0, MAX_QUOTED_TEXT);
  }

  return {
    kind,
    forwardedFrom,
    forwardedHidden,
    quotedAuthor,
    quotedFromAgent,
    quotedText,
    replyToMessageId,
    albumId,
  };
}
