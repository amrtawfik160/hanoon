import { z } from "zod";

const telegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean(),
    first_name: z.string().max(256).optional(),
    last_name: z.string().max(256).optional(),
    username: z.string().max(256).optional(),
  })
  .passthrough();

const telegramChatSchema = z
  .object({
    id: z.number().int(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
    title: z.string().max(256).optional(),
  })
  .passthrough();

/** Telegram forward origins: a user, a hidden user, a chat, or a channel. */
const telegramForwardOriginSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("user"),
      date: z.number().int().optional(),
      sender_user: telegramUserSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("hidden_user"),
      date: z.number().int().optional(),
      sender_user_name: z.string().max(256).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("chat"),
      date: z.number().int().optional(),
      sender_chat: telegramChatSchema.optional(),
      author_signature: z.string().max(256).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("channel"),
      date: z.number().int().optional(),
      chat: telegramChatSchema.optional(),
      message_id: z.number().int().optional(),
      author_signature: z.string().max(256).optional(),
    })
    .passthrough(),
]);

const telegramPhotoSizeSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const telegramDocumentSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    file_name: z.string().max(1_024).optional(),
    mime_type: z.string().max(255).optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const telegramAnimationSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    thumbnail: telegramPhotoSizeSchema.optional(),
    file_name: z.string().max(1_024).optional(),
    mime_type: z.string().max(255).optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const telegramVideoSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    thumbnail: telegramPhotoSizeSchema.optional(),
    file_name: z.string().max(1_024).optional(),
    mime_type: z.string().max(255).optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const telegramVideoNoteSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    length: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    thumbnail: telegramPhotoSizeSchema.optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const telegramVoiceSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    duration: z.number().int().nonnegative(),
    mime_type: z.string().max(255).optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const telegramAudioSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    duration: z.number().int().nonnegative(),
    file_name: z.string().max(1_024).optional(),
    mime_type: z.string().max(255).optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    from: telegramUserSchema,
    chat: telegramChatSchema,
    text: z.string().optional(),
    caption: z.string().optional(),
    forward_origin: telegramForwardOriginSchema.optional(),
    media_group_id: z.string().max(128).optional(),
    photo: z.array(telegramPhotoSizeSchema).min(1).optional(),
    document: telegramDocumentSchema.optional(),
    animation: telegramAnimationSchema.optional(),
    video: telegramVideoSchema.optional(),
    video_note: telegramVideoNoteSchema.optional(),
    voice: telegramVoiceSchema.optional(),
    audio: telegramAudioSchema.optional(),
    reply_to_message: z
      .object({
        message_id: z.number().int(),
        from: telegramUserSchema.optional(),
        text: z.string().optional(),
        caption: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const telegramCallbackQuerySchema = z
  .object({
    id: z.string().min(1),
    from: telegramUserSchema,
    message: z
      .object({
        message_id: z.number().int(),
        chat: z
          .object({ id: z.number().int(), type: z.string() })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    data: z.string().max(64).optional(),
  })
  .passthrough();

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: telegramMessageSchema.optional(),
    callback_query: telegramCallbackQuerySchema.optional(),
  })
  .passthrough();

export const telegramGetMeSchema = z
  .object({
    id: z.number().int(),
    username: z.string().min(1),
  })
  .passthrough();

export const telegramSentMessageSchema = z
  .object({ message_id: z.number().int() })
  .passthrough();

export const telegramFileSchema = z
  .object({
    file_id: z.string().min(1).max(1_024),
    file_unique_id: z.string().min(1).max(1_024),
    file_size: z.number().int().nonnegative().optional(),
    file_path: z.string().min(1).max(2_048),
  })
  .passthrough();

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof telegramCallbackQuerySchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type SendMessagePayload = {
  text: string;
  parse_mode?: "HTML";
  reply_markup?: InlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
};
