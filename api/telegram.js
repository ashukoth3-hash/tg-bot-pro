export const config = { runtime: "edge" };

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;           // e.g. my-secret-9896
const APP_URL = process.env.APP_URL;                          // https://your-app.vercel.app
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// IDs (numeric) – set these in env if you prefer
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);      // your Telegram numeric id
const PROOF_CHANNEL_ID = Number(process.env.PROOF_CHANNEL_ID);// @Withdrawal_Proofsj id

// --- CHANNELS TO FORCE JOIN (edit links here; add/remove items) ---
const FORCE_CHANNELS = [
  { title: "free_redeem_codes_fire_crypto", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { title: "Withdrawal_Proofsj",           url: "https://t.me/Withdrawal_Proofsj" },
  { title: "loot4udeal",                   url: "https://t.me/loot4udeal" },
];

const MENU = {
  Channels: "📣 Channels",
  Proofs:   "🧾 Proofs",
  Balance:  "💰 Balance",
  Bonus:    "🎁 Daily Bonus",
  Referral: "👥 Referral",
  Withdraw: "💸 Withdraw",
  Leader:   "🏆 Leaderboard"
};

const redis = {
  async get(k){ return fetch(UPSTASH_REDIS_REST_URL + "/get/" + encodeURIComponent(k), {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
  }).then(r=>r.json()).then(j=>j.result ?? null) },
  async set(k,v){ return fetch(UPSTASH_REDIS_REST_URL + "/set/" + encodeURIComponent(k), {
      method:"POST", headers: { Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` , "Content-Type":"application/json"},
      body: JSON.stringify({ value: typeof v==="string"? v : JSON.stringify(v) })
  })},
  async hgetall(k){ return fetch(UPSTASH_REDIS_REST_URL + "/hgetall/" + encodeURIComponent(k), {
      headers: { Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
  }).then(r=>r.json()).then(j=>Object.fromEntries(j.result||[])) },
  async hset(k, obj){
    const flat = [];
    for(const [a,b] of Object.entries(obj)) flat.push(a, typeof b==="string"? b : JSON.stringify(b));
    return fetch(UPSTASH_REDIS_REST_URL + "/hset/" + encodeURIComponent(k), {
      method:"POST", headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` , "Content-Type":"application/json"},
      body: JSON.stringify({ field: flat[0], value: flat[1], upsert:true, // single field per call fallback
      })
    }).then(()=>Promise.all(Object.entries(obj).slice(1).map(([f,v])=>fetch(UPSTASH_REDIS_REST_URL + "/hset/" + encodeURIComponent(k), {
      method:"POST", headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` , "Content-Type":"application/json"},
      body: JSON.stringify({ field: f, value: typeof v==="string"? v : JSON.stringify(v), upsert:true})
    }))));
  },
  async zincr(key, member, by=1){
    return fetch(UPSTASH_REDIS_REST_URL + "/zincrby/" + encodeURIComponent(key) + "/" + by + "/" + encodeURIComponent(member), {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    })
  },
  async ztop(key, n=10){
    return fetch(UPSTASH_REDIS_REST_URL + "/zrevrange/" + encodeURIComponent(key) + "/0/" + (n-1) + "/WITHSCORES", {
      headers:{ Authorization:`Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    }).then(r=>r.json()).then(j=>j.result||[]);
  }
};

async function tg(method, payload){
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload)
  }).then(r=>r.json());
}
const kb = rows => ({ reply_markup: { keyboard: rows, resize_keyboard:true }});
const ikb = rows => ({ reply_markup: { inline_keyboard: rows }});

const hello = (user) => `Hello 👋 ${displayName(user)}\n`;
const displayName = (u)=> (u.first_name || u.username || u.id);
const maskEmail = (e)=>{
  if(!e) return "";
  const [name, dom] = e.split("@"); 
  if(!dom) return e;
  const half = Math.max(1, Math.floor(name.length/2));
  return name.slice(0,half) + "***@" + dom;
}
const maskUpi = (u)=>{
  if(!u) return "";
  const [id, bank] = u.split("@");
  if(!bank) return u.slice(0, Math.max(1,Math.floor(u.length/2)))+"***";
  const half = Math.max(1, Math.floor(id.length/2));
  return id.slice(0,half) + "***@" + bank;
}

const mainMenu = () => kb([
  [MENU.Channels, MENU.Proofs],
  [MENU.Balance,  MENU.Bonus],
  [MENU.Referral, MENU.Withdraw],
  [MENU.Leader]
]);

const backBtn = () => kb([[ "⬅️ Back" ]]);

const joinScreen = () => ikb([
  ...FORCE_CHANNELS.map(c=>[{ text: `✅ Join ${c.title}`, url: c.url }]),
  [{ text:"I’ve Joined ✅", callback_data:"joined_all"}]
]);

async function ensureUser(user){
  const key = `user:${user.id}`;
  const u = await redis.hgetall(key);
  if(!u.id){
    await redis.hset(key, { id: String(user.id), name: displayName(user), refs:"0", balance:"0" });
  } else {
    if(u.name !== displayName(user)) await redis.hset(key, { name: displayName(user) });
  }
  return await redis.hgetall(key);
}

async function handleStart(msg, payload){
  const user = msg.from;
  await ensureUser(user);

  // record referral once
  if(payload && /^\d+$/.test(payload) && Number(payload)!==user.id){
    const already = await redis.get(`refdone:${user.id}`);
    if(!already){
      await redis.set(`refdone:${user.id}`, "1");
      await redis.zincr("leaderboard:refs", String(payload), 1);
      const refUser = await redis.hgetall(`user:${payload}`);
      if(refUser && refUser.id){
        // increase ref count & maybe balance
        await redis.hset(`user:${payload}`, { refs: String(Number(refUser.refs||"0")+1) });
        await tg("sendMessage", { chat_id: Number(payload), text: `🎉 You referred 1 user! Keep going!`, ...mainMenu() });
      }
    }
  }

  // always show join gate first
  await tg("sendMessage", {
    chat_id: msg.chat.id,
    text: hello(user) + `🔒 To use the bot, please join all required channels first.`,
    ...joinScreen()
  });
}

async function showMenu(chat_id, user){
  await tg("sendMessage", { chat_id, text: hello(user) + `Welcome Support 🇮🇳👋\nEarn via referrals & daily bonus; redeem by withdraw.`, ...mainMenu() });
}

async function handleCallback(cb){
  const { data, message, from } = cb;
  if(data==="joined_all"){
    // (Optional) You can hit getChatMember for each channel to HARD-check membership.
    return showMenu(message.chat.id, from);
  }
  if(data.startsWith("wd_approve:")){
    const wid = data.split(":")[1];
    const w = JSON.parse(await redis.get(`wd:${wid}`) || "{}");
    if(!w.id) return;
    // notify user
    await tg("sendMessage", { chat_id: w.user_id, text: `🎉 Your withdrawal #${w.id} has been APPROVED. ${w.type==="email" ? `Check your email: ${w.email}` : `UPI: ${w.upi}`}` });
    // post to proof channel (masked)
    const masked = w.type==="email" ? maskEmail(w.email) : maskUpi(w.upi);
    await tg("sendMessage", {
      chat_id: PROOF_CHANNEL_ID,
      text: `✅ *Withdrawal Paid*\nID: *${w.id}*\nUser: ${w.user_id} (${w.user_name})\n${w.type==="email" ? `Email: ${masked}` : `UPI: ${masked}`}\nAmount: *${w.amount}*`,
      parse_mode:"Markdown"
    });
    await tg("editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] }});
  }
  if(data.startsWith("wd_reject:")){
    const wid = data.split(":")[1];
    const w = JSON.parse(await redis.get(`wd:${wid}`) || "{}");
    if(!w.id) return;
    await tg("sendMessage", { chat_id: w.user_id, text: `❌ Your withdrawal #${w.id} has been REJECTED.` });
    await tg("editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] }});
  }
}

async function handleText(msg){
  const { text, chat, from } = msg;
  const me = await ensureUser(from);

  // greet on every command click
  if(text === "⬅️ Back"){ return showMenu(chat.id, from); }

  if(text === MENU.Channels){
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + "Please join all the channels below:", ...joinScreen() });
  }
  if(text === MENU.Proofs){
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + "📜 Check latest proofs here:\nhttps://t.me/Withdrawal_Proofsj", ...backBtn() });
  }
  if(text === MENU.Balance){
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + `Your balance: *${me.balance || 0}* coins`, parse_mode:"Markdown", ...backBtn() });
  }
  if(text === MENU.Bonus){
    // simple daily (24h) limiter
    const key = `bonus:${from.id}`;
    const last = await redis.get(key);
    if(last) return tg("sendMessage", { chat_id: chat.id, text: hello(from) + "⏳ Daily bonus already claimed. Try again later.", ...backBtn() });
    const amount = 10;
    await redis.set(key, "1");
    await redis.hset(`user:${from.id}`, { balance: String(Number(me.balance||0)+amount) });
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + `🎁 Daily bonus +${amount} coins added!`, ...backBtn() });
  }
  if(text === MENU.Referral){
    const link = `https://t.me/${(await tg("getMe",{})).result.username}?start=${from.id}`;
    const refs = me.refs || 0;
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + `👥 *Referral*\nYour refs: *${refs}*\nShare your link:\n${link}`, parse_mode:"Markdown", ...backBtn() });
  }
  if(text === MENU.Leader){
    const arr = await redis.ztop("leaderboard:refs", 10); // [member,score,member,score...]
    const lines = [];
    for(let i=0;i<arr.length;i+=2){
      const uid = arr[i];
      const score = arr[i+1];
      const u = await redis.hgetall(`user:${uid}`);
      lines.push(`${i/2+1}. ${u.name || uid} - ${score} refs`);
    }
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + `🏆 *Leaderboard*\n` + (lines.join("\n") || "No refs yet."), parse_mode:"Markdown", ...backBtn() });
  }
  if(text === MENU.Withdraw){
    await redis.hset(`state:${from.id}`, { mode:"choose_withdraw" });
    return tg("sendMessage", { chat_id: chat.id, text: hello(from) + "Choose a method:", ...ikb([
      [{ text:"📧 Gmail", callback_data:"choose_email" }, { text:"🏦 UPI", callback_data:"choose_upi" }]
    ])});
  }

  // --- contextual states ---
  const state = await redis.hgetall(`state:${from.id}`);
  if(state.mode === "await_email"){
    // expecting: "email amount"
    const parts = text.trim().split(/\s+/);
    if(parts.length<2 || !parts[0].includes("@")) {
      return tg("sendMessage", { chat_id: chat.id, text: hello(from) + "Send like:\n`youremail@gmail.com 1000`", parse_mode:"Markdown" });
    }
    const email = parts[0];
    const amount = Number(parts[1]);
    return createWithdraw(from, chat.id, { type:"email", email, amount });
  }
  if(state.mode === "await_upi"){
    // expecting: "upi amount"
    const parts = text.trim().split(/\s+/);
    if(parts.length<2 || !parts[0].includes("@")) {
      return tg("sendMessage", { chat_id: chat.id, text: hello(from) + "Send like:\n`yourupi@bank 1000`", parse_mode:"Markdown" });
    }
    const upi = parts[0];
    const amount = Number(parts[1]);
    return createWithdraw(from, chat.id, { type:"upi", upi, amount });
  }

  // admin commands
  if(text.startsWith("/admin") && from.id === ADMIN_CHAT_ID){
    return tg("sendMessage", { chat_id: chat.id, text: "🛠 *Admin Panel*\nUse inline buttons below.", parse_mode:"Markdown", ...ikb([
      [{ text:"➕ Add 100 coins to me", callback_data:"adm_add_100" }],
      [{ text:"📣 Broadcast (reply to a message)", callback_data:"adm_bc_hint" }]
    ])});
  }

  // if user chooses in inline (we handle here because callback_query is separate too)
  if(text === "choose_email" || text === "choose_upi"){ /* fallthrough if needed */ }

  // default -> show menu
  return showMenu(chat.id, from);
}

async function createWithdraw(from, chat_id, {type, email, upi, amount}){
  const me = await redis.hgetall(`user:${from.id}`);
  const bal = Number(me.balance||0);
  if(!amount || amount<=0) return tg("sendMessage", { chat_id, text: hello(from) + "Amount invalid." });
  if(bal < amount) return tg("sendMessage", { chat_id, text: hello(from) + "Insufficient balance." });

  const wid = Date.now().toString().slice(-7);
  const payload = {
    id: wid, user_id: from.id, user_name: displayName(from),
    type, email, upi, amount
  };
  await redis.set(`wd:${wid}`, JSON.stringify(payload));
  await redis.hset(`state:${from.id}`, { mode:"" });
  // (optional) hold/lock coins here
  await redis.hset(`user:${from.id}`, { balance: String(bal-amount) });

  // user confirmation
  await tg("sendMessage", {
    chat_id,
    text: `✅ Withdraw request received.\nID: *${wid}*\n${type==="email" ? `Email: ${email}` : `UPI: ${upi}`}\nAmount: *${amount}*`,
    parse_mode:"Markdown",
    ...backBtn()
  });
  // admin message (FULL details)
  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `💸 *Withdraw Request*\nID: *${wid}*\nUser: ${from.id} (${displayName(from)})\n${type==="email" ? `Email: ${email}` : `UPI: ${upi}`}\nAmount: *${amount}*`,
    parse_mode:"Markdown",
    ...ikb([
      [{ text:"✅ Approve", callback_data:`wd_approve:${wid}` }, { text:"❌ Reject", callback_data:`wd_reject:${wid}` }]
    ])
  });
}

export default async function handler(req){
  // webhook guard
  const url = new URL(req.url);
  if(!url.pathname.endsWith(`/api/telegram`) && !url.pathname.endsWith(`/api/telegram/${WEBHOOK_SECRET}`)){
    // simple health/debug
    if(url.pathname.endsWith("/api")) return new Response(JSON.stringify({ ok:true, hello:"telegram" }), { headers:{ "content-type":"application/json"}});
    return new Response("Not found", { status:404 });
  }

  const update = await req.json().catch(()=> ({}));

  if(update.message){
    const msg = update.message;

    // handle commands & text
    if(msg.text){
      // deep-link start
      if(msg.text.startsWith("/start")){
        const payload = msg.text.split(" ").slice(1).join(" ");
        await handleStart(msg, payload);
        return new Response("OK");
      }
      // choose method via callbacks not pressed? Allow text keywords:
      if(msg.text.toLowerCase()==="choose_email"){
        await redis.hset(`state:${msg.from.id}`, { mode:"await_email" });
        await tg("sendMessage", { chat_id: msg.chat.id, text: hello(msg.from) + "Send email & amount like:\n`youremail@gmail.com 1000`", parse_mode:"Markdown" });
        return new Response("OK");
      }
      if(msg.text.toLowerCase()==="choose_upi"){
        await redis.hset(`state:${msg.from.id}`, { mode:"await_upi" });
        await tg("sendMessage", { chat_id: msg.chat.id, text: hello(msg.from) + "Send UPI & amount like:\n`yourupi@bank 1000`", parse_mode:"Markdown" });
        return new Response("OK");
      }
      await handleText(msg);
      return new Response("OK");
    }
  }

  if(update.callback_query){
    const cb = update.callback_query;
    if(cb.data==="choose_email"){
      await redis.hset(`state:${cb.from.id}`, { mode:"await_email" });
      await tg("sendMessage", { chat_id: cb.from.id, text: hello(cb.from) + "Send email & amount like:\n`youremail@gmail.com 1000`", parse_mode:"Markdown" });
    } else if(cb.data==="choose_upi"){
      await redis.hset(`state:${cb.from.id}`, { mode:"await_upi" });
      await tg("sendMessage", { chat_id: cb.from.id, text: hello(cb.from) + "Send UPI & amount like:\n`yourupi@bank 1000`", parse_mode:"Markdown" });
    } else {
      await handleCallback(cb);
    }
    return new Response("OK");
  }

  return new Response("OK");
}
