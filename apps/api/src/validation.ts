import { z } from "zod";
import { POST_CHARACTER_LIMIT } from "@threadflow/shared";

export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone");
export const dateSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(72, "Use no more than 72 characters")
  .refine(
    (value) => Buffer.byteLength(value) <= 72,
    "Password must fit within 72 UTF-8 bytes",
  );
export const registerSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: passwordSchema,
    name: z.string().trim().min(1).max(80),
    timezone: timezoneSchema.default("UTC"),
  })
  .strict();
export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(1).max(100),
  })
  .strict();
export const postInputSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, "Write some text for your post")
      .refine(
        (value) => Array.from(value).length <= POST_CHARACTER_LIMIT,
        `Use no more than ${POST_CHARACTER_LIMIT} characters`,
      ),
    accountIds: z
      .array(z.string().min(1).max(100))
      .min(1, "Choose an account")
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Accounts must be unique",
      ),
    status: z.enum(["draft", "scheduled"]),
    scheduledAt: dateSchema.nullish(),
    timezone: timezoneSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.status === "scheduled" &&
      (!input.scheduledAt || input.scheduledAt.getTime() <= Date.now())
    )
      ctx.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "Choose a future date and time",
      });
  });
export const postStatuses = [
  "draft",
  "scheduled",
  "publishing",
  "published",
  "unconfirmed",
  "failed",
  "cancelled",
] as const;
export const postQuerySchema = z
  .object({
    status: z.enum(postStatuses).optional(),
    accountId: z.string().min(1).max(100).optional(),
    search: z.string().max(500).optional(),
  })
  .strict();
export const rescheduleSchema = z
  .object({
    scheduledAt: dateSchema.refine(
      (value) => value.getTime() > Date.now(),
      "Choose a future date and time",
    ),
    timezone: timezoneSchema,
  })
  .strict();
