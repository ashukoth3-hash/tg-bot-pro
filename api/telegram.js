// api/telegram.js
// Crash-safe minimal handler to get your route healthy first.

export default async function handler(req, res) {
  try {
    // Simple health endpoint
    if (req.method === 'GET') {
      const dbg = (req.query.debug || '').toString().toLowerCase();
      if (dbg === 'env') {
        return res.status(200).json({
          ok: true,
          BOT_TOKEN: !!process.env.BOT_TOKEN,
          WEBHOOK_SECRET: !!process.env.WEBHOOK_SECRET,
          APP_URL: !!process.env.APP_URL,
          UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
          UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        });
      }
      return res.status(200).json({ ok: true, hello: 'telegram' });
    }

    // Telegram webhook hits POST
    if (req.method === 'POST') {
      // Hard guard: never crash on bad/missing env/secret
      const incomingSecret = (req.query.secret || '').toString();
      const expected = process.env.WEBHOOK_SECRET || '';

      if (!expected) {
        console.warn('WEBHOOK_SECRET missing in env.');
        // Still 200 so Telegram stops retrying; plus message tells you the problem
        return res
          .status(200)
          .json({ ok: false, error: 'WEBHOOK_SECRET env missing on server' });
      }
      if (incomingSecret !== expected) {
        console.warn('Bad webhook secret:', { incoming: incomingSecret });
        return res.status(401).json({ ok: false, error: 'Bad secret' });
      }

      // Body may come as parsed or raw depending on Vercel; normalize safely
      const update = typeof req.body === 'object' && req.body
        ? req.body
        : await safeReadJSON(req);

      console.log('Incoming update:', JSON.stringify(update).slice(0, 2000));

      // ---- Minimal echo so route stays healthy (no external deps) ----
      // IMPORTANT: Return 200 fast so Telegram is happy.
      // (Your full bot logic can be plugged here later.)
      return res.status(200).json({ ok: true });
    }

    // Other methods
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    // Never let the function crash; always return JSON & log the error
    console.error('Handler error:', err && err.stack ? err.stack : err);
    return res
      .status(200)
      .json({ ok: false, error: 'handler_catch', detail: String(err) });
  }
}

// Safely read JSON body without crashing on empty/invalid payloads
async function safeReadJSON(req) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    try {
      return JSON.parse(raw);
    } catch {
      console.warn('Invalid JSON body received:', raw.slice(0, 500));
      return {};
    }
  } catch (e) {
    console.warn('safeReadJSON failed', e);
    return {};
  }
}
