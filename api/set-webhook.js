export const config = { runtime: "edge" };

export default async function handler() {
  const need = ["BOT_TOKEN", "APP_URL", "WEBHOOK_SECRET"];
  const miss = need.filter(k => !process.env[k]);
  if (miss.length) {
    return new Response(JSON.stringify({ ok:false, error:`Missing envs: ${miss.join(", ")}` }), { status: 500 });
  }
  const url = `${process.env.APP_URL.replace(/\/$/, "")}/api/telegram?secret=${encodeURIComponent(process.env.WEBHOOK_SECRET)}`;
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, allowed_updates: ["message","callback_query"], drop_pending_updates: false })
  }).then(x => x.json());
  return new Response(JSON.stringify({ ok:true, set_to:url, telegram:r }), { headers: { "content-type":"application/json" }});
}
