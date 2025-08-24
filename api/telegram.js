// /api/telegram.js
export const config = { runtime: "edge" };

/** ========= ENV ========= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "my-secret";
const APP_URL = process.env.APP_URL; // e.g. https://your-app.vercel.app
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PROOF_CHANNEL = process.env.PROOF_CHANNEL || "@Withdrawal_Proofsj";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => Number(s.trim())).filter(Boolean);
let BOT_USERNAME = process.env.BOT_USERNAME || "";

/** ========= TELEGRAM & REDIS HELPERS ========= */
const tg = async (method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  return res.json();
};

// Upstash REST: /COMMAND/arg1/arg2 …
const r = async (cmd, ...args) => {
  const u = `${REDIS_URL}/${cmd}/${args.map(encodeURIComponent).join("/")}`;
  const res = await fetch(u, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, method: "POST" });
  return res.json();
};
const rGet = async (k) => (await r("get", k))?.result ?? null;
const rSet = async (k, v, exSec) =>
  exSec ? r("setex", k, exSec, typeof v === "string" ? v : JSON.stringify(v)) : r("set", k, typeof v === "string" ? v : JSON.stringify(v));
const rIncrBy = async (k, n) => (await r("incrby", k, n)).result;
const zAdd = async (k, score, member) => r("zadd", k, score, member);
const zRevrangeWithScores = async (k, start, stop) => (await r("zrevrange", k, start, stop, "WITHSCORES")).result || [];

/** ========= CONSTANTS ========= */
const BONUS_COINS = 50;           // daily bonus
const REF_COINS = 100;            // per referral
const MIN_WITHDRAW = 500;         // min coins to withdraw
const JOIN_CACHE_SEC = 0;         // 0 => show join screen on every /start (user request)
const WD_ID_KEY = "wd:id:seq";

/** ========= SMALL UTILS ========= */
const isAdmin = (uid) => ADMIN_IDS.includes(Number(uid));
const nameOf = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || String(u?.id || "");
const esc = (s="") => s.replace(/[<&]/g, c => (c === "<" ? "&lt;" : "&amp;")); // HTML
const maskEmail = (e="") => {
  const [u, d=""] = e.split("@");
  if (!u) return e;
  const keep = Math.max(1, Math.floor(u.length/2));
  return `${u.slice(0, keep)}${"*".repeat(Math.max(1,u.length-keep))}@${d}`;
};
const maskUpi = (id="") => {
  if (id.length <= 6) return id.replace(/.(?=.{2})/g, "*");
  return id.slice(0,3) + "*".repeat(id.length-6) + id.slice(-3);
};
const greet = (from) => `👋 Hello ${esc(nameOf(from))} 🇮🇳`;
const mainTagline = () =>
  `🎯 <b>Main Menu</b>\n` +
  `✨ <i>Invite & earn coins daily</i> — रेफ़रल और डेली बोनस से कमाएँ;\n` +
  `💸 <i>Redeem by Withdraw</i> — विथड्रॉ से रिडीम करें।`;

const kb = (rows) => ({ inline_keyboard: rows });

/** ========= JOIN GATE ========= */
const CHANNELS = [
  { title: "✅ Join free_redeem_codes_fire_crypto", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { title: "✅ Join Withdrawal_Proofsj",            url: "https://t.me/Withdrawal_Proofsj" },
  { title: "✅ Join loot4udeal",                    url: "https://t.me/loot4udeal" },
];

const joinKeyboard = () => kb([
  ...CHANNELS.map(ch => [{ text: ch.title, url: ch.url }]),
  [{ text: "✅ I’ve joined, Continue", callback_data: "recheck_join" }]
]);

const checkJoined = async (uid) => {
  for (const ch of CHANNELS) {
    try {
      const info = await tg("getChat", { chat_id: ch.url });
      if (!info?.ok) return false;
      const m = await tg("getChatMember", { chat_id: ch.url, user_id: uid });
      const st = m?.result?.status;
      if (!st || st === "left" || st === "kicked") return false;
    } catch { return false; }
  }
  return true;
};

const alreadyVerified = async (uid) => JOIN_CACHE_SEC>0 && (await rGet(`joined:${uid}`)) === "1";
const markVerified = async (uid) => JOIN_CACHE_SEC>0 && (await rSet(`joined:${uid}`, "1", JOIN_CACHE_SEC));

/** ========= REDIS KEYS ========= */
const keyCoins = (uid) => `coins:${uid}`;
const keyRefs  = (uid) => `refs:${uid}`;
const keyLastBonus = (uid) => `bonus:last:${uid}`;
const keyState = (uid) => `state:${uid}`;                 // JSON {type:"set_email"|"set_upi"|"wd_amt", method:"email"|"upi"}
const keyEmail = (uid) => `payout:email:${uid}`;
const keyUpi   = (uid) => `payout:upi:${uid}`;
const keyReferredBy = (uid) => `referredby:${uid}`;
const keyName = (uid) => `name:${uid}`;                   // for leaderboard names

/** ========= COMMON SENDERS ========= */
const sendMessage = (chat_id, text, extra={}) => tg("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
const editMessage = (chat_id, message_id, text, extra={}) =>
  tg("editMessageText", { chat_id, message_id, text, parse_mode: "HTML", ...extra });
const answerCb = (id, text, showAlert=false) => tg("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });

/** ========= MENUS ========= */
const mainMenu = () => kb([
  [{ text: "📣 Channels", callback_data: "menu:channels" }, { text: "🧾 Proofs", callback_data: "menu:proofs" }],
  [{ text: "💰 Balance", callback_data: "menu:balance" }, { text: "🎁 Daily Bonus", callback_data: "menu:daily" }],
  [{ text: "👥 Referral", callback_data: "menu:ref" }, { text: "🏧 Withdraw", callback_data: "menu:wd" }],
  [{ text: "🏆 Leaderboard", callback_data: "menu:lb" }]
]);

const backBtn = () => kb([[{ text: "⬅️ Back", callback_data: "menu:home" }]]);
const wdMenuKb = () => kb([
  [{ text: "✉️ Set Email", callback_data: "wd:set:email" }, { text: "🏦 Set UPI", callback_data: "wd:set:upi" }],
  [{ text: "📝 Request Withdraw", callback_data: "wd:req" }],
  [{ text: "⬅️ Back", callback_data: "menu:home" }]
]);

/** ========= WITHDRAW STORE ========= */
const createWithdraw = async (obj) => {
  const id = await rIncrBy(WD_ID_KEY, 1);
  await rSet(`wd:${id}`, { id, ...obj });
  await rSet(`wd:status:${id}`, "pending");
  // queue list
  await r("lpush", "wd:pending", id);
  return id;
};
const readWithdraw = async (id) => {
  const raw = await rGet(`wd:${id}`);
  return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
};

/** ========= ADMIN PANEL ========= */
const adminKb = () => kb([
  [{ text: "⏳ Pending WDs", callback_data: "admin:pending" }],
  [{ text: "➕ Add Coins", callback_data: "admin:add" }, { text: "➖ Remove Coins", callback_data: "admin:sub" }],
  [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }]
]);

const approveRejectKb = (id) => kb([
  [{ text: "✅ Approve", callback_data: `admin:approve:${id}` }, { text: "❌ Reject", callback_data: `admin:reject:${id}` }]
]);

/** ========= HANDLERS ========= */
async function showHome(chat_id, from) {
  await rSet(keyName(from.id), nameOf(from)); // keep fresh for leaderboard
  return sendMessage(chat_id, `${greet(from)}\n\n${mainTagline()}`, { reply_markup: mainMenu() });
}

async function handleStart(msg) {
  const from = msg.from, uid = from.id, chat_id = msg.chat.id;

  // REFERRAL
  const text = msg.text || "";
  const payload = text.split(" ")[1];
  if (payload && Number(payload) && Number(payload) !== uid) {
    const had = await rGet(keyReferredBy(uid));
    if (!had) {
      await rSet(keyReferredBy(uid), String(payload));
      await rIncrBy(keyRefs(payload), 1);
      await zAdd("lb:refs", await rGet(keyRefs(payload)) || 1, String(payload));
      await rIncrBy(keyCoins(payload), REF_COINS);
      // notify referrer
      try { await sendMessage(payload, `🎉 <b>New referral!</b>\n👤 ${esc(nameOf(from))} joined using your link.\n➕ You got <b>${REF_COINS}</b> coins.`); } catch {}
    }
  }

  // JOIN screen only on /start (not cached as requested)
  if (!isAdmin(uid)) {
    const ok = await checkJoined(uid);
    if (!ok) {
      return sendMessage(chat_id, `${greet(from)}\n\n🔐 <b>Join all channels to continue.</b>\nसबसे पहले सभी चैनल Join करें, फिर नीचे <b>I’ve joined</b> दबाएँ।`, {
        reply_markup: joinKeyboard()
      });
    }
    if (JOIN_CACHE_SEC>0) await markVerified(uid);
  }

  return showHome(chat_id, from);
}

async function handleMenu(data, ctx) {
  const { message, from, id: cbid } = ctx;
  const chat_id = message.chat.id;
  const mid = message.message_id;
  const uid = from.id;

  switch (data) {
    case "menu:home": return editMessage(chat_id, mid, `${greet(from)}\n\n${mainTagline()}`, { reply_markup: mainMenu() });

    case "menu:channels":
      return editMessage(chat_id, mid, `${greet(from)}\n\n📣 <b>Required Channels</b>\nकृपया सभी चैनल join रखें।`, { reply_markup: joinKeyboard() });

    case "menu:proofs":
      return editMessage(chat_id, mid, `${greet(from)}\n\n🧾 <b>Proof Channel</b>\n✅ Approved withdrawals यहाँ देखिए।`, {
        reply_markup: kb([[{ text: "🔗 Open Proofs", url: `https://t.me/${PROOF_CHANNEL.replace("@","")}` }], [{ text: "⬅️ Back", callback_data: "menu:home" }]])
      });

    case "menu:balance": {
      const coins = Number(await rGet(keyCoins(uid)) || 0);
      const refs  = Number(await rGet(keyRefs(uid))  || 0);
      return editMessage(chat_id, mid, `${greet(from)}\n\n💰 <b>Your Balance</b>\n• Coins: <b>${coins}</b>\n• Referrals: <b>${refs}</b>`, { reply_markup: backBtn() });
    }

    case "menu:daily": {
      const now = Date.now();
      const last = Number(await rGet(keyLastBonus(uid)) || 0);
      if (now - last < 24*60*60*1000) {
        const left = Math.ceil((24*60*60*1000 - (now-last))/3600000);
        await answerCb(cbid, `⏳ Bonus already claimed. Try again in ~${left}h.`);
        return;
      }
      await rSet(keyLastBonus(uid), String(now));
      await rIncrBy(keyCoins(uid), BONUS_COINS);
      return editMessage(chat_id, mid, `${greet(from)}\n\n🎁 <b>Daily Bonus</b>\nYou received <b>${BONUS_COINS}</b> coins. Come back tomorrow!`, { reply_markup: backBtn() });
    }

    case "menu:ref": {
      if (!BOT_USERNAME) {
        const me = await tg("getMe");
        BOT_USERNAME = me?.result?.username || BOT_USERNAME;
      }
      const link = `https://t.me/${BOT_USERNAME}?start=${uid}`;
      const refs = Number(await rGet(keyRefs(uid)) || 0);
      return editMessage(chat_id, mid,
        `${greet(from)}\n\n👥 <b>Referral</b>\n` +
        `🔗 Share your link:\n${esc(link)}\n` +
        `🎯 Current refs: <b>${refs}</b>\n` +
        `💡 प्रत्येक valid join पर <b>${REF_COINS}</b> coins मिलेंगे।`, { reply_markup: backBtn() });
    }

    case "menu:lb": {
      const arr = await zRevrangeWithScores("lb:refs", 0, 9); // [member, score, member, score, ...]
      let out = `🏆 <b>Leaderboard</b>\n`;
      for (let i=0; i<arr.length; i+=2) {
        const uidTop = arr[i], score = arr[i+1];
        const nm = (await rGet(keyName(uidTop))) || uidTop;
        out += `${(i/2)+1}. ${esc(nm)} — <b>${score}</b> refs\n`;
      }
      if (arr.length===0) out += `No data yet. Be the first!`;
      return editMessage(chat_id, mid, `${greet(from)}\n\n${out}`, { reply_markup: backBtn() });
    }

    case "menu:wd": {
      const email = await rGet(keyEmail(uid));
      const upi   = await rGet(keyUpi(uid));
      const info = [
        email ? `✉️ Email set: <code>${esc(email)}</code>` : "✉️ Email not set",
        upi   ? `🏦 UPI set: <code>${esc(upi)}</code>`     : "🏦 UPI not set",
        `⚠️ Only one payout method should be set (Email <i>or</i> UPI).`
      ].join("\n");
      return editMessage(chat_id, mid, `${greet(from)}\n\n💸 <b>Withdraw</b>\n${info}\n\n🧭 Steps: Set payout → Request withdraw.`, { reply_markup: wdMenuKb() });
    }

    default: return;
  }
}

async function handleWd(data, ctx) {
  const { message, from, id: cbid } = ctx;
  const chat_id = message.chat.id, mid = message.message_id, uid = from.id;

  if (data === "wd:set:email") {
    await rSet(keyState(uid), JSON.stringify({ type: "set_email" }), 300);
    return editMessage(chat_id, mid, `${greet(from)}\n\n✉️ <b>Send your email now.</b>\nएक मान्य Gmail/Email भेजें।`, { reply_markup: backBtn() });
  }
  if (data === "wd:set:upi") {
    await rSet(keyState(uid), JSON.stringify({ type: "set_upi" }), 300);
    return editMessage(chat_id, mid, `${greet(from)}\n\n🏦 <b>Send your UPI ID now.</b>\nजैसे: <code>yourname@bank</code>`, { reply_markup: backBtn() });
  }
  if (data === "wd:req") {
    const email = await rGet(keyEmail(uid));
    const upi   = await rGet(keyUpi(uid));
    if (!!email === !!upi) { // both set or none
      await answerCb(cbid, "⚠️ Set exactly one payout method (Email or UPI).");
      return;
    }
    await rSet(keyState(uid), JSON.stringify({ type: "wd_amt", method: email ? "email" : "upi" }), 300);
    return editMessage(chat_id, mid,
      `${greet(from)}\n\n📝 <b>Enter amount</b>\nMinimum: <b>${MIN_WITHDRAW}</b> coins.\nAmount भेजें।`, { reply_markup: backBtn() });
  }
}

/** ========= TEXT STATES (SETTINGS / WD) ========= */
async function handleTextInState(msg) {
  const uid = msg.from.id, name = nameOf(msg.from), chat_id = msg.chat.id;
  const stRaw = await rGet(keyState(uid));
  if (!stRaw) return false; // no state
  const st = typeof stRaw === "string" ? JSON.parse(stRaw) : stRaw;
  const text = (msg.text || "").trim();

  if (st.type === "set_email") {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (!ok) return sendMessage(chat_id, `${greet(msg.from)}\n\n❌ Invalid email. Try again.`, { reply_markup: backBtn() });
    await rSet(keyEmail(uid), text);
    await r("del", keyUpi(uid)); // ensure only one method
    await r("del", keyState(uid));
    return sendMessage(chat_id, `${greet(msg.from)}\n\n✅ Email saved: <code>${esc(text)}</code>\nअब <b>Withdraw → Request Withdraw</b> करें।`, { reply_markup: backBtn() });
  }

  if (st.type === "set_upi") {
    const ok = /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(text);
    if (!ok) return sendMessage(chat_id, `${greet(msg.from)}\n\n❌ Invalid UPI ID. Try again.`, { reply_markup: backBtn() });
    await rSet(keyUpi(uid), text);
    await r("del", keyEmail(uid));
    await r("del", keyState(uid));
    return sendMessage(chat_id, `${greet(msg.from)}\n\n✅ UPI saved: <code>${esc(text)}</code>\nअब <b>Withdraw → Request Withdraw</b> करें।`, { reply_markup: backBtn() });
  }

  if (st.type === "wd_amt") {
    const amt = Number(text);
    if (!Number.isFinite(amt) || amt < MIN_WITHDRAW) {
      return sendMessage(chat_id, `${greet(msg.from)}\n\n⚠️ Minimum <b>${MIN_WITHDRAW}</b> coins. Valid amount भेजें।`, { reply_markup: backBtn() });
    }
    const coins = Number(await rGet(keyCoins(uid)) || 0);
    if (coins < amt) {
      return sendMessage(chat_id, `${greet(msg.from)}\n\n❌ Not enough balance. Your coins: <b>${coins}</b>.`, { reply_markup: backBtn() });
    }
    await rIncrBy(keyCoins(uid), -amt);
    const method = st.method;
    const email = await rGet(keyEmail(uid));
    const upi   = await rGet(keyUpi(uid));

    const id = await createWithdraw({
      uid, name, method,
      email: email || null,
      upi: upi || null,
      amount: amt,
      ts: Date.now()
    });

    await r("del", keyState(uid));

    // User receipt
    const rec = [
      `✅ <b>Withdraw request received.</b>`,
      `ID: <b>${id}</b>`,
      method === "email" ? `Email: <code>${esc(email)}</code>` : `UPI: <code>${esc(upi)}</code>`,
      `Amount: <b>${amt}</b>`
    ].join("\n");
    await sendMessage(chat_id, `${greet(msg.from)}\n\n${rec}`, { reply_markup: backBtn() });

    // Admin notify
    const adminText = [
      `💸 <b>Withdraw Request</b>`,
      `ID: <b>${id}</b>`,
      `User: <b>${esc(String(uid))}</b> (${esc(name)})`,
      `Email: ${email ? `<code>${esc(email)}</code>` : "-"}`,
      `UPI: ${upi ? `<code>${esc(upi)}</code>` : "-"}`,
      `Amount: <b>${amt}</b>`
    ].join("\n");
    for (const A of ADMIN_IDS) {
      try { await sendMessage(A, adminText, { reply_markup: approveRejectKb(id) }); } catch {}
    }

    return true;
  }

  return false;
}

/** ========= ADMIN CALLBACKS ========= */
async function handleAdminCb(data, ctx) {
  const { from, id: cbid, message } = ctx;
  if (!isAdmin(from.id)) return answerCb(cbid, "Not allowed.");

  const chat_id = message.chat.id, mid = message.message_id;

  if (data === "admin:pending") {
    const count = Number((await r("llen", "wd:pending")).result || 0);
    if (!count) return editMessage(chat_id, mid, `🗂️ No pending withdrawals.`, { reply_markup: adminKb() });

    const ids = (await r("lrange", "wd:pending", 0, 9)).result || [];
    let txt = `⏳ <b>Pending Withdrawals</b>\n`;
    for (const id of ids) {
      const w = await readWithdraw(id);
      if (!w) continue;
      txt += `• <b>#${id}</b> — ${esc(w.name)} — ${w.method === "email" ? "Email" : "UPI"} — <b>${w.amount}</b>\n`;
    }
    return editMessage(chat_id, mid, txt, { reply_markup: adminKb() });
  }

  if (data === "admin:add" || data === "admin:sub") {
    await rSet(keyState(from.id), JSON.stringify({ type: data === "admin:add" ? "adm_add" : "adm_sub" }), 120);
    return editMessage(chat_id, mid, `Send: <code>userId amount</code>`, { reply_markup: adminKb() });
  }

  if (data === "admin:broadcast") {
    await rSet(keyState(from.id), JSON.stringify({ type: "adm_bc" }), 300);
    return editMessage(chat_id, mid, `Send message to broadcast to all known users (we’ll send to users seen in Name map).`, { reply_markup: adminKb() });
  }

  const [_, action, idStr] = data.split(":"); // approve:ID or reject:ID
  const id = Number(idStr);
  if (action === "approve" || action === "reject") {
    const w = await readWithdraw(id);
    if (!w) return answerCb(cbid, "Not found.");

    // remove from pending queue (best-effort)
    await r("lrem", "wd:pending", 0, String(id));
    await rSet(`wd:status:${id}`, action);

    // notify user
    if (action === "approve") {
      const userNote = w.method === "email"
        ? `🎉 Your withdrawal #${id} has been <b>APPROVED</b>.\nCheck your email: <code>${esc(w.email)}</code>.`
        : `🎉 Your withdrawal #${id} has been <b>APPROVED</b>.\nSent to UPI: <code>${esc(w.upi)}</code>.`;
      await sendMessage(w.uid, userNote);

      // post to Proof channel (masked)
      const masked = w.method === "email" ? maskEmail(w.email) : maskUpi(w.upi);
      const proofText = [
        `✅ <b>Withdrawal Paid</b>`,
        `ID: <b>${id}</b>`,
        `User: ${esc(w.name)}`,
        w.method === "email" ? `Email: <code>${esc(masked)}</code>` : `UPI: <code>${esc(masked)}</code>`,
        `Amount: <b>${w.amount}</b>`
      ].join("\n");
      try { await sendMessage(PROOF_CHANNEL, proofText); } catch {}
      await answerCb(cbid, "Approved ✅");
    } else {
      await sendMessage(w.uid, `❌ Your withdrawal #${id} has been <b>REJECTED</b>. Coins refunded.`);
      await rIncrBy(keyCoins(w.uid), w.amount); // refund
      await answerCb(cbid, "Rejected ❌");
    }

    // update the admin message
    const adminNew = [
      `${action === "approve" ? "✅" : "❌"} <b>Processed</b>`,
      `ID: <b>${id}</b>`,
      `User: ${esc(String(w.uid))} (${esc(w.name)})`,
      `Email: ${w.email ? `<code>${esc(w.email)}</code>` : "-"}`,
      `UPI: ${w.upi ? `<code>${esc(w.upi)}</code>` : "-"}`,
      `Amount: <b>${w.amount}</b>`
    ].join("\n");
    try { await editMessage(chat_id, mid, adminNew, { reply_markup: adminKb() }); } catch {}
    return;
  }
}

/** ========= ADMIN TEXT STATES ========= */
async function handleAdminTextState(msg) {
  if (!isAdmin(msg.from.id)) return false;
  const sraw = await rGet(keyState(msg.from.id));
  if (!sraw) return false;
  const st = typeof sraw === "string" ? JSON.parse(sraw) : sraw;
  const text = (msg.text || "").trim();

  if (st.type === "adm_add" || st.type === "adm_sub") {
    const [idStr, amtStr] = text.split(/\s+/);
    const uid = Number(idStr), amt = Number(amtStr);
    if (!uid || !Number.isFinite(amt)) {
      await sendMessage(msg.chat.id, `Format: <code>userId amount</code>`);
      return true;
    }
    await rIncrBy(keyCoins(uid), st.type === "adm_add" ? amt : -amt);
    await r("del", keyState(msg.from.id));
    await sendMessage(msg.chat.id, `Done. User ${uid} => ${st.type === "adm_add" ? "+" : "-"}${amt} coins.`);
    return true;
  }

  if (st.type === "adm_bc") {
    await r("del", keyState(msg.from.id));
    // naive broadcast to known users in name map keys
    const scan = await r("keys", "name:*");
    const users = scan?.result || [];
    let ok = 0;
    for (const k of users) {
      const uid = k.split(":")[1];
      try { await sendMessage(uid, `📢 <b>Broadcast</b>\n${esc(text)}`); ok++; } catch {}
    }
    await sendMessage(msg.chat.id, `Broadcast sent to ${ok} users.`);
    return true;
  }

  return false;
}

/** ========= MAIN HANDLER ========= */
export default async function handler(req) {
  // health / webhook setter
  const url = new URL(req.url);
  if (url.searchParams.get("hello") === "telegram") {
    return new Response(JSON.stringify({ ok: true, hello: "telegram" }), { headers: { "content-type": "application/json" } });
  }
  if (url.searchParams.get("secret") === WEBHOOK_SECRET && req.method === "GET") {
    const set = await tg("setWebhook", { url: `${APP_URL}/api/telegram?secret=${WEBHOOK_SECRET}` });
    return new Response(JSON.stringify({ ok: true, set_to: `${APP_URL}/api/telegram?secret=${WEBHOOK_SECRET}`, telegram: set }), { headers: { "content-type": "application/json" } });
    }

  if (req.method !== "POST") return new Response("OK");

  const update = await req.json();
  try {
    if (update.message) {
      const m = update.message;

      // Admin command
      if ((m.text || "").startsWith("/admin") && isAdmin(m.from.id)) {
        await sendMessage(m.chat.id, `🛠️ <b>Admin Panel</b>`, { reply_markup: adminKb() });
        return new Response("OK");
      }

      // /start
      if ((m.text || "").startsWith("/start")) {
        await handleStart(m);
        return new Response("OK");
      }

      // text states (user/admin)
      if (await handleAdminTextState(m)) return new Response("OK");
      if (await handleTextInState(m)) return new Response("OK");

      // fallback: show home
      await showHome(m.chat.id, m.from);
    }

    if (update.callback_query) {
      const ctx = {
        id: update.callback_query.id,
        from: update.callback_query.from,
        data: update.callback_query.data,
        message: update.callback_query.message
      };

      if (ctx.data?.startsWith("menu:")) {
        await handleMenu(ctx.data, ctx);
        return new Response("OK");
      }
      if (ctx.data?.startsWith("wd:")) {
        await handleWd(ctx.data, ctx);
        return new Response("OK");
      }
      if (ctx.data?.startsWith("admin:")) {
        await handleAdminCb(ctx.data, ctx);
        return new Response("OK");
      }

      await answerCb(ctx.id, "OK");
    }
  } catch (e) {
    console.log("ERR", e);
  }

  return new Response("OK");
                            }
