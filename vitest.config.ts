import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Migrations must be read on the Node side and handed to workerd — test code runs inside
// the Worker runtime and can't reach the host filesystem.
const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
  plugins: [
    // Runs real workerd against the D1 / R2 bindings from wrangler.jsonc — tests hit real
    // sqlite and real object storage, not mocks.
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-only secrets, overriding .dev.vars.
        bindings: {
          ADMIN_TOKEN: 'test-admin-token',
          UPLOAD_HMAC_SECRET: 'test-upload-secret',
          PUBLIC_BASE_URL: 'http://localhost:8787',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
