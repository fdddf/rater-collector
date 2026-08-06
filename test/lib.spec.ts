import { describe, expect, it } from 'vitest';
import { sha256Hex, signUploadToken, timingSafeEqual, verifyUploadToken } from '../src/lib/crypto';
import { compareVersions, localeCandidates } from '../src/lib/version';

const SECRET = 'test-secret';

describe('upload tokens', () => {
  const claims = { fid: 'fb_1', aid: 'app', n: 2, exp: Math.floor(Date.now() / 1000) + 900 };

  it('round-trips a signed token', async () => {
    const token = await signUploadToken(SECRET, claims);
    expect(await verifyUploadToken(SECRET, token)).toEqual(claims);
  });

  it('rejects a tampered payload', async () => {
    const token = await signUploadToken(SECRET, claims);
    const [payload, sig] = token.split('.');
    const tampered = btoa(JSON.stringify({ ...claims, n: 99 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(await verifyUploadToken(SECRET, `${tampered}.${sig}`)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signUploadToken(SECRET, claims);
    expect(await verifyUploadToken('another-secret', token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const expired = { ...claims, exp: Math.floor(Date.now() / 1000) - 1 };
    const token = await signUploadToken(SECRET, expired);
    expect(await verifyUploadToken(SECRET, token)).toBeNull();
  });

  it.each(['', 'garbage', 'a.b', '.', 'no-dot-here'])(
    'does not throw on a malformed token: %s',
    async (token) => {
      expect(await verifyUploadToken(SECRET, token)).toBeNull();
    },
  );
});

describe('hashing and comparison', () => {
  it('produces a stable 64-character hex SHA-256', async () => {
    const a = await sha256Hex('rtr_pub_abc');
    expect(a).toHaveLength(64);
    expect(a).toBe(await sha256Hex('rtr_pub_abc'));
    expect(a).not.toBe(await sha256Hex('rtr_pub_abd'));
  });

  it('compares correctly in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('version comparison', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0', '1.0.0', 0],       // missing segments count as 0
    ['1.2.0', '1.10.0', -1],   // numeric, not lexicographic
    ['2.0.0', '1.9.9', 1],
    ['0', '1.0.0', -1],
    ['1.0.1', '1.0', 1],
  ])('%s vs %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it('treats non-numeric segments as 0 rather than throwing', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
  });
});

describe('locale candidates', () => {
  it('goes from most specific to broadest', () => {
    expect(localeCandidates('zh-Hans-CN')).toEqual(['zh-Hans-CN', 'zh-Hans', 'zh']);
    expect(localeCandidates('en')).toEqual(['en']);
  });

  it('accepts underscores too', () => {
    expect(localeCandidates('pt_BR')).toEqual(['pt-BR', 'pt']);
  });

  it('returns an empty array for empty input', () => {
    expect(localeCandidates(undefined)).toEqual([]);
    expect(localeCandidates('')).toEqual([]);
  });
});
