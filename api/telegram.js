export const config = { runtime: "edge" };

/* ========= ENV ========= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/* ADMIN + CHANNELS */
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);                // eg 123456789
const PROOF_CHANNEL = process.env.PROOF_CHANNEL || "@Withdrawal_Proofsj";

/* Force-join list (show names only, links hidden) */
const FORCE_CHANNELS = [
  { title: "free_redeem_codes_fire_crypto", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { title: "Withdrawal_Proofsj",            url: "https://t.me/Withdrawal_Proofsj" },
  { title: "loot4udeal",                    url: "https://t.me/loot4udeal" },
];

/* ========= SMALL UTIL ========= */
const hallo = u => `👋 Hello *${(u.first_name || u.username || "Friend").toString().slice(0,32)}*!\n`;
const kb   = rows => ({ reply_markup: { keyboard: rows, resize_keyboard: true }});
const ikb  = rows => ({ reply_markup: { inline_keyboard: rows }});
const back = () => kb([[ "⬅️ Back" ]]);

function maskEmail(s){
  // half show, half stars (admin always sees full)
  if(!s || !s.includes("@")) return s;
  const [name,domain] = s.split("@");
  const keep = Math.ceil(name.length/2);
  return name.slice(0,keep) + "*".repeat(Math.max(3, name.length-keep)) + "@" + domain;
}
function maskUPI(s){
  if(!s || !s.includes("@")) return s;
  const [name,domain] = s.split("@");
  const keep = Math.ceil(name.length/2);
  return name.slice(0,keep) + "*".repeat(Math.max(3, name.length-keep)) + "@" + domain;
}

async function tg(method, payload){
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload)
  });
  return r.json();
}

/* ========= REDIS (Upstash REST) ========= */
const R = {
  async get(k){ 
    const r = await fetch(UPSTASH_REDIS_REST_URL + "/get/" + encodeURIComponent(k), {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    }).then(r=>r.json());
    try{ return r.result ?? null }catch{ return null }
  },
  async set(k, v){
    return fetch(UPSTASH_REDIS_REST_URL + "/set/" + encodeURIComponent(k), {
      method:"POST",
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ value: typeof v==="string" ? v : JSON.stringify(v) })
    });
  },
  async del(k){
    return fetch(UPSTASH_REDIS_REST_URL + "/del/" + encodeURIComponent(k), {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
  },
  async hgetall(k){
    const j = await fetch(UPSTASH_REDIS_REST_URL + "/hgetall/" + encodeURIComponent(k), {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    }).then(r=>r.json());
    const obj = Object.fromEntries(j.result||[]);
    // parse JSON values if needed
    for(const [kk,v] of Object.entries(obj)){
      try{ obj[kk] = JSON.parse(v) } catch { obj[kk] = v }
    }
    return obj;
  },
  async hset(k, obj){
    for (const [f,v] of Object.entries(obj)) {
      await fetch(UPSTASH_REDIS_REST_URL + "/hset/" + encodeURIComponent(k), {
        method:"POST",
        headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}`, "Content-Type":"application/json" },
        body: JSON.stringify({ field:f, value: typeof v==="string"? v : JSON.stringify(v), upsert:true })
      });
    }
  },
  async incr(k){
    return fetch(UPSTASH_REDIS_REST_URL + "/incr/" + encodeURIComponent(k), {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    }).then(r=>r.json()).then(j=>j.result);
  },
  async zincr(key, member, by=1){
    return fetch(UPSTASH_REDIS_REST_URL + "/zincrby/" + encodeURIComponent(key) + "/" + by + "/" + encodeURIComponent(member), {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
  },
  async ztop(key, n=10){
    return fetch(UPSTASH_REDIS_REST_URL + "/zrevrange/" + encodeURIComponent(key) + "/0/" + (n-1) + "/WITHSCORES", {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    }).then(r=>r.json()).then(j=>j.result||[]);
  }
};

/* ========= MENUS ========= */
const MENU = {
  Channels: "📣 Channels",
  Proofs:   "🧾 Proofs",
  Balance:  "💰 Balance",
  Bonus:    "🎁 Daily Bonus",
  Referral: "👥 Referral",
  Leader:   "🏆 Leaderboard",
  Withdraw: "💸 Withdraw"
};
const MAIN = () => kb([
  [MENU.Channels, MENU.Proofs],
  [MENU.Balance,  MENU.Bonus],
  [MENU.Referral, MENU.Leader],
  [MENU.Withdraw]
]);

const joinUI = () => ikb([
  ...FORCE_CHANNELS.map(c=>[{ text:`✅ Join ${c.title}`, url:c.url }]),
  [{ text:"I’ve Joined ✅", callback_data:"joined_all" }]
]);

/* ========= USER SETUP ========= */
async function ensureUser(u){
  const key = `user:${u.id}`;
  const ex = await R.hgetall(key);
  const name = (u.first_name||u.username||String(u.id));
  if(!ex.id){
    await R.hset(key, { id:String(u.id), name, balance:"0", refs:"0" });
  }else if(ex.name !== name){
    await R.hset(key, { name });
  }
}

/* ========= FLOW HELPERS ========= */
async function sendMenu(chat_id, from){
  await tg("sendMessage", {
    chat_id,
    text: hallo(from) + "🎯 *Main Menu*\nEarn via referrals & daily bonus; redeem by withdraw.",
    parse_mode:"Markdown", ...MAIN()
  });
}
async function sendJoinGate(chat_id, from){
  await tg("sendMessage", {
    chat_id, text: hallo(from) + "🔒 Please join all channels to use the bot.",
    ...joinUI()
  });
}

/* ========= START (always gate) + REFERRAL ========= */
async function handleStart(msg, payload){
  const u = msg.from;
  await ensureUser(u);

  // referral (once only)
  if(payload && /^\d+$/.test(payload) && Number(payload)!==u.id){
    const done = await R.get(`ref:done:${u.id}`);
    if(!done){
      await R.set(`ref:done:${u.id}`,"1");
      await R.zincr("board:refs", payload, 1);
      await tg("sendMessage",{ chat_id:Number(payload), text:"🎉 *Congrats!* You referred 1 user.", parse_mode:"Markdown" });
    }
  }

  // ALWAYS gate on start
  await sendJoinGate(msg.chat.id, u);
}

/* ========= CALLBACKS ========= */
async function handleCallback(cb){
  const data = cb.data || "";
  const chat_id = cb.message.chat.id;
  const from = cb.from;

  if(data==="joined_all"){
    return sendMenu(chat_id, from);
  }

  // approve/reject withdrawal
  if(data.startsWith("approve:") || data.startsWith("reject:")){
    if(from.id !== ADMIN_ID) return;
    const [action, wid] = data.split(":");
    const wd = await R.hgetall(`wd:${wid}`);
    if(!wd.id) return tg("answerCallbackQuery",{ callback_query_id:cb.id, text:"Already handled or not found."});

    // update status
    await R.hset(`wd:${wid}`, { status: action==="approve" ? "approved" : "rejected" });

    // notify user
    const maskedEmail = maskEmail(wd.email||"");
    const maskedUPI   = maskUPI(wd.upi||"");
    if(action==="approve"){
      await tg("sendMessage", { chat_id: Number(wd.uid),
        text: `🎉 Your withdrawal #${wid} has been *APPROVED*.\n` +
              (wd.method==="email" ? `Check your email: ${maskedEmail}` : `Check your UPI: ${maskedUPI}`),
        parse_mode:"Markdown"
      });

      // post proof (mask for channel)
      const proofText =
        `✅ *Withdrawal Paid*\n` +
        `ID: ${wid}\n` +
        `User: ${wd.uid} (${wd.name})\n` +
        (wd.method==="email" ? `Email: ${maskedEmail}\n` : `UPI: ${maskedUPI}\n`) +
        `Amount: ${wd.amount}`;
      await tg("sendMessage", { chat_id: PROOF_CHANNEL, text: proofText, parse_mode:"Markdown" });

    } else {
      await tg("sendMessage", { chat_id: Number(wd.uid),
        text: `❌ Your withdrawal #${wid} was *REJECTED*.`, parse_mode:"Markdown"
      });
    }

    // admin inline updated
    await tg("editMessageReplyMarkup", { chat_id: chat_id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    await tg("answerCallbackQuery",{ callback_query_id:cb.id, text: action==="approve"?"Approved":"Rejected" });
    return;
  }
}

/* ========= WITHDRAW FLOW =========
   – tap Withdraw -> choose Email or UPI
   – ask id -> ask amount -> create ticket -> send to admin with Approve/Reject
   – user always sees masked ids in confirmations
*/
async function startWithdraw(chat_id, from){
  await R.hset(`state:${from.id}`, { step:"wd_choose" });
  return tg("sendMessage", {
    chat_id, text: hallo(from) + "💸 *Withdraw*\nChoose a method:", parse_mode:"Markdown",
    ...ikb([
      [{ text:"📧 Email Code", callback_data:"wd:email" }],
      [{ text:"🏦 UPI",        callback_data:"wd:upi" }],
      [{ text:"⬅️ Back",      callback_data:"wd:back" }]
    ])
  });
}

async function handleWithdrawCb(cb){
  const data = cb.data;
  const chat_id = cb.message.chat.id;
  const from = cb.from;

  if(data==="wd:back"){
    await R.del(`state:${from.id}`);
    return sendMenu(chat_id, from);
  }
  if(data==="wd:email" || data==="wd:upi"){
    const method = data.endsWith("email") ? "email" : "upi";
    await R.hset(`state:${from.id}`, { step:"wd_id", method });
    const ask = method==="email" ? "📧 Send your *email id* now." : "🏦 Send your *UPI id* now.";
    return tg("sendMessage",{ chat_id, text: hallo(from) + ask, parse_mode:"Markdown", ...back() });
  }
}

async function handleText(msg){
  const { text, chat, from } = msg;

  // universal back
  if(text === "⬅️ Back"){ await R.del(`state:${from.id}`); return sendMenu(chat.id, from); }

  // check if in withdraw state
  const state = await R.hgetall(`state:${from.id}`);
  if(state.step){ // inside withdraw/admin steps
    // withdraw id capture
    if(state.step==="wd_id"){
      if(state.method==="email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"⚠️ Invalid email, try again.", parse_mode:"Markdown", ...back() });
      }
      if(state.method==="upi" && !/^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(text)) {
        return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"⚠️ Invalid UPI, try again (e.g. name@bank).", parse_mode:"Markdown", ...back() });
      }
      await R.hset(`state:${from.id}`, { step:"wd_amount", id:text });
      return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"💰 Send *amount* now (number).", parse_mode:"Markdown", ...back() });
    }
    if(state.step==="wd_amount"){
      const amt = Number(text);
      if(!(amt>0)) return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"⚠️ Amount must be a number > 0.", parse_mode:"Markdown", ...back() });

      // create ticket
      const wid = await R.incr("seq:wd");
      const u = await R.hgetall(`user:${from.id}`);
      const ticket = {
        id:String(wid), uid:String(from.id), name: u.name || (from.first_name||from.username||String(from.id)),
        method: state.method, email: state.method==="email" ? state.id : "", upi: state.method==="upi" ? state.id : "",
        amount: String(amt), status:"pending"
      };
      await R.hset(`wd:${wid}`, ticket);
      await R.del(`state:${from.id}`);

      // user confirm (masked)
      const maskLine = state.method==="email" ? `Email: ${maskEmail(ticket.email)}` : `UPI: ${maskUPI(ticket.upi)}`;
      await tg("sendMessage", { chat_id: chat.id,
        text: `✅ *Withdraw request received.*\nID: ${wid}\n${maskLine}\nAmount: ${amt}`,
        parse_mode:"Markdown", ...back()
      });

      // admin panel card
      if(ADMIN_ID){
        const adminText =
          `💸 *Withdraw Request*\n` +
          `ID: ${wid}\n` +
          `User: ${ticket.uid} (${ticket.name})\n` +
          `Email: ${ticket.email || "-"}\n` +
          `UPI: ${ticket.upi || "-"}\n` +
          `Amount: ${ticket.amount}`;
        await tg("sendMessage", {
          chat_id: ADMIN_ID, text: adminText, parse_mode:"Markdown", 
          ...ikb([[ {text:"✅ Approve", callback_data:`approve:${wid}`}, {text:"❌ Reject", callback_data:`reject:${wid}`} ]])
        });
      }
      return;
    }

    // admin states
    if(from.id===ADMIN_ID){
      if(state.step==="adm_add"){
        const [idOrTag, coinsStr] = text.trim().split(/\s+/);
        const uid = Number(idOrTag);
        const coins = Number(coinsStr);
        if(!(uid>0 && coins>0)) return tg("sendMessage",{ chat_id:chat.id, text:"⚠️ Use: `<userId> <coins>`", parse_mode:"Markdown", ...back() });
        const u = await R.hgetall(`user:${uid}`);
        const nb = String(Number(u.balance||0)+coins);
        await R.hset(`user:${uid}`, { balance: nb });
        await R.del(`state:${from.id}`);
        return tg("sendMessage",{ chat_id:chat.id, text:`✅ Added ${coins} to ${u.name||uid}.`, ...back() });
      }
      if(state.step==="adm_deduct"){
        const [idOrTag, coinsStr] = text.trim().split(/\s+/);
        const uid = Number(idOrTag);
        const coins = Number(coinsStr);
        if(!(uid>0 && coins>0)) return tg("sendMessage",{ chat_id:chat.id, text:"⚠️ Use: `<userId> <coins>`", parse_mode:"Markdown", ...back() });
        const u = await R.hgetall(`user:${uid}`);
        const nb = Math.max(0, Number(u.balance||0)-coins);
        await R.hset(`user:${uid}`, { balance: String(nb) });
        await R.del(`state:${from.id}`);
        return tg("sendMessage",{ chat_id:chat.id, text:`✅ Deducted ${coins} from ${u.name||uid}.`, ...back() });
      }
      if(state.step==="adm_broadcast"){
        // Very simple broadcast list = top 100 recent user ids by leaderboard keys fallback
        const listKey = await R.get("known:users");
        const ids = listKey ? JSON.parse(listKey) : [];
        for(const uid of ids.slice(0,100)){
          await tg("sendMessage",{ chat_id:Number(uid), text:`📢 Broadcast:\n${text}` }).catch(()=>{});
        }
        await R.del(`state:${from.id}`);
        return tg("sendMessage",{ chat_id:chat.id, text:"✅ Broadcast sent.", ...back() });
      }
    }
  }

  /* MAIN MENU HANDLERS */
  if(text === MENU.Channels){
    return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"🔗 Join these:", ...joinUI() });
  }
  if(text === MENU.Proofs){
    return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"🧾 Proofs channel:\nhttps://t.me/Withdrawal_Proofsj", ...back() });
  }
  if(text === MENU.Balance){
    const u = await R.hgetall(`user:${from.id}`);
    return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+`💰 Your balance: *${u.balance||0}* coins`, parse_mode:"Markdown", ...back() });
  }
  if(text === MENU.Bonus){
    const k = `bonus:${from.id}:${new Date().toISOString().slice(0,10)}`;
    if(await R.get(k)) return tg("sendMessage",{ chat_id:chat.id, text:hallo(from)+"⏳ You already claimed today.", parse_mode:"Markdown", ...back() });
    await R.set(k,"1");
    const u = await R.hgetall(`user:${from.id}`);
    const nb = String(Number(u.balance||0)+10);
    await R.hset(`user:${from.id}`,{ balance: nb });
    return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+"🎁 Daily bonus **+10** added!", parse_mode:"Markdown", ...back() });
  }
  if(text === MENU.Referral){
    const me = await tg("getMe",{});
    const link = `https://t.me/${me.result.username}?start=${from.id}`;
    const u = await R.hgetall(`user:${from.id}`);
    await tg("sendMessage",{ chat_id:chat.id, text:hallo(from)+`👥 *Referrals*\nRefs: *${u.refs||0}*\nLink:\n${link}`, parse_mode:"Markdown", ...back() });
    // track known users for broadcast
    const known = JSON.parse(await R.get("known:users") || "[]");
    if(!known.includes(String(from.id))){ known.unshift(String(from.id)); await R.set("known:users", JSON.stringify(known.slice(0,5000))); }
    return;
  }
  if(text === MENU.Leader){
    const arr = await R.ztop("board:refs",10);
    const lines = [];
    for(let i=0;i<arr.length;i+=2){
      const uid = arr[i]; const sc = arr[i+1];
      const u = await R.hgetall(`user:${uid}`);
      lines.push(`${i/2+1}. ${u.name || uid} - ${sc} refs`);
    }
    return tg("sendMessage",{ chat_id:chat.id, text: hallo(from)+`🏆 *Leaderboard*\n`+(lines.join("\n")||"No refs yet."), parse_mode:"Markdown", ...back() });
  }
  if(text === MENU.Withdraw){
    return startWithdraw(chat.id, from);
  }

  /* ADMIN PANEL */
  if(text === "/admin" && from.id===ADMIN_ID){
    await tg("sendMessage",{ chat_id:chat.id, text:"🛠 *Admin Panel*", parse_mode:"Markdown",
      ...ikb([
        [{ text:"➕ Add Coins", callback_data:"adm:add" }, { text:"➖ Deduct Coins", callback_data:"adm:ded" }],
        [{ text:"📣 Broadcast",  callback_data:"adm:cast" }]
      ])
    });
    return;
  }

  // default -> show menu
  return sendMenu(chat.id, from);
}

/* admin inline */
async function handleAdminCb(cb){
  const data = cb.data;
  if(cb.from.id !== ADMIN_ID) return;
  const chat_id = cb.message.chat.id;

  if(data==="adm:add"){
    await R.hset(`state:${cb.from.id}`, { step:"adm_add" });
    return tg("sendMessage",{ chat_id, text:"Send: `<userId> <coins>`", parse_mode:"Markdown", ...back() });
  }
  if(data==="adm:ded"){
    await R.hset(`state:${cb.from.id}`, { step:"adm_deduct" });
    return tg("sendMessage",{ chat_id, text:"Send: `<userId> <coins>`", parse_mode:"Markdown", ...back() });
  }
  if(data==="adm:cast"){
    await R.hset(`state:${cb.from.id}`, { step:"adm_broadcast" });
    return tg("sendMessage",{ chat_id, text:"Send broadcast message text.", ...back() });
  }
}

/* ========= HTTP HANDLER ========= */
export default async function handler(req){
  const url = new URL(req.url);

  // tiny health/debug
  if(url.pathname.endsWith("/api"))
    return new Response(JSON.stringify({ ok:true, hello:"telegram" }), { headers:{ "content-type":"application/json"} });

  // webhook guard
  if(!url.pathname.endsWith(`/api/telegram`) && !url.pathname.endsWith(`/api/telegram/${WEBHOOK_SECRET}`))
    return new Response("404", { status:404 });

  const update = await req.json().catch(()=> ({}));

  // withdraw inline cb
  if(update.callback_query){
    const cb = update.callback_query;
    if(cb.data?.startsWith("wd:")) { await handleWithdrawCb(cb); return new Response("OK"); }
    if(cb.data?.startsWith("adm:")) { await handleAdminCb(cb);   return new Response("OK"); }
    await handleCallback(cb);
    return new Response("OK");
  }

  if(update.message){
    const m = update.message;

    if(m.text && m.text.startsWith("/start")){
      const payload = m.text.split(" ").slice(1).join(" ");
      await handleStart(m, payload);
      return new Response("OK");
    }
    if(m.text){ await handleText(m); return new Response("OK"); }
  }

  return new Response("OK");
}
