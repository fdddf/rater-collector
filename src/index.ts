import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { configRoutes } from './routes/config';
import { feedbackRoutes } from './routes/feedback';
import { telemetryRoutes } from './routes/telemetry';
import { adminRoutes } from './routes/admin';
import type { HonoEnv } from './types';

const app = new Hono<HonoEnv>();

// Clients are native apps and aren't subject to same-origin rules; open CORS just makes
// the API convenient to poke at from browser-based tools.
app.use('/v1/*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'X-Rater-Key', 'Authorization', 'If-None-Match'],
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  maxAge: 86400,
}));

app.get('/health', (c) => c.json({ ok: true }));

app.route('/v1', configRoutes);
app.route('/v1', feedbackRoutes);
app.route('/v1', telemetryRoutes);

// A bookmarked or hand-typed "/admin/" would otherwise fall through to the JSON 404.
app.get('/admin/', (c) => c.redirect('/admin', 301));
app.route('/admin', adminRoutes);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Exceptions built by Errors.* already carry a JSON body — pass it straight through.
    return err.getResponse();
  }
  console.error('unhandled error', err);
  return c.json({ error: { code: 'internal', message: 'Server error.' } }, 500);
});

export default app;
