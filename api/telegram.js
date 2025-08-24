export const config = { runtime: "edge" };

function ok(json) {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default async function handler(req) {
  // 1) Secret check
  const url = new URL(req.url);
  const qsSecret = url.searchParams.get("secret");
  const envSecret = process.env.WEBHOOK_SECRET || "";
  if (!qsSecret || qsSecret !== envSecret) {
    return ok({ ok: true, note: "bad secret, ignoring" });
  }

  // 2) Parse update
  let update;
  try { update = await req.json(); } catch { return ok({ ok: true, note: "no json" }); }

  // 3) Figure out chat
  const msg = update.message || update.edited_message || update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (!chatId) return ok({ ok: true, note: "no chat id" });

  // 4) Simple reply (for any /start or any text)
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const textIn = update.message?.text || update.callback_query?.data || "";
  const replyText = `👋 Hello! I received: ${textIn || "(no text)"}\n✅ Ping reply OK`;

  // 5) Send message to Telegram
  try {
    const tg = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: replyText }),
    });
    const data = await tg.json();
    return ok({ ok: true, sent: data });
  } catch (e) {
    return ok({ ok: false, error: String(e) });
  }
}
