// api/telegram.js
// Copy–paste READY. Node (Vercel serverless) handler with Telegram HTTP API + Upstash Redis REST.
//
// ENV needed (Vercel → Settings → Environment Variables):
// BOT_TOKEN, WEBHOOK_SECRET, APP_URL
// UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// ADMIN_ID (numeric, e.g. 1898098929)
//
// NOTE:
// 1) Bot को REQUIRED_CHANNELS व PROOF चैनल में add करें (proof post के लिए bot को channel admin बनाएं).
// 2) Webhook URL: https://<your-app>.vercel.app/api/telegram?secret=<WEBHOOK_SECRET>

export const config = { api: { bodyParser: false } };

// ======= ENV =======
const TOKEN = process.env.BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

// ======= FORCE-JOIN (generic Join buttons, names hidden) =======
const REQUIRED_CHANNELS = [
  { username: "free_redeem_codes_fire_crypto", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { username: "Withdrawal_Proofsj",            url: "https://t.me/Withdrawal_Proofsj" },
  { username: "loot4udeal",                    url: "https://t.me/loot4udeal" }
];

// ======= PROOF channel =======
const PROOF_CHANNEL_USERNAME = "Withdrawal_Proofsj"; // bot must be admin here to post
const PROOF_CHANNEL_LINK = "https://t.me/Withdrawal_Proofsj";

// ======= COINS config (change values if you want) =======
const REF_BONUS_REF = 50;  // referrer gets
const REF_BONUS_NEW = 25;  // new user gets
const DAILY_BONUS = 10;
const MIN_WITHDRAW = 500;

// ======= TELEGRAM HELPERS =======
const TG = {
  api: (method, payload) =>
    fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(r => r.json()),
  answerCb: (id, text, alert = false) =>
    TG.api("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert }),
  send: (chat_id, text, extra = {}) =>
    TG.api("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra }),
  sendTo: (chat, text, extra = {}) => TG.send(chat, text, extra),
  getMember: (chat, user_id) =>
    fetch(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${user_id}`)
      .then(r => r.json()),
};

// ======= REDIS (Upstash REST) helpers =======
async function rget(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json();
  return j.result ?? null;
}
async function rset(key, val) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
}
async function rincrby(key, by = 1) {
  const res = await fetch(`${UPSTASH_URL}/incrby/${encodeURIComponent(key)}/${by}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json();
  return Number(j.result || 0);
}
async function rsadd(key, member) {
  await fetch(`${UPSTASH_URL}/sadd/${encodeURIComponent(key)}/${encodeURIComponent(member)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
}
async function rsmembers(key) {
  const res = await fetch(`${UPSTASH_URL}/smembers/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json();
  return Array.isArray(j.result) ? j.result : [];
}
async function rdel(key) {
  await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
}

// ======= KEYS =======
const k = {
  verified: uid => `verified:${uid}`,              // "1"
  payload:  uid => `payload:${uid}`,               // "ref_<id>"
  coins:    uid => `coins:${uid}`,                 // integer
  credited: uid => `credited:${uid}`,              // "1" once referral paid
  daily:    uid => `daily:${uid}`,                 // YYYY-MM-DD
  users:     () => `users_all`,                    // set of user ids (for broadcast)
  wseq:      () => `w:seq`,                        // numeric counter for withdraw ids
  w:       wid => `w:${wid}`,                      // JSON {uid,name,email,upi,amt,ts,status}
};

// ======= COINS helpers =======
async function getCoins(uid) {
  const v = await rget(k.coins(uid));
  return Number(v || 0);
}
async function addCoins(uid, amt) {
  return rincrby(k.coins(uid), amt);
}

// ======= JOIN-GATE =======
async function isJoinedAll(userId) {
  for (const c of REQUIRED_CHANNELS) {
    const j = await TG.getMember(`@${c.username}`, userId);
    if (!j.ok) return false;
    const st = j.result?.status;
    if (!["creator","administrator","member"].includes(st)) return false;
  }
  return true;
}

function joinGateMarkup() {
  const rows = REQUIRED_CHANNELS.map(c => [{ text: "Join", url: c.url }]);
  rows.unshift([{ text: "Follow Now", url: REQUIRED_CHANNELS[0].url }]);
  rows.push([{ text: "✅ Claim", callback_data: "gate:claim" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function showJoinGate(chatId) {
  const text =
    "😍 Hey !! User Welcome To Bot\n" +
    "🟢 Must Join All Channels To Use Bot\n" +
    "◼️ After joining click <b>Claim</b>";
  return TG.send(chatId, text, joinGateMarkup());
}

// ======= MAIN MENU =======
function mainMenuKb() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📣 Channels", callback_data: "open:channels" }, { text: "📑 Proofs", callback_data: "open:proofs" }],
        [{ text: "💰 Balance", callback_data: "open:balance" }, { text: "🎁 Daily Bonus", callback_data: "open:daily" }],
        [{ text: "👥 Referral", callback_data: "open:ref" }, { text: "💸 Withdraw", callback_data: "open:wd" }],
      ],
    },
  };
}
const backKb = { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back:main" }]] } };

async function sendMainMenu(chatId) {
  const txt = "Welcome Support 🇮🇳👋\nEarn via referrals & daily bonus; redeem by withdraw.";
  return TG.send(chatId, txt, mainMenuKb());
}

// ======= REFERRAL (credit AFTER verify only) =======
async function applyReferralIfAny(uid) {
  const payload = await rget(k.payload(uid));
  if (!payload || !payload.startsWith("ref_")) return;

  const refId = payload.slice(4);
  if (!/^\d+$/.test(refId)) return;
  if (refId === String(uid)) return;

  const already = await rget(k.credited(uid));
  if (already) return;

  await addCoins(uid, REF_BONUS_NEW);
  await addCoins(refId, REF_BONUS_REF);
  await rset(k.credited(uid), "1");
}

// ======= WITHDRAW helpers =======
async function newWithdrawId() {
  const n = await rincrby(k.wseq(), 1);
  return String(n);
}
async function saveWithdraw(wid, obj) {
  await rset(k.w(wid), JSON.stringify(obj));
}
async function loadWithdraw(wid) {
  const v = await rget(k.w(wid));
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}

// ======= ADMIN check =======
function isAdmin(uid) { return ADMIN_ID && Number(uid) === Number(ADMIN_ID); }

// ======= PARSE body =======
async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

// ======= HANDLERS =======
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  // track user for broadcast list
  await rsadd(k.users(), String(uid));

  // store possible referral payload (e.g., "/start ref_123456")
  const parts = (msg.text || "").split(" ");
  const payload = parts[1];
  if (payload) await rset(k.payload(uid), payload);

  const verified = await rget(k.verified(uid));
  if (verified !== "1") {
    // fresh gate (only once until verified)
    const ok = await isJoinedAll(uid);
    if (!ok) return showJoinGate(chatId);
    await rset(k.verified(uid), "1");
    await applyReferralIfAny(uid);
  }
  return sendMainMenu(chatId);
}

async function handleGateClaim(cb) {
  const chatId = cb.message.chat.id;
  const uid = cb.from.id;

  const ok = await isJoinedAll(uid);
  if (!ok) {
    await TG.answerCb(cb.id, "❌ You have not joined all channels.", true);
    return showJoinGate(chatId);
  }
  await rset(k.verified(uid), "1");
  await applyReferralIfAny(uid);

  await TG.answerCb(cb.id, "✅ Verified! Welcome.");
  return sendMainMenu(chatId);
}

async function ensureVerifiedMiddleware(cb) {
  const uid = cb.from.id;
  const chatId = cb.message.chat.id;
  const verified = await rget(k.verified(uid));
  if (verified === "1") return true;

  const ok = await isJoinedAll(uid);
  if (!ok) {
    await TG.answerCb(cb.id, "❗Please join all channels first");
    await showJoinGate(chatId);
    return false;
  }
  await rset(k.verified(uid), "1");
  await applyReferralIfAny(uid);
  return true;
}

async function openSection(section, cb) {
  const chatId = cb.message.chat.id;
  const uid = cb.from.id;

  if (section === "channels") {
    // show generic join UI again (without names)
    return TG.send(chatId, "Required Channels:", {
      reply_markup: {
        inline_keyboard: [
          ...REQUIRED_CHANNELS.map(c => [{ text: "Join", url: c.url }]),
          [{ text: "✅ Claim", callback_data: "gate:claim" }],
          [{ text: "⬅️ Back", callback_data: "back:main" }],
        ],
      },
    });
  }

  if (section === "proofs") {
    return TG.send(chatId, "📑 All withdrawal proofs are posted here:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Open Proof Channel", url: PROOF_CHANNEL_LINK }],
          [{ text: "⬅️ Back", callback_data: "back:main" }],
        ],
      },
    });
  }

  if (section === "balance") {
    const coins = await getCoins(uid);
    const name = cb.from.first_name || "User";
    return TG.send(chatId, `👤 <b>${name}</b>\n💰 Balance: <b>${coins}</b> coins`, backKb);
  }

  if (section === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const last = await rget(k.daily(uid));
    if (last === today) {
      await TG.answerCb(cb.id, "✅ Already claimed today");
      return TG.send(chatId, "🎁 Daily Bonus\nTry again tomorrow.", backKb);
    }
    await rset(k.daily(uid), today);
    const bal = await addCoins(uid, DAILY_BONUS);
    await TG.answerCb(cb.id, `+${DAILY_BONUS} coins added!`);
    return TG.send(chatId, `🎁 Daily Bonus added.\nNew Balance: <b>${bal}</b>`, backKb);
  }

  if (section === "ref") {
    const me = cb.from.id;
    const botInfo = await TG.api("getMe", {});
    const botUser = botInfo?.result?.username || "YourBot";
    const link = `https://t.me/${botUser}?start=ref_${me}`;
    const count = Number(await rget(`ref:${me}`) || 0);
    return TG.send(
      chatId,
      `👥 <b>Referral</b>\n• Your link: <code>${link}</code>\n• You get: +${REF_BONUS_REF}\n• New user gets: +${REF_BONUS_NEW}\n• Joined by you: <b>${count}</b>`,
      backKb
    );
  }

  if (section === "wd") {
    const coins = await getCoins(uid);
    return TG.send(
      chatId,
      [
        "💸 <b>Withdraw</b>",
        `Minimum: <b>${MIN_WITHDRAW}</b> coins`,
        `Your Balance: <b>${coins}</b>`,
        "",
        "Send this command:",
        "<code>/withdraw email@example.com UPI_ID amount</code>",
        "Example:",
        "<code>/withdraw user@mail.com gpay@okicici 500</code>",
      ].join("\n"),
      backKb
    );
  }
}

// ======= WITHDRAW (command) =======
// Format: /withdraw <email> <upi> <amount>
async function handleWithdrawCommand(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const name = msg.from.first_name || "User";
  const parts = (msg.text || "").trim().split(/\s+/);

  if (parts.length < 4) {
    return TG.send(chatId,
      "❗Usage:\n<code>/withdraw email@example.com UPI_ID amount</code>",
      backKb
    );
  }
  const email = parts[1];
  const upi = parts[2];
  const amt = Number(parts[3] || 0);
  if (!email.includes("@") || !upi || !(amt > 0)) {
    return TG.send(chatId, "❌ Invalid format. Example:\n<code>/withdraw user@mail.com gpay@okicici 500</code>", backKb);
  }

  const coins = await getCoins(uid);
  if (coins < amt) return TG.send(chatId, `❌ Not enough balance.\nYour: <b>${coins}</b>`, backKb);
  if (amt < MIN_WITHDRAW) return TG.send(chatId, `❗ Minimum withdraw is <b>${MIN_WITHDRAW}</b>`, backKb);

  // deduct first (hold)
  await addCoins(uid, -amt);

  // create request
  const wid = await newWithdrawId();
  const reqObj = { id: wid, uid, name, email, upi, amt, ts: Date.now(), status: "pending" };
  await saveWithdraw(wid, reqObj);

  // notify user
  await TG.send(chatId, `✅ Withdraw request received.\nID: <b>${wid}</b>\nEmail: <b>${email}</b>\nUPI: <b>${upi}</b>\nAmount: <b>${amt}</b>`, backKb);

  // notify admin with approve/reject buttons
  if (ADMIN_ID) {
    await TG.send(ADMIN_ID, `💸 <b>Withdraw Request</b>\nID: <b>${wid}</b>\nUser: <code>${uid}</code> (${name})\nEmail: <code>${email}</code>\nUPI: <code>${upi}</code>\nAmount: <b>${amt}</b>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Approve", callback_data: `adm:approve:${wid}` }, { text: "❌ Reject", callback_data: `adm:reject:${wid}` }],
        ],
      },
      parse_mode: "HTML",
    });
  }
}

// ======= ADMIN actions =======
async function onAdminApprove(wid) {
  const w = await loadWithdraw(wid);
  if (!w || w.status !== "pending") return;
  w.status = "approved";
  await saveWithdraw(wid, w);

  // post to proof channel
  await TG.send(`@${PROOF_CHANNEL_USERNAME}`,
    `✅ <b>Withdrawal Paid</b>\nID: <b>${w.id}</b>\nUser: <code>${w.uid}</code> (${w.name})\nEmail: <code>${w.email}</code>\nUPI: <code>${w.upi}</code>\nAmount: <b>${w.amt}</b>`,
    {}
  );

  // notify user
  await TG.send(w.uid, `🎉 Your withdrawal <b>#${w.id}</b> has been <b>APPROVED</b>. Check your email: <b>${w.email}</b>.`);
}
async function onAdminReject(wid) {
  const w = await loadWithdraw(wid);
  if (!w || w.status !== "pending") return;
  w.status = "rejected";
  await saveWithdraw(wid, w);

  // refund coins
  await addCoins(w.uid, w.amt);

  await TG.send(w.uid, `🚫 Your withdrawal <b>#${w.id}</b> was <b>REJECTED</b>. Amount <b>${w.amt}</b> refunded to your balance.`);
}

// text admin commands
async function handleAdminCommands(msg) {
  const uid = msg.from.id;
  if (!isAdmin(uid)) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text.startsWith("/add ")) {
    const [, idStr, amtStr] = text.split(/\s+/, 3);
    if (!idStr || !amtStr) return TG.send(chatId, "Usage: /add <user_id> <coins>");
    const amt = Number(amtStr);
    await addCoins(idStr, amt);
    const bal = await getCoins(idStr);
    return TG.send(chatId, `✅ Added ${amt}. New balance of ${idStr}: <b>${bal}</b>`);
  }

  if (text.startsWith("/deduct ")) {
    const [, idStr, amtStr] = text.split(/\s+/, 3);
    if (!idStr || !amtStr) return TG.send(chatId, "Usage: /deduct <user_id> <coins>");
    const amt = Number(amtStr);
    await addCoins(idStr, -amt);
    const bal = await getCoins(idStr);
    return TG.send(chatId, `✅ Deducted ${amt}. New balance of ${idStr}: <b>${bal}</b>`);
  }

  if (text.startsWith("/bal ")) {
    const [, idStr] = text.split(/\s+/, 2);
    const bal = await getCoins(idStr);
    return TG.send(chatId, `👤 ${idStr} → Balance: <b>${bal}</b>`);
  }

  if (text.startsWith("/broadcast ")) {
    const message = text.replace("/broadcast ", "").trim();
    if (!message) return TG.send(chatId, "Usage: /broadcast <message>");
    const users = await rsmembers(k.users());
    const targets = users.slice(0, 200); // safety limit
    for (const u of targets) {
      await TG.send(u, `📣 <b>Broadcast</b>\n${message}`).catch(()=>{});
    }
    return TG.send(chatId, `✅ Broadcast sent to ${targets.length} users.`);
  }

  if (text.startsWith("/help")) {
    return TG.send(chatId, [
      "<b>Admin Commands</b>",
      "/add <user_id> <coins>",
      "/deduct <user_id> <coins>",
      "/bal <user_id>",
      "/broadcast <message>",
    ].join("\n"));
  }
}

// ======= MAIN HANDLER =======
export default async function handler(req, res) {
  // secret check
  const url = new URL(req.url, "http://localhost");
  const s = url.searchParams.get("secret");
  if (SECRET && s !== SECRET) {
    return res.status(401).json({ ok: false, error: "bad secret" });
  }

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, hello: "telegram" });
  }

  const update = await parseBody(req);
  try {
    // message
    if (update.message) {
      const msg = update.message;
      const text = msg.text || "";

      // Admin text commands
      if (isAdmin(msg.from.id) && /^\/(add|deduct|bal|broadcast|help)\b/.test(text)) {
        await handleAdminCommands(msg);
        return res.status(200).json({ ok: true });
      }

      // /start (with optional ref payload "ref_<id>")
      if (text.startsWith("/start")) {
        await handleStart(msg);
        return res.status(200).json({ ok: true });
      }

      // /withdraw <email> <upi> <amount>
      if (text.startsWith("/withdraw")) {
        await handleWithdrawCommand(msg);
        return res.status(200).json({ ok: true });
      }

      // /ping (simple)
      if (text === "/ping") {
        await TG.send(msg.chat.id, "🏓 pong");
        return res.status(200).json({ ok: true });
      }
    }

    // callback queries
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || "";

      // join claim
      if (data === "gate:claim") {
        await handleGateClaim(cb);
        return res.status(200).json({ ok: true });
      }

      // admin inline approve/reject
      if (isAdmin(cb.from.id) && data.startsWith("adm:")) {
        const [, action, wid] = data.split(":");
        if (action === "approve") { await onAdminApprove(wid); await TG.answerCb(cb.id, "Approved"); }
        if (action === "reject")  { await onAdminReject(wid);  await TG.answerCb(cb.id, "Rejected"); }
        return res.status(200).json({ ok: true });
      }

      // gate middleware: block sections until verified
      if (data.startsWith("open:") || data === "back:main") {
        const ok = await ensureVerifiedMiddleware(cb);
        if (!ok) return res.status(200).json({ ok: true });
      }

      if (data.startsWith("open:")) {
        await openSection(data.split(":")[1], cb);
        return res.status(200).json({ ok: true });
      }
      if (data === "back:main") {
        await TG.answerCb(cb.id, "Back");
        await sendMainMenu(cb.message.chat.id);
        return res.status(200).json({ ok: true });
      }
    }

    // ignore others
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("bot error:", e);
    return res.status(200).json({ ok: true }); // prevent Telegram retries
  }
}
