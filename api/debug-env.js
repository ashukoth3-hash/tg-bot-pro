export default function handler(req, res) {
  res.status(200).json({
    BOT_TOKEN: !!process.env.BOT_TOKEN,
    APP_URL: !!process.env.APP_URL,
    WEBHOOK_SECRET: !!process.env.WEBHOOK_SECRET,
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN
  });
}
