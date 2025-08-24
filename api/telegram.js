// api/telegram.js
// Made for Vercel serverless (Next.js API) — single file, copy–paste ready.

export const config = {
  api: {
    bodyParser: false, // Telegram sends JSON, we'll parse manually
  },
};

// ======= ENV =======
const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL; // e.g. https://tg-bot-pro.vercel.app
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ======= FORCE-JOIN CHANNELS =======
// apne channels यहां सेट करो (username बिना @, और open url)
const REQUIRED_CHANNELS = [
  { username: "free_redeem_codes_fire_crypto", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { username: "Withdrawal_Proofsj",            url: "https://t.me/Withdrawal_Proofsj" },
  { username: "loot4udeal",                    url: "https://t.me/loot4udeal" },
];

// ======= TELEGRAM HELPERS =======
const TG = {
  api: (method, payload) =>
    fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(r => r.json()),
  answerCb: (id, text, alert = false) =>
    TG.api("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert }),
  send: (chat_id, text, extra = {}) =>
    TG.api("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra }),
  getMember: (chatIdOrUsername, userId) =>
    fetch(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatIdOrUsername)}&user_id=${userId}`)
      .then(r => r.json()),
};

// ======= REDIS (Upstash REST) =======
async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json();
  return j.result ?? null;
}
async function redisSet(key, value) {
  return fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
}
async function redisIncrBy(key, by = 1) {
  const res = await fetch(`${UPSTASH_URL}/incrby/${encodeURIComponent(key)}/${by}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json();
  return j.result;
}

// ======= UI BUILDERS =======
const mainMenu = {
  text:
    "Welcome Support 🇮🇳👋\n" +
    "Earn via referrals & daily bonus; redeem by withdraw.",
  keyboard: {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📣 Channels",      callback_data: "open:channels" },
          { text: "🧾 Proofs",        callback_data: "open:proofs"   },
        ],
        [
          { text: "💰 Balance",       callback_data: "open:balance"  },
          { text: "🎁 Daily Bonus",   callback_data: "open:daily"    },
        ],
        [
          { text: "👥 Referral",      callback_data: "open:ref"      },
          { text: "💸 Withdraw",      callback_data: "open:wd"       },
        ],
      ],
    },
  },
};

const backKeyboard = {
  reply_markup: {
    inline_keyboard: [[{ text: "↩️ Back", callback_data: "back:main" }]],
  },
};

function joinGateMessage() {
  // names hide — Channel1/Channel2 style buttons only with “Join”
  const rows = REQUIRED_CHANNELS.map((_, i) => [{ text: "Join", url: REQUIRED_CHANNELS[i].url }]);
  rows.unshift([{ text: "Follow Now", url: REQUIRED_CHANNELS[0].url }]);
  rows.push([{ text: "Claim🪙", callback_data: "gate:claim" }]);

  return {
    text:
      "😍 Hey !! User Welcome To Bot\n" +
      "🟢 Must Join All Channels To Use Bot\n" +
      "◼️ After Joining Click Claim",
    keyboard: { reply_markup: { inline_keyboard: rows } },
  };
}

// ======= VERIFY JOIN =======
async function isUserJoinedAll(userId) {
  for (const ch of REQUIRED_CHANNELS) {
    const resp = await TG.getMember(`@${ch.username}`, userId);
    if (!resp.ok) return false; // bot missing in channel or other issue
    const status = resp.result?.status;
    if (!["creator", "administrator", "member"].includes(status)) return false;
  }
  return true;
}

// ======= REFERRAL =======
async function ensureReferral(userId, startPayload) {
  // startPayload like: "ref_123456789"
  if (!startPayload || !startPayload.startsWith("ref_")) return;
  const inviter = startPayload.slice(4);
  if (!/^\d+$/.test(inviter)) return;
  if (String(userId) === inviter) return;

  const key = `user:${userId}:ref_by`;
  const already = await redisGet(key);
  if (already) return; // don’t overwrite

  await redisSet(key, inviter);
  // Add 1 coin to inviter (you can change)
  await redisIncrBy(`coins:${inviter}`, 1);
}

// ======= HANDLERS =======
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const payload = (msg.text || "").split(" ")[1] || "";

  // store referral only after user verified — but we log payload now to use later
  if (payload) await redisSet(`payload:${userId}`, payload);

  // check gate
  const verified = await redisGet(`verified:${userId}`);
  if (verified !== "1") {
    const gate = joinGateMessage();
    return TG.send(chatId, gate.text, gate.keyboard);
  }

  // verified → show menu
  return TG.send(chatId, mainMenu.text, mainMenu.keyboard);
}

async function handleGateClaim(cb) {
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;

  const joined = await isUserJoinedAll(userId);
  if (!joined) {
    await TG.answerCb(cb.id, "You have not joined all channels yet.", true);
    const gate = joinGateMessage();
    return TG.send(chatId, gate.text, gate.keyboard);
  }

  // mark verified
  await redisSet(`verified:${userId}`, "1");

  // apply referral now (only once)
  const payload = await redisGet(`payload:${userId}`);
  await ensureReferral(userId, payload || "");

  // show main menu
  await TG.answerCb(cb.id, "Verified! Welcome 🎉");
  return TG.send(chatId, mainMenu.text, mainMenu.keyboard);
}

async function handleOpen(section, cb) {
  const chatId = (cb?.message || {}).chat?.id;
  if (!chatId) return;

  if (section === "balance") {
    const bal = (await redisGet(`coins:${cb.from.id}`)) || "0";
    return TG.send(chatId, `Your balance: ${bal} coins`, backKeyboard);
  }
  if (section === "daily") {
    // simple daily claim once per day
    const today = new Date().toISOString().slice(0, 10);
    const last = await redisGet(`daily:${cb.from.id}`);
    if (last === today) {
      await TG.answerCb(cb.id, "Already claimed today ✅");
      return TG.send(chatId, "Opened: daily", backKeyboard);
    }
    await redisSet(`daily:${cb.from.id}`, today);
    await redisIncrBy(`coins:${cb.from.id}`, 1);
    await TG.answerCb(cb.id, "Daily +1 coin added!");
    return TG.send(chatId, "Opened: daily", backKeyboard);
  }
  if (section === "ref") {
    const inviter = (await redisGet(`user:${cb.from.id}:ref_by`)) || "none";
    return TG.send(chatId, `Opened: ref\nInvited by: ${inviter}`, backKeyboard);
  }
  if (section === "wd") {
    return TG.send(chatId, "Opened: wd\n(minimum 100 coins)", backKeyboard);
  }
  if (section === "channels") {
    const rows = REQUIRED_CHANNELS.map((c) => [{ text: "Join", url: c.url }]);
    return TG.send(chatId, "Opened: channels", {
      reply_markup: { inline_keyboard: [...rows, [{ text: "↩️ Back", callback_data: "back:main" }]] },
    });
  }
  if (section === "proofs") {
    return TG.send(chatId, "Opened: proofs", backKeyboard);
  }
}

async function handleBack(cb) {
  return TG.send(cb.message.chat.id, mainMenu.text, mainMenu.keyboard);
}

// ======= REQUEST PARSING =======
async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

// ======= MAIN HANDLER =======
export default async function handler(req, res) {
  // Health / debug
  if (req.method === "GET") {
    if (req.url?.includes("/api/telegram")) {
      return res.status(200).json({ ok: true, hello: "telegram" });
    }
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }

  // Secret check (recommended)
  const url = new URL(req.url, "http://localhost");
  const secret = url.searchParams.get("secret");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const update = await parseBody(req);

  try {
    // MESSAGE (/start)
    if (update.message) {
      const msg = update.message;
      if (msg.text?.startsWith("/start")) {
        await handleStart(msg);
      }
      return res.status(200).json({ ok: true });
    }

    // CALLBACK
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || "";

      if (data === "gate:claim") {
        await handleGateClaim(cb);
      } else if (data.startsWith("open:")) {
        await TG.answerCb(cb.id, "Opening…");
        await handleOpen(data.split(":")[1], cb);
      } else if (data === "back:main") {
        await TG.answerCb(cb.id, "Back");
        await handleBack(cb);
      }

      return res.status(200).json({ ok: true });
    }

    // ignore other updates
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Handler error:", e);
    return res.status(200).json({ ok: true }); // prevent Telegram retries
  }
}
