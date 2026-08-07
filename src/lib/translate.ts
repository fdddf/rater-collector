import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { Errors } from './errors';
import type { Env } from '../types';

/**
 * The subset of a prompt config that is actually prose. Category *ids* are the keys the
 * client matches on, so they never reach the model — only the labels do, positionally,
 * and the ids are re-attached from the source afterwards.
 */
export interface TranslatableCopy {
  title: string;
  message: string;
  positive_label: string;
  negative_label: string;
  later_label: string;
  feedback_title: string;
  feedback_message: string;
  category_labels: string[];
}

/**
 * Shape the model is asked to return. Every field is required and `additionalProperties`
 * is false because that's what both providers' strict JSON modes demand.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    message: { type: 'string' },
    positive_label: { type: 'string' },
    negative_label: { type: 'string' },
    later_label: { type: 'string' },
    feedback_title: { type: 'string' },
    feedback_message: { type: 'string' },
    category_labels: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'title',
    'message',
    'positive_label',
    'negative_label',
    'later_label',
    'feedback_title',
    'feedback_message',
    'category_labels',
  ],
  additionalProperties: false,
} as const;

/**
 * Re-validated on the way back in. A model that ignores the schema, or an
 * OpenAI-compatible endpoint that only honours `json_object`, fails here rather than
 * writing junk into prompt_configs.
 */
const translatedSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(1000),
  positive_label: z.string().trim().min(1).max(80),
  negative_label: z.string().trim().min(1).max(80),
  later_label: z.string().trim().min(1).max(80),
  feedback_title: z.string().trim().max(200),
  feedback_message: z.string().trim().max(1000),
  category_labels: z.array(z.string().trim().max(80)).max(12),
});

const SYSTEM_PROMPT = [
  'You localize in-app rating prompts for mobile apps.',
  '',
  'Translate every value of the JSON object the user sends into the requested locale and',
  'return a JSON object with exactly the same keys.',
  '',
  'Rules:',
  '- Write copy a native speaker would tap through, not a literal gloss. Match the register',
  '  of the source: friendly, short, and free of jargon.',
  '- Button labels are tight by nature. Keep positive_label, negative_label and later_label',
  '  to roughly the length of the source — they have to fit a button.',
  '- Keep placeholders, brand names, product names and format specifiers exactly as written.',
  '- category_labels is an ordered array. Return the same number of items in the same order.',
  '- An empty string stays an empty string. Never invent copy for a field the source left blank.',
].join('\n');

function userPrompt(source: TranslatableCopy, targetLocale: string): string {
  return [
    `Target locale: ${targetLocale}`,
    '',
    'Source copy:',
    JSON.stringify(source, null, 2),
  ].join('\n');
}

// ── Provider configuration ───────────────────────────────────────────────────

export interface TranslateConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  baseURL?: string;
}

/**
 * Optional secrets are invisible to `wrangler types` in environments where they aren't
 * set, so they're read off a widened Env — same reason as `notifyWebhookURL`.
 */
type TranslateEnv = Env & {
  TRANSLATE_PROVIDER?: string;
  TRANSLATE_API_KEY?: string;
  TRANSLATE_MODEL?: string;
  TRANSLATE_BASE_URL?: string;
};

/**
 * Reads the translation provider out of the environment, or throws a message that names
 * the missing variable — a misconfigured console should say so, not fail opaquely at the
 * provider.
 */
export function translateConfig(env: Env): TranslateConfig {
  const e = env as TranslateEnv;
  const provider = (e.TRANSLATE_PROVIDER || 'anthropic').trim().toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw Errors.badRequest('TRANSLATE_PROVIDER must be "anthropic" or "openai".');
  }

  const apiKey = e.TRANSLATE_API_KEY?.trim();
  if (!apiKey) {
    throw Errors.badRequest(
      'Translation is not configured — set the TRANSLATE_API_KEY secret to enable it.',
    );
  }

  const model = e.TRANSLATE_MODEL?.trim();
  if (provider === 'openai' && !model) {
    // Every OpenAI-compatible vendor names its models differently, so there is no
    // sensible default to fall back to.
    throw Errors.badRequest('TRANSLATE_MODEL is required when TRANSLATE_PROVIDER is "openai".');
  }

  return {
    provider,
    apiKey,
    model: model || 'claude-opus-5',
    baseURL: e.TRANSLATE_BASE_URL?.trim() || undefined,
  };
}

/** True when translation is wired up, used to hide the button rather than to guard the route. */
export function translateConfigured(env: Env): boolean {
  const e = env as TranslateEnv;
  return Boolean(e.TRANSLATE_API_KEY?.trim());
}

// ── Providers ────────────────────────────────────────────────────────────────

/**
 * Takes a resolved config rather than the Env: callers translate several locales at once
 * and settle them independently, so a configuration problem has to surface before that
 * fan-out — otherwise it arrives disguised as N identical per-locale failures.
 */
export async function translateCopy(
  config: TranslateConfig,
  source: TranslatableCopy,
  targetLocale: string,
): Promise<TranslatableCopy> {
  const raw =
    config.provider === 'anthropic'
      ? await callAnthropic(config, source, targetLocale)
      : await callOpenAI(config, source, targetLocale);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${config.model} returned a response that is not JSON.`);
  }

  const result = translatedSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${config.model} returned copy that failed validation: ` +
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  // A dropped or invented category would silently re-key the picker on the client, so a
  // count mismatch falls back to the source labels rather than guessing at the alignment.
  const labels =
    result.data.category_labels.length === source.category_labels.length
      ? result.data.category_labels
      : source.category_labels;

  return { ...result.data, category_labels: labels };
}

async function callAnthropic(
  config: TranslateConfig,
  source: TranslatableCopy,
  targetLocale: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL });

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt(source, targetLocale) }],
    output_config: {
      // Translating a dozen short strings is not a reasoning problem; `low` keeps the
      // latency and the bill down without measurably hurting the copy.
      effort: 'low',
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to translate this copy.');
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error('The model returned an empty response.');
  return text;
}

/**
 * Anything speaking the OpenAI chat-completions dialect — DeepSeek, Moonshot, Qwen,
 * OpenRouter, a local llama.cpp server.
 *
 * Uses `json_object` rather than `json_schema` because support for the latter is patchy
 * across compatible endpoints; the schema is described in the prompt instead and the
 * response is validated by `translatedSchema` either way.
 */
async function callOpenAI(
  config: TranslateConfig,
  source: TranslatableCopy,
  targetLocale: string,
): Promise<string> {
  const base = (config.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\nRespond with JSON matching this schema:\n${JSON.stringify(RESPONSE_SCHEMA)}`,
        },
        { role: 'user', content: userPrompt(source, targetLocale) },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Translation provider returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Translation provider returned an empty response.');
  return text;
}
