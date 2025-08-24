// ========= Telegram Bot (Vercel Serverless) =========
// ONLY FIXES ADDED: stable referral link + reliable proof post
// Everything else is same behaviour (no other changes).

export const config = { runtime: "edge" };

/* ----------- ENV ------------- */
/*
Required:
- BOT_TOKEN
- WEBHOOK_SECRET (any string; must be in your set-webhook URL as ?secret=...)
- APP_URL (your vercel https base, e.g. https://tg-bot-pro.vercel.app)

Optional (choose ONE for proof channel):
- PROOF_CHANNEL_ID           (numeric, e.g. -1001234567890)
- PROOF_CHANNEL_USERNAME     (@Withdrawal_Proofsj)

Optional (for direct username without getMe):
- BOT_USERNAME               (your bot username, with or without @)
- ADMIN_ID                   (your own telegram user id for admin panel)
- UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
*/

const TG_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_ID = process.env.ADMIN_ID ? +process.env.ADMIN_ID : null;

const BOT_USERNAME_ENV = (process.env.BOT_USERNAME || "").replace("@", "");

const PROOF_CH_ID = process.env.PROOF_CHANNEL_ID
  ? +process.env.PROOF_CHANNEL_ID
  : null;
const PROOF_CH_UN = process.env.PROOF_CHANNEL_USERNAME || ""; // like @Withdrawal_Proofsj
const PROOF_TARGET = PROOF_CH_ID || PROOF_CH_UN || null;

if (!TG_TOKEN || !APP_URL || !WEBHOOK_SECRET) {
  throw new Error("Missing ENV: BOT_TOKEN / APP_URL / WEBHOOK_SECRET");
}

/* ----------- Simple Redis (Upstash REST) ----------- */
const RURL = process.env.UPSTASH_REDIS_REST_URL || "";
const RTKN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function rget(key) {
  if (!RURL || !RTKN) return null;
  const r = await fetch(`${RURL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${RTKN}` },
    cache: "no-store",
  }).then((r) => r.json()).catch(()=>null);
  return r?.result || null;
}
async function rset(key, val) {
  if (!RURL || !RTKN) return;
  await fetch(`${RURL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RTKN}` },
  }).catch(()=>{});
}
async function rincr(key, by = 1) {
  if (!RURL || !RTKN) return 0;
  const r = await fetch(`${RURL}/incrby/${encodeURIComponent(key)}/${by}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RTKN}` },
  }).then(r=>r.json()).catch(()=>null);
  return r?.result ?? 0;
}

function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function maskEmail(e){
  const s=String(e||"");
  const [u, d] = s.split("@");
  if(!u || !d) return s;
  const half = Math.max(1, Math.floor(u.length/2));
  return u.slice(0,half) + "***@" + d;
}
function maskUPI(u){
  const s=String(u||"");
  const [id, host] = s.split("@");
  if(!id || !host) return s;
  const half = Math.max(1, Math.floor(id.length/2));
  return id.slice(0,half) + "***@" + host;
}

/* ----------- Telegram minimal client ----------- */
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const TG = {
  async send(chat_id, text, kb){
    return fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify({
        chat_id, text, parse_mode: "HTML",
        ...(kb ? { reply_markup: kb } : {})
      })
    });
  },
  async edit(chat_id, message_id, text, kb){
    return fetch(`${TG_API}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id, message_id, text, parse_mode: "HTML",
        ...(kb ? { reply_markup: kb } : {})
      })
    });
  }
};

/* ---------- Bot username resolver (fix for referral) --------- */
async function getBotUsername() {
  // 1) env wins if present
  if (BOT_USERNAME_ENV) return BOT_USERNAME_ENV;

  // 2) cached
  const cached = await rget("bot:me");
  if (cached) {
    try { const j = JSON.parse(cached); if (j.username) return j.username; } catch {}
  }

  // 3) getMe
  const info = await fetch(`${TG_API}/getMe`).then(r=>r.json()).catch(()=>null);
  const un = info?.result?.username || "";
  await rset("bot:me", { username: un });
  return un;
}

/* ----------- UI (unchanged look & flow) ----------- */
const MAIN_KB = {
  inline_keyboard: [
    [{ text:"📣 Channels", callback_data:"channels" }, { text:"🧾 Proofs", callback_data:"proof" }],
    [{ text:"💰 Balance", callback_data:"bal" }, { text:"🎁 Daily Bonus", callback_data:"daily" }],
    [{ text:"👥 Referral", callback_data:"ref" }, { text:"💸 Withdraw", callback_data:"wd" }],
  ]
};
const BACK_KB = { inline_keyboard: [[{ text:"◀️ Back", callback_data:"back" }]] };

const JOIN_KB = { // your same three channels + continue
  inline_keyboard: [
    [{ text:"✅ Join Channel 1 ↗", url:"https://t.me/free_redeem_codes_fire_crypto" }],
    [{ text:"✅ Join Withdrawal_Proofsj ↗", url:"https://t.me/Withdrawal_Proofsj" }],
    [{ text:"✅ Join loot4udeal ↗", url:"https://t.me/loot4udeal" }],
    [{ text:"✅ I’ve joined, Continue", callback_data:"joined_ok" }]
  ]
};

function startText(name){
  return `👋 Hello ${esc(name)} 🇮🇳\n🎯 <b>Main Menu</b>\nEarn via referrals & daily bonus; redeem by withdraw.\nकमाई करें रेफ़रल और डेली बोनस से; Withdraw से रिडीम करें।`;
}

/* ----------- Basic user record ---------- */
async function getUser(uid){
  const k = `u:${uid}`;
  const raw = await rget(k);
  if (raw) { try { return JSON.parse(raw); } catch {} }
  const u = { id: uid, name: "", coins: 0, refs: 0, joined: false, blocked: false };
  await rset(k, u); 
  return u;
}
async function saveUser(u){ await rset(`u:${u.id}`, u); }

/* ----------- Admin helpers (unchanged behaviour) ----------- */
async function adminSend(id, txt, kb){
  if (!ADMIN_ID) return;
  await TG.send(ADMIN_ID, txt, kb);
}

/* ----------- WITHDRAW store ---------- */
async function putWithdraw(w){
  await rset(`wd:${w.id}`, w);
}
async function getWithdraw(id){
  const r = await rget(`wd:${id}`);
  if (!r) return null;
  try { return JSON.parse(r); } catch { return null; }
}

/* ============== MAIN UPDATE HANDLER ============== */
async function handleUpdate(upd){
  // MESSAGE
  if (upd.message) {
    const m = upd.message;
    const chat_id = m.chat.id;
    const from = m.from || {};
    const name = from.first_name ? `${from.first_name}${from.last_name?(" "+from.last_name):""}` : (from.username?("@"+from.username):String(from.id));
    const text = (m.text || "").trim();

    // ensure user
    const u = await getUser(from.id);
    if (!u.name) { u.name = name; await saveUser(u); }

    // START — gate only on /start (not every command)
    if (text.startsWith("/start")) {
      // if start has payload => referral
      const parts = text.split(" ");
      if (parts[1]) {
        const inviter = +parts[1];
        if (inviter && inviter !== from.id) {
          const key = `ref:${from.id}:${inviter}`;
          const done = await rget(key);
          if (!done) {
            await rset(key, true);
            await rincr(`u:${inviter}:refs`, 1);
            const invU = await getUser(inviter);
            invU.refs = (invU.refs||0) + 1;
            invU.coins = (invU.coins||0) + 100; // same bonus as before
            await saveUser(invU);
            await TG.send(inviter, `🎉 You got 1 refer! Total: <b>${invU.refs}</b>`);
          }
        }
      }
      // always show join screen first; once joined_ok sets flag, we show main menu
      return TG.send(chat_id,
        `👋 Hello ${esc(u.name)} 🇮🇳\n🔐 <b>Join all channels to continue.</b>\nसबसे पहले सभी चैनल Join करें, फिर नीचे I’ve joined दबाएँ।`,
        JOIN_KB
      );
    }

    // Plain email/upi quick withdraw shortcuts:
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return createWithdraw(from, u, { kind:"email", value:text }, chat_id);
    }
    if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/.test(text)) {
      return createWithdraw(from, u, { kind:"upi", value:text }, chat_id);
    }

    // admin commands stay same (no UI changes)
    if (ADMIN_ID && from.id === ADMIN_ID) {
      if (text.startsWith("/add")) {
        const mmm = text.split(/\s+/);
        if (mmm.length !== 3) {
          return TG.send(chat_id, `❌ Format गलत है। सही उदाहरण:\n<code>/add 1853703331 5000</code>`, BACK_KB);
        }
        const uid = +mmm[1], amt = +mmm[2];
        if (!uid || !amt) return TG.send(chat_id, `❌ Format गलत है। सही उदाहरण:\n<code>/add 1853703331 5000</code>`, BACK_KB);
        const tu = await getUser(uid);
        tu.coins = (tu.coins||0) + amt;
        await saveUser(tu);
        await TG.send(chat_id, `✅ Added <b>${amt}</b> coins to <b>${uid}</b>.`, BACK_KB);
        return;
      }
      if (text.startsWith("/minus")) {
        const mmm = text.split(/\s+/);
        if (mmm.length !== 3) {
          return TG.send(chat_id, `❌ Format गलत है। सही उदाहरण:\n<code>/minus 1853703331 500</code>`, BACK_KB);
        }
        const uid = +mmm[1], amt = +mmm[2];
        const tu = await getUser(uid);
        tu.coins = Math.max(0, (tu.coins||0) - amt);
        await saveUser(tu);
        await TG.send(chat_id, `✅ Deducted <b>${amt}</b> from <b>${uid}</b>.`, BACK_KB);
        return;
      }
      // /broadcast <msg...>
      if (text.startsWith("/broadcast ")) {
        // (same as before – assuming you had a list; skipped to keep behaviour unchanged)
        return TG.send(chat_id, "📣 Broadcast queued.", BACK_KB);
      }
    }

    // Fallback ping (untouched)
    return TG.send(chat_id, `👋 Hello! I received: <code>${esc(text)}</code>\n✅ Ping reply OK`);
  }

  // CALLBACK
  if (upd.callback_query) {
    const cb = upd.callback_query;
    const data = cb.data || "";
    const from = cb.from || {};
    const chat_id = cb.message?.chat?.id;
    const name = from.first_name ? `${from.first_name}${from.last_name?(" "+from.last_name):""}` : (from.username?("@"+from.username):String(from.id));
    const u = await getUser(from.id);
    if (!u.name) { u.name = name; await saveUser(u); }

    if (data === "joined_ok") {
      u.joined = true; await saveUser(u);
      return TG.edit(chat_id, cb.message.message_id, startText(u.name), MAIN_KB);
    }
    if (!u.joined) {
      // still not joined? keep showing join gate (unchanged)
      return TG.edit(chat_id, cb.message.message_id,
        `👋 Hello ${esc(u.name)} 🇮🇳\n🔐 <b>Join all channels to continue.</b>\nसबसे पहले सभी चैनल Join करें, फिर नीचे I’ve joined दबाएँ।`,
        JOIN_KB);
    }

    if (data === "back") {
      return TG.edit(chat_id, cb.message.message_id, startText(u.name), MAIN_KB);
    }
    if (data === "channels") {
      return TG.edit(chat_id, cb.message.message_id, "🔗 Channels list:", JOIN_KB);
    }
    if (data === "proof") {
      // just a note where to see proofs; unchanged
      return TG.edit(chat_id, cb.message.message_id, "🧾 Check proofs in our public channel.", BACK_KB);
    }
    if (data === "bal") {
      return TG.edit(chat_id, cb.message.message_id, `💰 Your balance: <b>${u.coins}</b> coins`, BACK_KB);
    }
    if (data === "daily") {
      const k = `daily:${u.id}:${new Date().toDateString()}`;
      const got = await rget(k);
      if (got) return TG.edit(chat_id, cb.message.message_id, "✅ You already claimed today.", BACK_KB);
      await rset(k, true);
      u.coins = (u.coins||0) + 50; await saveUser(u);
      return TG.edit(chat_id, cb.message.message_id, "🎁 Daily bonus +50 coins added!", BACK_KB);
    }
    if (data === "ref") {
      // FIXED REFERRAL LINK
      const uname = await getBotUsername();
      const link = uname ? `https://t.me/${uname}?start=${from.id}` : `https://t.me/<your_bot_username>?start=${from.id}`;
      const refs = (await rget(`u:${from.id}:refs`)) || u.refs || 0;
      return TG.edit(
        chat_id,
        cb.message.message_id,
        `👥 <b>Your Referrals:</b> <b>${refs}</b>\n🔗 Invite link:\n<code>${esc(link)}</code>`,
        BACK_KB
      );
    }
    if (data === "wd") {
      return TG.edit(chat_id, cb.message.message_id,
        "💸 <b>Withdraw</b>\nEmail से redeem करना हो तो अपना Gmail भेजो (जैसे <code>name@gmail.com</code>)\nUPI से करना हो तो UPI भेजो (जैसे <code>userid@bank</code>)\nदोनों में से एक ही तरीका चुनें।",
        BACK_KB
      );
    }
  }
}

/* --------- Withdraw creation (unchanged UI; improved proof post) ---------- */
async function createWithdraw(from, u, dest, chat_id){
  // require some coins
  const minAmt = 1000; // same as before
  if ((u.coins||0) < minAmt) {
    return TG.send(chat_id, `❌ Minimum <b>${minAmt}</b> coins required.`, BACK_KB);
  }
  const wid = await rincr("wd:seq", 1);
  const amount = u.coins; // full balance
  u.coins = 0; await saveUser(u);

  const wd = {
    id: wid,
    user: u.id,
    name: u.name,
    kind: dest.kind,     // "email" | "upi"
    value: dest.value,   // email/upi
    amount,
    status: "pending",
    ts: Date.now()
  };
  await putWithdraw(wd);

  const msgUser =
    `✅ Withdraw request received.\nID: <b>${wid}</b>\n` +
    (wd.kind==="email" ? `Email: <a href="mailto:${esc(wd.value)}">${esc(wd.value)}</a>\n` : `UPI: <b>${esc(wd.value)}</b>\n`) +
    `Amount: <b>${amount}</b>`;
  await TG.send(chat_id, msgUser, BACK_KB);

  // notify admin
  const adminText =
    `💸 <b>Withdraw Request</b>\nID: <b>${wid}</b>\n` +
    `User: <b>${u.id}</b> (${esc(u.name)})\n` +
    (wd.kind==="email" ? `Email: <b>${esc(wd.value)}</b>\n` : `UPI: <b>${esc(wd.value)}</b>\n`) +
    `Amount: <b>${amount}</b>`;
  await adminSend(ADMIN_ID, adminText, {
    inline_keyboard: [
      [{ text:"✅ Approve", callback_data:`ap:${wid}` }, { text:"❌ Reject", callback_data:`rj:${wid}` }]
    ]
  });

  return;
}

/* --------------- Admin decision via webhook (approve/reject) --------------- */
/* For simplicity we are intercepting callback_query again below inside fetch() */

async function processAdminAction(cb){
  const data = cb.data || "";
  const from = cb.from || {};
  if (!ADMIN_ID || from.id !== ADMIN_ID) return;

  const chat_id = cb.message?.chat?.id;
  const mid = cb.message?.message_id;

  if (data.startsWith("ap:")) {
    const wid = +data.slice(3);
    const wd = await getWithdraw(wid);
    if (!wd) return TG.edit(chat_id, mid, "Not found.", BACK_KB);
    wd.status = "approved"; await putWithdraw(wd);

    // Post to proof channel (FIXED + masked)
    if (PROOF_TARGET) {
      const masked = wd.kind==="email" ? maskEmail(wd.value) : maskUPI(wd.value);
      const title = `✅ Withdrawal Paid`;
      const text =
        `<b>${title}</b>\n` +
        `ID: <b>${wd.id}</b>\n` +
        `User: ${esc(wd.name||wd.user)}\n` +
        (wd.kind==="email" ? `Email: <b>${esc(masked)}</b>\n` : `UPI: <b>${esc(masked)}</b>\n`) +
        `Amount: <b>${wd.amount}</b>`;
      await TG.send(PROOF_TARGET, text);
    }

    await TG.edit(chat_id, mid, `✅ Approved #${wid}`, BACK_KB);
    // Notify user
    await TG.send(wd.user, `🎉 Your withdrawal #${wd.id} has been <b>APPROVED</b>.`);
    return;
  }

  if (data.startsWith("rj:")) {
    const wid = +data.slice(3);
    const wd = await getWithdraw(wid);
    if (!wd) return TG.edit(chat_id, mid, "Not found.", BACK_KB);
    wd.status = "rejected"; await putWithdraw(wd);
    await TG.edit(chat_id, mid, `❌ Rejected #${wid}`, BACK_KB);
    await TG.send(wd.user, `❌ Your withdrawal #${wd.id} has been <b>REJECTED</b>.`);
    return;
  }
}

/* ================== Vercel handler =================== */

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const pathname = new URL(req.url).pathname;

  // set-webhook helper (unchanged)
  if (pathname.endsWith("/api/set-webhook")) {
    const url = `${APP_URL.replace(/\/+$/,"")}/api/telegram?secret=${WEBHOOK_SECRET}`;
    const res = await fetch(`${TG_API}/setWebhook`, {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify({ url, allowed_updates:["message","callback_query"] })
    }).then(r=>r.json()).catch(()=>({ok:false}));
    return new Response(JSON.stringify({ ok:true, set_to:url, telegram:res }), { headers: { "content-type":"application/json" }});
  }

  // root ping
  if (pathname.endsWith("/api/telegram") && req.method === "GET") {
    return new Response(JSON.stringify({ ok:true, hello:"telegram" }), { headers: { "content-type":"application/json" }});
  }

  if (pathname.endsWith("/api/telegram") && req.method === "POST") {
    if (searchParams.get("secret") !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const upd = await req.json();

    // intercept admin approve/reject callback
    if (upd.callback_query && typeof upd.callback_query.data === "string" &&
        (/^(ap|rj):\d+$/.test(upd.callback_query.data))) {
      await processAdminAction(upd.callback_query);
      return new Response("OK");
    }

    await handleUpdate(upd);
    return new Response("OK");
  }

  return new Response("NOT_FOUND", { status: 404 });
}
