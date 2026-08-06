/** SHA-256 as a hex digest. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export interface UploadTokenClaims {
  /** Feedback id */
  fid: string;
  /** App id */
  aid: string;
  /** How many attachments this token permits */
  n: number;
  /** Expiry, in Unix seconds */
  exp: number;
}

/**
 * Issues an attachment upload token, shaped `<base64url(payload)>.<base64url(hmac)>`.
 * Self-contained and self-expiring, so there is no token table to maintain in D1.
 */
export async function signUploadToken(secret: string, claims: UploadTokenClaims): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(sig))}`;
}

/** Verifies an upload token; returns null when the signature is wrong or it expired. */
export async function verifyUploadToken(
  secret: string,
  token: string,
): Promise<UploadTokenClaims | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const key = await hmacKey(secret);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64url(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as UploadTokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Constant-time comparison, so comparing secrets doesn't leak timing information. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newID(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}
