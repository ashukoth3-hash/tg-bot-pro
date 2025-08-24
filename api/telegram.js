export const config = { runtime: "edge" };

/* ================== BASIC HELPERS ================== */
const TG = (method, body) =>
  fetch(`https://api.telegram.org/bot${env("BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

// Upstash Redis (REST)
async function rget(key) {
  const res = await fetch(`${env("UPSTASH_REDIS_REST_URL")}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env("UPSTASH_REDIS_REST_TOKEN")}` },
  });
  const j = await res.json();
  return j.result ?? null;
}
async function rset(key, val) {
  await fetch(`${env("UPSTASH_REDIS_REST_URL")}/set/${encodeURIComponent(key)}/${encodeURIComponent(
    typeof val === "string" ? val : JSON.stringify(val)
  )}`, { headers: { Authorization: `Bearer ${env("UPSTASH_REDIS_REST_TOKEN")}` } });
}
async function rincr(key, by = 1) {
  await fetch(`${env("UPSTASH_REDIS_REST_URL")}/incrby/${encodeURIComponent(key)}/${by}`, {
    headers: { Authorization: `Bearer ${env("UPSTASH_REDIS_REST_TOKEN")}` },
  });
}
async function rdel(key) {
  await fetch(`${env("UPSTASH_REDIS_REST_URL")}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env("UPSTASH_REDIS_REST_TOKEN")}` },
  });
}
async function rtop(prefix, limit = 10) {
  // naive leaderboard scan: store ref counts at key ref:<uid>
  // we will keep a separate list "users" to iterate top (small scale OK)
  const users = JSON.parse((await rget("users")) || "[]");
  const arr = [];
  for (const u of users) {
    const c = parseInt((await rget(`ref:${u}`)) || "0", 10);
    arr.push([u, c]);
  }
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, limit);
}

/* ================== BOT CONSTANTS ================== */

// Gate channels (labels hidden, links real)
const CHANNELS = [
  { label: "Channel 1", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { label: "Channel 2", url: "https://t.me/Withdrawal_Proofsj" },
  { label: "Channel 3", url: "https://t.me/loot4udeal" },
];

// Main menu keyboard
const mainMenu = {
  inline_keyboard: [
    [
      { text: "📣 Channels", callback_data: "open:channels" },
      { text: "🧾 Proofs", url: `https://t.me/${env("PROOF_CHANNEL")}` },
    ],
    [
      { text: "💰 Balance", callback_data: "open:balance" },
      { text: "🎁 Daily Bonus", callback_data: "open:daily" },
    ],
    [
      { text: "👥 Referral", callback_data: "open:ref" },
      { text: "💸 Withdraw", callback_data: "open:withdraw" },
    ],
    [{ text: "🏆 Leaderboard", callback_data: "open:board" }],
  ],
};

const adminMenu = {
  inline_keyboard: [
    [
      { text: "➕ Add Coins", callback_data: "admin:add" },
      { text: "➖ Remove Coins", callback_data: "admin:sub" },
    ],
    [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
    [{ text: "⬅️ Back", callback_data: "back:home" }],
  ],
};

const backBtn = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back:home" }]] };

/* ================== UI HELPERS ================== */
const hello = (user) =>
  `👋 Hello ${escapeName(user)} 🇮🇳\n🎯 *Main Menu / मुख्य मेनू*\nकमाओ referrals से और रोज़ाना bonus; redeem करो *Withdraw* से।`;

const joinGateText = (user) =>
  `👋 Hello ${escapeName(user)} 🇮🇳\n🔐 *Join all channels to continue.*\n🔰 सबसे पहले सभी चैनल Join करें, फिर नीचे *Claim ✅* दबाएँ।`;

function gateKeyboard() {
  return {
    inline_keyboard: [
      ...CHANNELS.map((c) => [{ text: `✅ Join ${c.label}`, url: c.url }]),
      [{ text: "✅ Claim", callback_data: "gate:claim" }],
    ],
  };
}

function escapeName(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (u.username ? `@${u.username}` : `${u.id}`);
  // very simple
  return name.replaceAll("*", "").replaceAll("_", "");
}

function maskEmail(email) {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  const shown = user.slice(0, Math.min(3, user.length));
  return `${shown}${"*".repeat(Math.max(1, user.length - shown.length))}@${domain}`;
}
function maskUpi(upi) {
  const [id, prov] = upi.split("@");
  const shown = id.slice(0, Math.min(3, id.length));
  return `${shown}${"*".repeat(Math.max(1, id.length - shown.length))}@${prov || ""}`;
}

/* ================== STATE KEYS ================== */
const kBal = (uid) => `bal:${uid}`;
const kUser = (uid) => `user:${uid}`; // json: {name}
const kState = (uid) => `state:${uid}`; // e.g. "await:email","await:upi","admin:add", "admin:broadcast"
const kJoinedOnce = (uid) => `joined_once:${uid}`; // "1"
const kRefCount = (uid) => `ref:${uid}`;
const kUsers = `users`; // json array of ids
const kWithdrawSeq = `withdraw:seq`;
const kWithdraw = (id) => `withdraw:${id}`;

/* ================== CORE HANDLER ================== */
export default async function handler(req) {
  // GET → health / set webhook
  if (req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("hello") === "telegram") {
      return json({ ok: true, hello: "telegram" });
    }
    if (url.searchParams.get("secret") === env("WEBHOOK_SECRET")) {
      const set = await fetch(
        `https://api.telegram.org/bot${env("BOT_TOKEN")}/setWebhook?url=${encodeURIComponent(
          `${env("APP_URL")}/api/telegram?secret=${env("WEBHOOK_SECRET")}`
        )}`
      ).then((r) => r.json());
      return json({ ok: true, set_to: `${env("APP_URL")}/api/telegram?secret=${env("WEBHOOK_SECRET")}`, telegram: set });
    }
    // env check
    return json({
      ok: true,
      BOT_TOKEN: !!process.env.BOT_TOKEN,
      APP_URL: !!process.env.APP_URL,
      WEBHOOK_SECRET: !!process.env.WEBHOOK_SECRET,
      UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  const update = await req.json();
  if (update.message) return onMessage(update.message);
  if (update.callback_query) return onCallback(update.callback_query);
  return new Response("OK");
}

/* ================== MESSAGE HANDLER ================== */
async function onMessage(m) {
  const chatId = m.chat.id;
  const from = m.from;
  await ensureUser(from);

  // referral tracking on /start
  if (m.text && m.text.startsWith("/start")) {
    const parts = m.text.trim().split(" ");
    if (parts.length > 1) {
      const ref = parts[1];
      if (ref && /^[0-9]+$/.test(ref) && ref !== String(from.id)) {
        await rincr(`ref:${ref}`, 1);
        // notify referrer
        TG("sendMessage", {
          chat_id: ref,
          text: `🎉 *Congrats!* A new referral joined via your link.`,
          parse_mode: "Markdown",
        });
        await addUserId(ref);
      }
    }
    // Always show join gate on /start
    await TG("sendMessage", {
      chat_id: chatId,
      text: joinGateText(from),
      reply_markup: gateKeyboard(),
      parse_mode: "Markdown",
    });
    return ok();
  }

  // Admin panel command
  if (m.text === "/admin" && isAdmin(from.id)) {
    await rset(kState(from.id), ""); // clear
    await TG("sendMessage", {
      chat_id: chatId,
      text: `🛠️ *Admin Panel*`,
      parse_mode: "Markdown",
      reply_markup: adminMenu,
    });
    return ok();
  }

  // Withdraw quick—if state awaits email/upi we parse "value amount"
  const state = (await rget(kState(from.id))) || "";
  if (state === "await:email" || state === "await:upi") {
    const txt = (m.text || "").trim();
    const parts = txt.split(/\s+/);
    if (parts.length < 2) {
      await TG("sendMessage", {
        chat_id: chatId,
        text:
          state === "await:email"
            ? "✉️ Send like: `yourmail@gmail.com 1000`"
            : "🏦 Send like: `upiid@bank 1000`",
        parse_mode: "Markdown",
        reply_markup: backBtn,
      });
      return ok();
    }
    const addr = parts[0];
    const amt = parseInt(parts[1], 10);
    if (!amt || amt <= 0) {
      await TG("sendMessage", { chat_id: chatId, text: "❗ Invalid amount.", reply_markup: backBtn });
      return ok();
    }
    await rset(kState(from.id), "");
    await handleWithdraw(from, state === "await:email" ? { email: addr, amount: amt } : { upi: addr, amount: amt });
    return ok();
  }

  // Admin states
  if (isAdmin(from.id)) {
    if (state === "admin:add" || state === "admin:sub") {
      const [uid, num] = (m.text || "").split(/\s+/);
      const delta = parseInt(num, 10);
      if (!uid || !delta) {
        await TG("sendMessage", {
          chat_id: chatId,
          text: "Send like: `USER_ID 100`",
          parse_mode: "Markdown",
          reply_markup: adminMenu,
        });
        return ok();
      }
      const key = kBal(uid);
      const cur = parseInt((await rget(key)) || "0", 10);
      const next = state === "admin:add" ? cur + delta : cur - delta;
      await rset(key, String(Math.max(0, next)));
      await rset(kState(from.id), "");
      await TG("sendMessage", { chat_id: chatId, text: `✅ Updated balance of ${uid}: ${Math.max(0, next)}`, reply_markup: adminMenu });
      return ok();
    }
    if (state === "admin:broadcast") {
      const users = JSON.parse((await rget(kUsers)) || "[]");
      for (const u of users) {
        TG("sendMessage", { chat_id: u, text: m.text || "" });
      }
      await rset(kState(from.id), "");
      await TG("sendMessage", { chat_id: chatId, text: "📣 Broadcast sent.", reply_markup: adminMenu });
      return ok();
    }
  }

  // Fallback = show menu
  await TG("sendMessage", {
    chat_id: chatId,
    text: hello(from),
    parse_mode: "Markdown",
    reply_markup: mainMenu,
  });
  return ok();
}

/* ================== CALLBACK HANDLER ================== */
async function onCallback(q) {
  const data = q.data || "";
  const chatId = q.message.chat.id;
  const from = q.from;
  await ensureUser(from);

  // GATE
  if (data === "gate:claim") {
    const joined = await checkAllJoined(from.id);
    if (!joined.ok) {
      await TG("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "❗ अभी भी सभी चैनल joined नहीं हैं.",
        show_alert: true,
      });
      return ok();
    }
    await rset(kJoinedOnce(from.id), "1");
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: hello(from),
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
    return ok();
  }

  // NAV
  if (data === "back:home") {
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: hello(from),
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
    return ok();
  }

  // open sections
  if (data === "open:channels") {
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: "📣 *Required Channels*\nसभी चैनल join करें:",
      parse_mode: "Markdown",
      reply_markup: gateKeyboard(),
    });
    return ok();
  }

  if (data === "open:balance") {
    const bal = parseInt((await rget(kBal(from.id))) || "0", 10);
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: `💰 *Your balance:* ${bal} coins`,
      parse_mode: "Markdown",
      reply_markup: backBtn,
    });
    return ok();
  }

  if (data === "open:daily") {
    const stampKey = `daily:${from.id}`;
    const last = parseInt((await rget(stampKey)) || "0", 10);
    const now = Date.now();
    if (now - last < 24 * 60 * 60 * 1000) {
      await TG("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "⏳ Daily bonus already claimed. Try again later.",
        show_alert: true,
      });
    } else {
      await rset(stampKey, String(now));
      await rincr(kBal(from.id), 50);
      await TG("answerCallbackQuery", { callback_query_id: q.id, text: "🎁 +50 coins", show_alert: true });
    }
    const bal = parseInt((await rget(kBal(from.id))) || "0", 10);
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: `🎁 *Daily Bonus*\nCurrent balance: ${bal}`,
      parse_mode: "Markdown",
      reply_markup: backBtn,
    });
    return ok();
  }

  if (data === "open:ref") {
    const myLink = `https://t.me/${(await getMe()).result.username}?start=${from.id}`;
    const count = parseInt((await rget(kRefCount(from.id))) || "0", 10);
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text:
        `👥 *Referral*\n` +
        `🔗 Your link:\n${myLink}\n\n` +
        `✅ Refs: ${count}`,
      parse_mode: "Markdown",
      reply_markup: backBtn,
    });
    return ok();
  }

  if (data === "open:board") {
    const top = await rtop("ref:", 10);
    const lines = await Promise.all(
      top.map(async ([uid, c], i) => {
        const un = JSON.parse((await rget(kUser(uid))) || "{}");
        const name = un.name || uid;
        return `${i + 1}. ${name} - ${c} refs`;
      })
    );
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: `🏆 *Leaderboard*\n${lines.join("\n") || "No refs yet."}`,
      parse_mode: "Markdown",
      reply_markup: backBtn,
    });
    return ok();
  }

  if (data === "open:withdraw") {
    const kb = {
      inline_keyboard: [
        [{ text: "✉️ Gmail (code by email)", callback_data: "wd:email" }],
        [{ text: "🏦 UPI (pay to UPI)", callback_data: "wd:upi" }],
        [{ text: "⬅️ Back", callback_data: "back:home" }],
      ],
    };
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: "💸 *Withdraw*\nएक विकल्प चुनें:",
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    return ok();
  }

  if (data === "wd:email") {
    await rset(kState(from.id), "await:email");
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: "✉️ *Send your email and amount*\nउदाहरण: `yourmail@gmail.com 1000`",
      parse_mode: "Markdown",
      reply_markup: backBtn,
    });
    return ok();
  }
  if (data === "wd:upi") {
    await rset(kState(from.id), "await:upi");
    await TG("editMessageText", {
      chat_id: chatId,
      message_id: q.message.message_id,
      text: "🏦 *Send your UPI id and amount*\nउदाहरण: `yourid@bank 1000`",
      parse_mode: "Markdown",
      reply_markup: backBtn,
    });
    return ok();
  }

  // Admin callbacks
  if (data === "admin:add" && isAdmin(from.id)) {
    await rset(kState(from.id), "admin:add");
    await TG("answerCallbackQuery", { callback_query_id: q.id, text: "Send: USER_ID AMOUNT" });
    return ok();
  }
  if (data === "admin:sub" && isAdmin(from.id)) {
    await rset(kState(from.id), "admin:sub");
    await TG("answerCallbackQuery", { callback_query_id: q.id, text: "Send: USER_ID AMOUNT" });
    return ok();
  }
  if (data === "admin:broadcast" && isAdmin(from.id)) {
    await rset(kState(from.id), "admin:broadcast");
    await TG("answerCallbackQuery", { callback_query_id: q.id, text: "Send broadcast message" });
    return ok();
  }

  // Withdraw approve/reject
  if (data.startsWith("w:")) {
    const [_, action, wid] = data.split(":");
    const rec = JSON.parse((await rget(kWithdraw(wid))) || "null");
    if (!rec) {
      await TG("answerCallbackQuery", { callback_query_id: q.id, text: "Not found." });
      return ok();
    }
    if (!isAdmin(from.id)) {
      await TG("answerCallbackQuery", { callback_query_id: q.id, text: "Admin only." });
      return ok();
    }
    if (action === "approve") {
      await TG("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });

      // Proof channel message (masked)
      const publicText =
        `✅ *Withdrawal Paid*\n` +
        `ID: ${wid}\n` +
        `User: ${rec.user.id} ${rec.user.name}\n` +
        (rec.email ? `Email: ${maskEmail(rec.email)}\n` : `UPI: ${maskUpi(rec.upi)}\n`) +
        `Amount: ${rec.amount}`;
      await TG("sendMessage", {
        chat_id: `@${env("PROOF_CHANNEL")}`,
        text: publicText,
        parse_mode: "Markdown",
      });

      // user notify
      await TG("sendMessage", {
        chat_id: rec.user.id,
        text:
          rec.email
            ? `🎉 Your withdrawal #${wid} has been *APPROVED*. Check your email: ${rec.email}.`
            : `🎉 Your withdrawal #${wid} has been *APPROVED*. UPI: ${rec.upi}.`,
        parse_mode: "Markdown",
      });

      await rdel(kWithdraw(wid));
    } else if (action === "reject") {
      await TG("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
      await TG("sendMessage", { chat_id: rec.user.id, text: `❌ Your withdrawal #${wid} was *REJECTED*.`, parse_mode: "Markdown" });
      await rdel(kWithdraw(wid));
    }
    return ok();
  }

  return ok();
}

/* ================== WITHDRAW FLOW ================== */
async function handleWithdraw(user, payload) {
  const uid = user.id;
  const bal = parseInt((await rget(kBal(uid))) || "0", 10);
  const amount = payload.amount;
  if (bal < amount) {
    await TG("sendMessage", { chat_id: uid, text: "❗ Insufficient balance.", reply_markup: backBtn });
    return;
  }
  await rset(kBal(uid), String(bal - amount));

  // create record
  const nextId = (await nextSeq(kWithdrawSeq)).toString();
  const record = {
    id: nextId,
    user: { id: uid, name: escapeName(user) },
    amount,
    ...(payload.email ? { email: payload.email } : { upi: payload.upi }),
  };
  await rset(kWithdraw(nextId), JSON.stringify(record));

  // User confirmation (full info to user)
  const youText =
    `✅ Withdraw request received.\n` +
    `ID: ${nextId}\n` +
    (record.email ? `Email: ${record.email}\n` : `UPI: ${record.upi}\n`) +
    `Amount: ${amount}`;
  await TG("sendMessage", { chat_id: uid, text: youText, reply_markup: backBtn });

  // Admin card (full details + Approve/Reject)
  const adminText =
    `💸 *Withdraw Request*\n` +
    `ID: *${nextId}*\n` +
    `User: ${record.user.id} ${record.user.name}\n` +
    (record.email ? `Email: ${record.email}\n` : `UPI: ${record.upi}\n`) +
    `Amount: *${amount}*`;
  const kb = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `w:approve:${nextId}` },
        { text: "❌ Reject", callback_data: `w:reject:${nextId}` },
      ],
    ],
  };
  for (const adm of admins()) {
    TG("sendMessage", { chat_id: adm, text: adminText, parse_mode: "Markdown", reply_markup: kb });
  }
}

/* ================== UTILS ================== */
function admins() {
  return env("ADMIN_IDS")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
function isAdmin(id) {
  return admins().includes(String(id));
}
async function ensureUser(u) {
  const key = kUser(u.id);
  if (!(await rget(key))) {
    await rset(key, JSON.stringify({ name: escapeName(u) }));
    const list = JSON.parse((await rget(kUsers)) || "[]");
    if (!list.includes(String(u.id))) {
      list.push(String(u.id));
      await rset(kUsers, JSON.stringify(list));
    }
  }
}
async function addUserId(uid) {
  const list = JSON.parse((await rget(kUsers)) || "[]");
  if (!list.includes(String(uid))) {
    list.push(String(uid));
    await rset(kUsers, JSON.stringify(list));
  }
}
async function getMe() {
  return fetch(`https://api.telegram.org/bot${env("BOT_TOKEN")}/getMe`).then((r) => r.json());
}
async function nextSeq(key) {
  const res = await fetch(`${env("UPSTASH_REDIS_REST_URL")}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env("UPSTASH_REDIS_REST_TOKEN")}` },
  }).then((r) => r.json());
  return res.result || 1;
}
async function checkAllJoined(userId) {
  for (const c of CHANNELS) {
    // Convert t.me link to @username if possible
    const m = c.url.match(/t\.me\/([a-zA-Z0-9_]+)/);
    if (!m) continue;
    const uname = m[1];
    const j = await fetch(
      `https://api.telegram.org/bot${env("BOT_TOKEN")}/getChatMember?chat_id=@${uname}&user_id=${userId}`
    ).then((r) => r.json());
    if (!j.ok) return { ok: false };
    const st = j.result.status;
    if (!["member", "administrator", "creator"].includes(st)) return { ok: false };
  }
  return { ok: true };
}
function json(o) {
  return new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
}
function ok() {
  return new Response("OK");
}
