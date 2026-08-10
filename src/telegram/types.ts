import { z } from "zod";

const telegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean(),
  })
  .passthrough();

const telegramChatSchema = z
  .object({
    id: z.number().int(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
  })
  .passthrough();

export const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    from: telegramUserSchema,
    chat: telegramChatSchema,
    text: z.string().optional(),
    reply_to_message: z
      .object({ message_id: z.number().int() })
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
