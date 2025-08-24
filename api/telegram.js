export const config = { runtime: "edge" };

/* ================== ENV & Helpers ================== */
const BOT = process.env.BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT}`;
const APP_URL = process.env.APP_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const ADMINS = (process.env.ADMIN_ID || "")
  .split(",")
  .map(s => +s.trim())
  .filter(Boolean);

const CHANNELS = (process.env.CHANNELS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean); // e.g. ['@ch1','@ch2']

const PROOF_CH = process.env.PROOF_CHANNEL_ID
  ? +process.env.PROOF_CHANNEL_ID
  : null;

// 👇 NEW: optional open-link button for proofs channel
const PROOF_URL = process.env.PROOF_CHANNEL_URL || null;

const BONUS_PER_DAY = +(process.env.BONUS_PER_DAY || 10);
const REF_BONUS = +(process.env.REF_BONUS || 20);
const MIN_WITHDRAW = +(process.env.MIN_WITHDRAW || 100);

const j = v => JSON.stringify(v);
const now = () => Math.floor(Date.now() / 1000);
const esc = (s = "") => s.replace(/[<>&]/g, m => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
const isAdmin = id => ADMINS.includes(+id);

/* ===== Upstash Redis REST ===== */
const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function r(cmd, ...args) {
  const res = await fetch(RURL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RTOK}`,
      "content-type": "application/json",
    },
    body: j([cmd, ...args]),
  }).then(r => r.json());
  return res.result;
}
const rget = k => r("GET", k);
const rset = (k, v) => r("SET", k, typeof v === "string" ? v : j(v));
const rdel = k => r("DEL", k);

/* ===== Telegram minimal client ===== */
const TG = {
  async send(chat_id, text, kb) {
    return fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: j({ chat_id, text, parse_mode: "HTML", ...kb }),
    });
  },
  async edit(chat_id, message_id, text, kb) {
    return fetch(`${TG_API}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: j({ chat_id, message_id, text, parse_mode: "HTML", ...kb }),
    });
  },
  async answerCb(id, opts) {
    return fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: j({ callback_query_id: id, ...opts }),
    });
  },
  kb(inline_keyboard) {
    return { reply_markup: { inline_keyboard } };
  },
  async getChatMember(chat, user) {
    return (await fetch(`${TG_API}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${user}`)).json();
  },
};

// ⬇️ SAME keyboard as before, only added the optional “📄 Proofs” row.
const MAIN_KB = TG.kb([
  [{ text: "💰 Balance", callback_data: "bal" }, { text: "🎁 Daily Bonus", callback_data: "bonus" }],
  [{ text: "👥 Referral", callback_data: "ref" }, { text: "💵 Withdraw", callback_data: "wd" }],
  [{ text: "🏆 Leaderboard", callback_data: "lb" }],
  ...(PROOF_URL ? [[{ text: "📄 Proofs", url: PROOF_URL }]] : []),
  ...(ADMINS.length ? [[{ text: "🛠 Admin Panel", callback_data: "ad" }]] : []),
]);

const BACK_KB = TG.kb([[{ text: "◀️ Back", callback_data: "back" }]]);

/* ================== Text blocks ================== */
const helloText = name =>
  `👋 Hello ${esc(name)}!\n\n🎯 <b>Main Menu</b>\nEarn via referrals & daily bonus.\nकमाओ रेफ़रल से और बोनस से — रिडीम करो <b>Withdraw</b> से।`;

const gateText = name =>
  `👋 Hello ${esc(name)} 🇮🇳\n\n🔐 <b>Join all channels to continue.</b>\nसबसे पहले सभी चैनल Join करें, फिर नीचे <b>Claim ✅</b> दबाएँ।`;

const gateButtons = () => {
  const rows = CHANNELS.map((_, i) => [{ text: `✅ Join Channel ${i + 1}`, url: `https://t.me/${CHANNELS[i].replace("@", "")}` }]);
  rows.push([{ text: "✅ Claim", callback_data: "chkjoin" }]);
  return TG.kb(rows);
};

const wdAskKB = TG.kb([
  [{ text: "✉️ Gmail Redeem", callback_data: "wd_email" }, { text: "🏦 UPI Redeem", callback_data: "wd_upi" }],
  [{ text: "◀️ Back", callback_data: "back" }],
]);

/* ================== Data helpers ================== */
async function getUser(id) {
  const raw = await rget(`u:${id}`);
  if (raw) return JSON.parse(raw);
  const u = { id, name: "", balance: 0, refs: 0, email: "", upi: "", joinedOk: false, lastBonus: 0, invitedBy: 0, created: now() };
  await rset(`u:${id}`, u);
  // add to users set
  let all = (await rget("users")) || "[]";
  const arr = JSON.parse(all);
  if (!arr.includes(id)) { arr.push(id); await rset("users", arr); }
  return u;
}
async function saveUser(u) { return rset(`u:${u.id}`, u); }

function maskEmail(e) {
  if (!e || !e.includes("@")) return e;
  const [a, b] = e.split("@");
  const half = Math.ceil(a.length / 2);
  return a.slice(0, half) + "*".repeat(a.length - half) + "@" + b;
}
function maskUPI(u) {
  if (!u || !u.includes("@")) return u;
  const [a, b] = u.split("@");
  const left = Math.max(2, Math.ceil(a.length / 2));
  return a.slice(0, left) + "*".repeat(Math.max(1, a.length - left)) + "@" + b;
}

/* ================== Core ================== */
export default async function handler(req) {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/api/set-webhook")) {
    const hook = `${APP_URL}/api/telegram?secret=${WEBHOOK_SECRET}`;
    const r = await fetch(`${TG_API}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: j({ url: hook, allowed_updates: ["message", "callback_query"] }),
    }).then(r => r.json());
    return new Response(j({ ok: true, set_to: hook, telegram: r }), { headers: { "content-type": "application/json" } });
  }
  if (req.method === "GET") return new Response(j({ ok: true, hello: "telegram" }), { headers: { "content-type": "application/json" } });
  if (url.searchParams.get("secret") !== WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });

  const update = await req.json().catch(() => ({}));
  try { await onUpdate(update); } catch (e) { console.log("ERR", e); }
  return new Response("ok");
}

/* ================== Update router (single) ================== */
async function onUpdate(upd) {
  const m = upd.message, cb = upd.callback_query;
  const from = m?.from || cb?.from;
  const chat_id = m?.chat?.id || cb?.message?.chat?.id;
  if (!from || !chat_id) return;

  // ensure user
  let u = await getUser(from.id);
  if (from.first_name && u.name !== from.first_name) { u.name = from.first_name; await saveUser(u); }

  // Admin callback: approve / reject withdrawal
  if (cb && /^wd:(approve|reject):\d+$/.test(cb.data) && isAdmin(from.id)) {
    const [_, action, idStr] = cb.data.split(":");
    const wid = +idStr;
    const wd = JSON.parse((await rget(`wd:${wid}`)) || "null");
    if (!wd) { await TG.answerCb(cb.id, { text: "Not found." }); return; }
    if (wd.status !== "pending") { await TG.answerCb(cb.id, { text: "Already processed." }); return; }

    wd.status = action === "approve" ? "approved" : "rejected";
    wd.processedAt = now();
    await rset(`wd:${wid}`, wd);

    // balance deduction only on approve (already reserved at request time)
    const uu = await getUser(wd.user);
    if (action === "reject") {
      // refund
      uu.balance += wd.amount;
    }
    await saveUser(uu);

    // notify user
    const ok = action === "approve";
    if (ok) {
      const dest = wd.kind === "email" ? `email: <b>${esc(wd.value)}</b>` : `UPI: <b>${esc(wd.value)}</b>`;
      await TG.send(wd.user, `🎉 <b>Your withdrawal #${wid} has been APPROVED.</b>\nCheck your ${dest}.`, BACK_KB);
      // post to proof channel
      if (PROOF_CH) {
        const masked = wd.kind === "email" ? maskEmail(wd.value) : maskUPI(wd.value);
        const title = `✅ Withdrawal Paid`;
        const text =
          `<b>${title}</b>\nID: <b>${wid}</b>\nUser: ${uu.name ? esc(uu.name) : uu.id}\n` +
          `${wd.kind === "email" ? `Email: <b>${esc(masked)}</b>` : `UPI: <b>${esc(masked)}</b>`}\n` +
          `Amount: <b>${wd.amount}</b>`;
        await TG.send(PROOF_CH, text);
      }
    } else {
      await TG.send(wd.user, `❌ <b>Your withdrawal #${wid} was REJECTED.</b>\nAmount refunded.`, BACK_KB);
    }

    // update admin card
    await TG.edit(chat_id, cb.message.message_id,
      `💼 <b>Withdrawal ${wid}</b>\nStatus: <b>${wd.status.toUpperCase()}</b>`);
    await TG.answerCb(cb.id, { text: `Marked ${wd.status}` });
    return;
  }

  /* ---------- /start ---------- */
  if (m?.text?.startsWith("/start")) {
    // deep-link referral: /start 12345
    const parts = m.text.trim().split(/\s+/);
    if (parts[1] && !u.invitedBy && +parts[1] !== from.id) {
      const inviterId = +parts[1];
      u.invitedBy = inviterId;
      await saveUser(u);
      const inviter = await getUser(inviterId);
      inviter.refs += 1;
      inviter.balance += REF_BONUS;
      await saveUser(inviter);
      // inform inviter
      await TG.send(inviterId, `🎉 <b>Great!</b> You got 1 referral. (+${REF_BONUS})`);
    }

    // show join gate if not yet verified in this session
    if (!u.joinedOk) {
      await TG.send(chat_id, gateText(u.name || "User"), gateButtons());
      return;
    }
    await TG.send(chat_id, helloText(u.name || "User"), MAIN_KB);
    return;
  }

  /* ---------- Callback buttons ---------- */
  if (cb) {
    const data = cb.data;

    if (data === "chkjoin") {
      // verify all CHANNELS
      let ok = true;
      for (const ch of CHANNELS) {
        const res = await TG.getChatMember(ch, from.id);
        const st = res?.result?.status;
        if (!["member", "administrator", "creator"].includes(st)) { ok = false; break; }
      }
      if (!ok) {
        await TG.answerCb(cb.id, { text: "❗ Join all channels first.", show_alert: true });
        return;
      }
      u.joinedOk = true; await saveUser(u);
      await TG.edit(chat_id, cb.message.message_id, "✅ All set! Opening main menu…");
      await TG.send(chat_id, helloText(u.name || "User"), MAIN_KB);
      return;
    }

    if (data === "back") {
      await TG.edit(chat_id, cb.message.message_id, helloText(u.name || "User"), MAIN_KB);
      return;
    }

    if (data === "bal") {
      await TG.edit(chat_id, cb.message.message_id, `💰 <b>Your balance:</b> <code>${u.balance}</code>`, TG.kb([[{ text: "◀️ Back", callback_data: "back" }]]));
      return;
    }

    if (data === "bonus") {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const start = Math.floor(today.getTime() / 1000);
      if (u.lastBonus >= start) {
        await TG.answerCb(cb.id, { text: "⏳ Bonus already claimed today.", show_alert: true });
        return;
      }
      u.lastBonus = now(); u.balance += BONUS_PER_DAY; await saveUser(u);
      await TG.edit(chat_id, cb.message.message_id, `🎁 Bonus added: <b>${BONUS_PER_DAY}</b>\n💰 Balance: <b>${u.balance}</b>`, BACK_KB);
      return;
    }

    if (data === "ref") {
      const link = `https://t.me/${(upd?.my_chat_member?.chat?.username) || ""}?start=${from.id}`;
      await TG.edit(chat_id, cb.message.message_id,
        `👥 <b>Your Referrals:</b> <b>${u.refs}</b>\n🔗 Invite link: <code>https://t.me/<your_bot_username>?start=${from.id}</code>\n(ऊपर अपने बॉट का यूज़रनेम भरें)`,
        BACK_KB);
      return;
    }

    if (data === "wd") {
      await rset(`state:${from.id}`, j({ step: "choose_wd" }));
      await TG.edit(chat_id, cb.message.message_id,
        `💵 <b>Withdraw</b>\nएक विकल्प चुनें:\n• Gmail Redeem (code भेजेंगे)\n• UPI Redeem (direct transfer)\n\n➡️ फिर बॉट आपसे details माँगेगा।`,
        wdAskKB);
      return;
    }

    if (data === "wd_email" || data === "wd_upi") {
      const kind = data === "wd_email" ? "email" : "upi";
      await rset(`state:${from.id}`, j({ step: `wd_${kind}` }));
      const msg =
        kind === "email"
          ? `✉️ <b>Send Gmail like:</b>\n<code>yourmail@gmail.com 120</code>\n(सिर्फ email और amount, slash नहीं)`
          : `🏦 <b>Send UPI like:</b>\n<code>yourupi@bank 120</code>\n(सिर्फ upi और amount)`;
      await TG.edit(chat_id, cb.message.message_id, msg, BACK_KB);
      return;
    }

    if (data === "lb") {
      const all = JSON.parse((await rget("users")) || "[]");
      const enriched = [];
      for (const id of all) {
        const uu = await getUser(id);
        enriched.push({ id, name: uu.name || String(id), refs: uu.refs || 0 });
      }
      enriched.sort((a, b) => b.refs - a.refs);
      const top = enriched.slice(0, 10);
      const lines = top.map((x, i) => `${i + 1}. ${esc(x.name)} - <b>${x.refs}</b> refs`).join("\n");
      await TG.edit(chat_id, cb.message.message_id, `🏆 <b>Leaderboard</b>\n${lines || "No data"}`, BACK_KB);
      return;
    }

    if (data === "ad" && isAdmin(from.id)) {
      await TG.edit(chat_id, cb.message.message_id,
        `🛠 <b>Admin Panel</b>\nCommands:\n• <code>/add userId amount</code>\n• <code>/sub userId amount</code>\n• <code>/bc your message</code>`,
        BACK_KB);
      return;
    }
  }

  /* ---------- Text message handling (states) ---------- */
  if (m?.text) {
    const txt = m.text.trim();

    // Admin commands
    if (isAdmin(from.id) && /^\/(add|sub)\s+\d+\s+\d+$/.test(txt)) {
      const [, cmd, uidStr, amtStr] = txt.match(/^\/(add|sub)\s+(\d+)\s+(\d+)$/);
      const tgt = await getUser(+uidStr);
      const amt = +amtStr;
      tgt.balance += cmd === "add" ? amt : -amt;
      if (tgt.balance < 0) tgt.balance = 0;
      await saveUser(tgt);
      await TG.send(chat_id, `✅ Done. User ${tgt.name || tgt.id} balance: <b>${tgt.balance}</b>`, BACK_KB);
      return;
    }
    if (isAdmin(from.id) && txt.startsWith("/bc ")) {
      const msg = txt.slice(4);
      const all = JSON.parse((await rget("users")) || "[]");
      for (const id of all) { await TG.send(id, `📣 <b>Broadcast:</b>\n${esc(msg)}`); }
      await TG.send(chat_id, "✅ Broadcast sent.");
      return;
    }

    // Start (if user typed again)
    if (txt === "/start") {
      if (!u.joinedOk) { await TG.send(chat_id, gateText(u.name || "User"), gateButtons()); return; }
      await TG.send(chat_id, helloText(u.name || "User"), MAIN_KB); return;
    }

    // State machine for withdraw details
    const stateRaw = await rget(`state:${from.id}`);
    const state = stateRaw ? JSON.parse(stateRaw) : null;

    if (state?.step === "wd_email" || state?.step === "wd_upi") {
      // Expect: "<value> <amount>"
      const m2 = txt.match(/^(\S+)\s+(\d+)$/);
      if (!m2) { await TG.send(chat_id, "❌ Format गलत है। सही उदाहरण देखें।", BACK_KB); return; }
      const value = m2[1]; const amount = +m2[2];
      if (amount < MIN_WITHDRAW) { await TG.send(chat_id, `❗ Minimum withdraw <b>${MIN_WITHDRAW}</b> है।`, BACK_KB); return; }
      if (u.balance < amount) { await TG.send(chat_id, `❗ Balance कम है। Your balance: <b>${u.balance}</b>`, BACK_KB); return; }
      const kind = state.step === "wd_email" ? "email" : "upi";

      // reserve balance
      u.balance -= amount; if (kind === "email") u.email = value; else u.upi = value;
      await saveUser(u);

      const wid = +(await r("INCR", "wd:seq"));
      const rec = { id: wid, user: from.id, name: u.name || String(from.id), kind, value, amount, status: "pending", created: now() };
      await rset(`wd:${wid}`, rec);
      await rdel(`state:${from.id}`);

      // user receipt
      await TG.send(chat_id,
        `✅ <b>Withdraw request received.</b>\nID: <b>${wid}</b>\n${kind === "email" ? "Email" : "UPI"}: <b>${esc(value)}</b>\nAmount: <b>${amount}</b>`,
        BACK_KB);

      // admin card
      const adminText =
        `💸 <b>Withdraw Request</b>\nID: <b>${wid}</b>\nUser: ${from.id} (${esc(u.name || "User")})\n` +
        `${kind === "email" ? "Email" : "UPI"}: <b>${esc(value)}</b>\nAmount: <b>${amount}</b>`;
      const adminKB = TG.kb([
        [{ text: "✅ Approve", callback_data: `wd:approve:${wid}` }, { text: "❌ Reject", callback_data: `wd:reject:${wid}` }],
      ]);
      for (const admin of ADMINS) { await TG.send(admin, adminText, adminKB); }

      return;
    }

    // If user pressed back keyword
    if (/^back$/i.test(txt)) {
      await TG.send(chat_id, helloText(u.name || "User"), MAIN_KB);
      return;
    }

    // default echo
    await TG.send(chat_id, `👋 Hello ${esc(u.name || "User")}!\nType /start to open menu.`, MAIN_KB);
  }
}
