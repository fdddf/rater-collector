import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { beforeAll } from 'vitest';

// vitest.config.ts reads the migrations on the Node side and injects them through a
// binding — test code runs inside workerd and can't reach the host filesystem.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

// Build the schema from the real migration SQL, so tests always run against the same
// schema as production and a forgotten migration fails immediately.
beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations);
});
