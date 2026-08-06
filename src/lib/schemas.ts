import { z } from 'zod';
import { LIMITS } from '../types';

const shortText = (max: number) => z.string().trim().max(max);

/** Request body for a client feedback submission. */
export const feedbackSubmissionSchema = z.object({
  idempotency_key: z.string().trim().min(8).max(128),
  message: z.string().trim().min(4).max(4000),
  category: shortText(64).optional(),
  email: z
    .union([z.email().max(320), z.literal('')])
    .optional()
    .transform((v) => (v ? v : undefined)),
  attachment_count: z.number().int().min(0).max(LIMITS.maxAttachments).default(0),

  device: z
    .object({
      app_version: shortText(32).optional(),
      build: shortText(32).optional(),
      bundle_id: shortText(256).optional(),
      os_version: shortText(32).optional(),
      device_model: shortText(64).optional(),
      locale: shortText(32).optional(),
      region: shortText(16).optional(),
      timezone: shortText(64).optional(),
      install_days: z.number().int().min(0).max(100000).optional(),
      launch_count: z.number().int().min(0).max(10000000).optional(),
    })
    .default({}),

  /** Arbitrary key/value pairs set by the host app, capped at 20 entries. */
  metadata: z.record(z.string().max(64), z.string().max(512)).optional().refine(
    (v) => !v || Object.keys(v).length <= 20,
    { message: 'metadata accepts at most 20 keys' },
  ),
});

export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;

export const telemetryEventSchema = z.object({
  kind: z.enum(['shown', 'positive', 'negative', 'dismissed', 'submitted']),
  app_version: shortText(32).optional(),
  variant: shortText(64).optional(),
  locale: shortText(32).optional(),
  /** Client-side event timestamp (Unix ms). Only used to order out-of-order batches — the server still stamps rows with its own clock. */
  at: z.number().int().optional(),
});

export const telemetryBatchSchema = z.object({
  events: z.array(telemetryEventSchema).min(1).max(50),
});

/** Request body for editing prompt copy from the admin console. */
export const promptConfigUpsertSchema = z.object({
  locale: shortText(32).default('*'),
  min_app_version: shortText(32).default('0'),
  enabled: z.boolean().default(true),
  variant: shortText(64).default('default'),
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(1000),
  positive_label: z.string().trim().min(1).max(80),
  negative_label: z.string().trim().min(1).max(80),
  later_label: z.string().trim().min(1).max(80),
  feedback_title: shortText(200).optional(),
  feedback_message: shortText(1000).optional(),
  categories: z
    .array(z.object({ id: shortText(64), label: z.string().trim().min(1).max(80) }))
    .max(12)
    .default([]),
  email_required: z.boolean().default(false),
  /** Thresholds pushed to the client to override its local trigger rules. All optional. */
  rules: z
    .object({
      min_days_since_install: z.number().int().min(0).max(3650).optional(),
      min_launch_count: z.number().int().min(0).max(100000).optional(),
      min_significant_events: z.number().int().min(0).max(100000).optional(),
      cooldown_days: z.number().int().min(0).max(3650).optional(),
      max_prompts_per_version: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
});

export const feedbackPatchSchema = z
  .object({
    status: z.enum(['pending', 'open', 'resolved', 'spam']).optional(),
    admin_note: z.string().max(4000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.admin_note !== undefined, {
    message: 'at least one field must be provided',
  });
