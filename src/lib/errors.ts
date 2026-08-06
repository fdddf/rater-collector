import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The uniform error envelope: { error: { code, message } }. */
export function apiError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
): HTTPException {
  return new HTTPException(status, {
    res: Response.json({ error: { code, message } }, { status }),
  });
}

export const Errors = {
  unauthorized: (msg = 'Missing or invalid API key.') => apiError(401, 'unauthorized', msg),
  forbidden: (msg = 'Access denied.') => apiError(403, 'forbidden', msg),
  notFound: (msg = 'Not found.') => apiError(404, 'not_found', msg),
  badRequest: (msg: string) => apiError(400, 'bad_request', msg),
  payloadTooLarge: (msg: string) => apiError(413, 'payload_too_large', msg),
  unsupportedMedia: (msg: string) => apiError(415, 'unsupported_media_type', msg),
  rateLimited: (msg = 'Too many requests. Please try again later.') =>
    apiError(429, 'rate_limited', msg),
};
