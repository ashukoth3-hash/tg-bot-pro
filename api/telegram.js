// /api/telegram.js
export const config = { runtime: "edge" };

/** ========= ENV ========= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = (process.env.ADMIN_ID || "").trim();
const PROOF_CHANNEL = process.env.PROOF_CHANNEL; // e.g. -100...
const REQUIRED_CHANNELS = (process.env.REQUIRED_CHANNELS || "").split(",").map(s=>s.trim()).filter(Boolean);
const CHANNEL_LINKS = (process.env.CHANNEL_LINKS || "").split(",").map(s=>s.trim()).filter(Boolean);
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/,"");
const SECRET = process.env.WEBHOOK_SECRET;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** ========= Small Redis REST client (Upstash) ========= */
async function runcmd(cmdArr){
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(cmdArr)
  });
  if(!res.ok) throw new Error("Redis error");
  const data = await res.json();
  // Upstash returns {result:"..."} or array when pipeline; normalize:
  return data.result !== undefined ? data.result : data;
}
const redis = {
  get: (k)=>runcmd(["GET",k]),
  set: (k,v)=>runcmd(["SET",k, typeof v==="string"? v: JSON.stringify(v)]),
  del: (k)=>runcmd(["DEL",k]),
  incr: (k)=>runcmd(["INCR",k]),
  hset: (k,obj)=>runcmd(["HSET",k,...Object.entries(obj).flatMap(([a,b])=>[a, typeof b==="string"? b: JSON.stringify(b)])]),
  hgetall: async (k)=> {
    const arr = await runcmd(["HGETALL",k]) || [];
    const obj = {};
    for(let i=0;i<arr.length;i+=2){ obj[arr[i]] = arr[i+1]; }
    return obj;
  },
  zIncrBy: (k,inc,member)=>runcmd(["ZINCRBY",k,String(inc),String(member)]),
  zRevRangeWithScores: (k,start,stop)=>runcmd(["ZREVRANGE",k,String(start),String(stop),"WITHSCORES"]),
};

/** ========= Telegram helpers ========= */
const TG = {
  api: (method, payload) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  }),
  send: (chat_id, text, extra={}) => TG.api("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra }),
  edit: (chat_id, message_id, text, extra={}) => TG.api("editMessageText", { chat_id, message_id, text, parse_mode:"HTML", ...extra }),
  answerCb: (id, text="", alert=false) => TG.api("answerCallbackQuery", { callback_query_id:id, text, show_alert:alert }),
  getMember: (chat_id, user_id) => TG.api("getChatMember", { chat_id, user_id }),
  forward: (to, from, msg_id)=>TG.api("forwardMessage",{chat_id:to, from_chat_id:from, message_id:msg_id}),
};

/** ========= UI ========= */

const em = {
  check: "✅", cross:"❌", lock:"🔒", back:"◀️", money:"💰", gift:"🎁",
  proof:"🧾", loud:"📢", ref:"👥", bolt:"⚡", mail:"📧", upi:"🏦", claim:"🆗", star:"⭐", crown:"👑"
};

const KB = {
  main: (name)=>({
    reply_markup:{
      inline_keyboard:[
        [{text:`📺 Channels`, callback_data:"menu:channels"}, {text:`${em.proof} Proofs`, url: getProofLink()}],
        [{text:`${em.money} Balance`, callback_data:"menu:balance"}, {text:`${em.gift} Daily Bonus`, callback_data:"menu:bonus"}],
        [{text:`${em.ref} Referral`, callback_data:"menu:ref"}, {text:`💸 Withdraw`, callback_data:"menu:withdraw"}],
        [{text:`🏆 Leaderboard`, callback_data:"menu:top"}]
      ]
    }
  }),
  back: { reply_markup:{ inline_keyboard:[ [{text:`${em.back} Back`, callback_data:"menu:home"}] ] } },
  channels: ()=>{
    const rows = REQUIRED_CHANNELS.map((_,i)=>[{ text:`✅ Join Channel ${i+1}`, url: CHANNEL_LINKS[i] || CHANNEL_LINKS[0] }]);
    rows.push([{ text:`${em.claim} Claim`, callback_data:"chk:claim"}]);
    return { reply_markup:{ inline_keyboard: rows } };
  },
  withdrawMenu: { reply_markup:{ inline_keyboard:[
    [{text:`${em.mail} Gmail`, callback_data:"wd:choose:email"}, {text:`${em.upi} UPI`, callback_data:"wd:choose:upi"}],
    [{text:`${em.back} Back`, callback_data:"menu:home"}]
  ]}}
};

function getProofLink(){
  // If you also want to show a public link button (optional)
  // You already gave: https://t.me/Withdrawal_Proofsj
  return "https://t.me/Withdrawal_Proofsj";
}

/** ========= Message templates ========= */

const txt = {
  main: (name)=>(
`🎯 <b>Main Menu</b>
Earn via referrals & daily bonus; redeem by withdraw.
<b>रेफ़रल और डेली बोनस से कमाएँ; Withdrawal से रिडीम करें।</b>`
),
  join: (name)=>(
`👋 Hello ${escapeHTML(name)}!

${em.lock} <b>Join all channels to continue.</b>
सबसे पहले सभी चैनल Join करें, फिर नीचे <b>Claim</b> दबाएँ।`
),
  joinedOk: `✅ Great! You're verified.\nअब आप बॉट इस्तेमाल कर सकते हैं।`,
  balance: (coins)=>`💰 <b>Your Balance:</b> <code>${coins}</code> coins`,
  bonusAsk: `🎁 Daily bonus लेने के लिये नीचे टैप करें। (हर 24 घंटे में once)`,
  bonusOk: (amt, coins)=>`🎉 Bonus credited: <b>${amt}</b> coins.\nTotal: <b>${coins}</b>`,
  bonusWait: (mins)=>`⏳ Bonus already claimed. Try again in ~<b>${mins}</b> minutes.`,
  ref: (me, link, count)=>(
`👥 <b>Your Referral</b>
• Name: <b>${escapeHTML(me)}</b>
• Refs: <b>${count}</b>
Invite link: <code>${link}</code>

हर valid join पर coins मिलेंगे।`
),
  refNoti: (userName)=>`🎉 You got a new referral from <b>${escapeHTML(userName)}</b>!`,
  wdChoose: `💸 <b>Choose Withdraw Method</b>\nGmail या UPI में से एक चुनें।`,
  wdAskEmail: `${em.mail} Send <b>your Gmail</b> and <b>amount</b>.\nउदाहरण: <code>yourmail@gmail.com 1000</code>`,
  wdAskUPI: `${em.upi} Send <b>your UPI</b> and <b>amount</b>.\nउदाहरण: <code>yourupi@bank 1000</code>`,
  wdBad: `❌ Format गलत है। सही उदाहरण देखें।`,
  wdLess: `❌ Balance कम है। पहले coins कमाएँ।`,
  wdPlacedEmail: (id, mail, amt)=>`✅ <b>Withdraw request received.</b>\nID: <code>${id}</code>\nEmail: <code>${mail}</code>\nAmount: <b>${amt}</b>\n\n${em.back} Back से menu पर जाएँ।`,
  wdPlacedUPI: (id, upi, amt)=>`✅ <b>Withdraw request received.</b>\nID: <code>${id}</code>\nUPI: <code>${upi}</code>\nAmount: <b>${amt}</b>\n\n${em.back} Back से menu पर जाएँ।`,
  wdApprovedUserEmail: (id, mail)=>`🎊 Your withdrawal #${id} has been <b>APPROVED</b>.\nCheck your email: <b>${mail}</b>.`,
  wdApprovedUserUPI: (id, upi)=>`🎊 Your withdrawal #${id} has been <b>APPROVED</b>.\nUPI sent to: <b>${upi}</b>.`,
  wdRejected: (id)=>`❌ Your withdrawal #${id} was rejected. Coins returned.`,

  adminHome: `🔐 <b>Admin Panel</b>\nUse buttons below.`,
  adminKb: {
    reply_markup:{ inline_keyboard:[
      [{text:"📥 Pending", callback_data:"ad:pending"}, {text:"📢 Broadcast", callback_data:"ad:broadcast"}],
      [{text:"➕ Add Coins", callback_data:"ad:add"}, {text:"➖ Deduct Coins", callback_data:"ad:ded"}],
    ]}
  },
  askUserIdAmt: (mode)=>`Send: <code>${mode} USER_ID AMOUNT</code>`,
  askBroadcast: `Send broadcast text now (HTML allowed).`,
  adminDone: `✅ Done.`,
  topHeader: `👑 <b>Leaderboard</b>`
};

/** ========= Helpers ========= */

function escapeHTML(s=""){
  return s.replace(/[<>&]/g, m=>({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[m]));
}
function maskEmail(mail){
  // keep first 3 & domain, hide middle
  const [u, d] = String(mail).split("@");
  if(!d) return mail;
  const vis = u.slice(0,3);
  return `${vis}***@${d}`;
}
function maskUPI(upi){
  const parts = String(upi).split("@");
  const left = parts[0]||"";
  const bank = parts[1]||"";
  const vis = left.slice(0,3);
  return `${vis}***@${bank}`;
}
function userKey(id){ return `user:${id}` }
function coinsKey(id){ return `coins:${id}` }
function stateKey(id){ return `state:${id}` }
function bonusKey(id){ return `bonus:${id}` }
function wdKey(id){ return `wd:${id}` }
const REF_Z = "refs:z";
const REF_COUNT = (id)=>`refc:${id}`;

/** ========= Join check ========= */
async function isUserJoinedAll(user_id){
  try{
    for (const ch of REQUIRED_CHANNELS){
      const resp = await TG.getMember(ch, user_id);
      const data = await resp.json();
      if(!data.ok) return false;
      const st = data.result.status;
      if(!["member","administrator","creator"].includes(st)) return false;
    }
    return true;
  }catch(e){ return false; }
}

/** ========= User/profile helpers ========= */
function fullName(u){ return [u.first_name,u.last_name].filter(Boolean).join(" ") || (u.username?`@${u.username}`:`${u.id}`); }
function startLink(botUser, uid){
  return `https://t.me/${botUser}?start=${uid}`;
}

/** ========= Menus ========= */
async function showMain(chat_id, name){
  await TG.send(chat_id, txt.main(name), KB.main(name));
}
async function showJoinGate(chat_id, name){
  await TG.send(chat_id, txt.join(name), KB.channels());
}

/** ========= Business logic ========= */
async function ensureUser(user){
  const id = user.id;
  const exists = await redis.get(userKey(id));
  if(!exists){
    await redis.set(userKey(id), JSON.stringify({id, name: fullName(user), username: user.username||""}));
    await redis.set(coinsKey(id), "0");
    await redis.set(REF_COUNT(id), "0");
  }else{
    // keep latest name
    await redis.hset(`u:${id}`, {name: fullName(user), username: user.username||""});
  }
}

async function addCoins(id, amt){
  const cur = parseInt(await redis.get(coinsKey(id))||"0",10);
  const nxt = cur + amt;
  await redis.set(coinsKey(id), String(nxt));
  return nxt;
}
async function subCoins(id, amt){
  const cur = parseInt(await redis.get(coinsKey(id))||"0",10);
  if(cur < amt) return false;
  await redis.set(coinsKey(id), String(cur-amt));
  return true;
}

async function handleReferralIfAny(ctx){
  const msg = ctx.message;
  if(!msg || !msg.text) return;
  const parts = msg.text.trim().split(/\s+/);
  if(parts[0] !== "/start") return;
  const param = parts[1];
  if(!param) return;
  const me = String(msg.from.id);
  const ref = String(param);
  if(ref === me) return;
  const seen = await redis.get(`seen:${me}`);
  if(seen) return; // only first time
  await redis.set(`seen:${me}`,"1");
  // credit referrer
  await redis.zIncrBy(REF_Z, 1, ref);
  const c = parseInt(await redis.get(REF_COUNT(ref))||"0",10)+1;
  await redis.set(REF_COUNT(ref), String(c));
  // notify referrer
  await TG.send(ref, txt.refNoti(fullName(msg.from)));
}

/** ========= Withdraw ========= */
async function placeWithdraw(user, mode, idStr, target, amount){
  const id = await redis.incr("wd:next");
  const wd = {
    id, user_id: user.id, user_name: fullName(user),
    mode, // "email" | "upi"
    target, amount: Number(amount),
    status: "pending", ts: Date.now()
  };
  await redis.hset(wdKey(id), wd);

  // admin card
  const adminText =
`💸 <b>Withdraw Request</b>
ID: <code>${id}</code>
User: <code>${user.id}</code> (${escapeHTML(fullName(user))})
${mode==="email" ? `Email: <code>${target}</code>` : `UPI: <code>${target}</code>`}
Amount: <b>${amount}</b>`;
  const adminKb = {
    reply_markup:{ inline_keyboard:[
      [{text:"✅ Approve", callback_data:`ad:approve:${id}`}],
      [{text:"❌ Reject", callback_data:`ad:reject:${id}`}]
    ]}
  };
  await TG.send(ADMIN_ID, adminText, adminKb);

  // proof channel — just announce "received" masked
  const proofText =
`✅ <b>Withdraw request received.</b>
ID: <b>${id}</b>
User: <code>${user.id}</code> (${escapeHTML(fullName(user))})
${mode==="email" ? `Email: <code>${maskEmail(target)}</code>` : `UPI: <code>${maskUPI(target)}</code>`}
Amount: <b>${amount}</b>`;
  await TG.send(PROOF_CHANNEL, proofText);

  return id;
}

/** ========= Leaderboard ========= */
async function top10(){
  const arr = await redis.zRevRangeWithScores(REF_Z, 0, 9) || [];
  // arr = [member, score, member, score, ...]
  const rows = [];
  for(let i=0;i<arr.length;i+=2){
    const uid = arr[i];
    const score = arr[i+1];
    // try fetch saved name
    const profile = await redis.hgetall(`u:${uid}`);
    const name = profile.name || uid;
    rows.push(`${i/2+1}. ${escapeHTML(name)} - <b>${score}</b> refs`);
  }
  return rows.length? rows.join("\n"): "— No refs yet —";
}

/** ========= Handler ========= */
export default async function handler(req){
  const url = new URL(req.url);
  if(url.searchParams.get("secret") !== SECRET){
    return new Response(JSON.stringify({ok:false, error:"bad secret"}), {status:401});
  }

  if(req.method === "GET"){
    return new Response(JSON.stringify({ok:true, hello:"telegram"}), {status:200});
  }

  if(req.method !== "POST"){
    return new Response("Method not allowed", {status:405});
  }

  const update = await req.json().catch(()=> ({}));

  // Messages
  if(update.message){
    const m = update.message;
    const from = m.from;
    const chat_id = m.chat.id;

    await ensureUser(from);
    await handleReferralIfAny({message:m});

    // Global join-gate only on /start
    if(m.text === "/start"){
      const joined = await isUserJoinedAll(from.id);
      if(!joined){
        await showJoinGate(chat_id, fullName(from));
      }else{
        await showMain(chat_id, fullName(from));
      }
      return resOK();
    }

    // If user is in an input state (awaiting email/upi)
    const st = await redis.get(stateKey(from.id));
    if(st){
      const state = JSON.parse(st);
      const text = (m.text||"").trim();
      if(state.type === "wd_email"){
        const match = text.match(/^\s*([^\s@]+@[^\s@]+\.[^\s]+)\s+(\d+)\s*$/i);
        if(!match){ await TG.send(chat_id, txt.wdBad, KB.back); return resOK(); }
        const email = match[1], amt = parseInt(match[2],10);
        const ok = await subCoins(from.id, amt);
        if(!ok){ await TG.send(chat_id, txt.wdLess, KB.back); return resOK(); }
        const id = await placeWithdraw(from, "email", String(from.id), email, amt);
        await redis.del(stateKey(from.id));
        await TG.send(chat_id, txt.wdPlacedEmail(id, email, amt), KB.back);
        return resOK();
      }
      if(state.type === "wd_upi"){
        const match = text.match(/^\s*([a-zA-Z0-9.\-_]+@[a-zA-Z]+)\s+(\d+)\s*$/);
        if(!match){ await TG.send(chat_id, txt.wdBad, KB.back); return resOK(); }
        const upi = match[1], amt = parseInt(match[2],10);
        const ok = await subCoins(from.id, amt);
        if(!ok){ await TG.send(chat_id, txt.wdLess, KB.back); return resOK(); }
        const id = await placeWithdraw(from, "upi", String(from.id), upi, amt);
        await redis.del(stateKey(from.id));
        await TG.send(chat_id, txt.wdPlacedUPI(id, upi, amt), KB.back);
        return resOK();
      }

      // admin flows
      if(state.type==="ad_add" || state.type==="ad_ded"){
        const match = text.match(/^\s*(\d+)\s+(\d+)\s*$/);
        if(!match){ await TG.send(chat_id, "Format: <code>USER_ID AMOUNT</code>", KB.back); return resOK(); }
        const uid = match[1], amt = parseInt(match[2],10);
        if(state.type==="ad_add"){ await addCoins(uid, amt); }
        else { await subCoins(uid, amt); }
        await redis.del(stateKey(from.id));
        await TG.send(chat_id, txt.adminDone, KB.back);
        return resOK();
      }
      if(state.type==="ad_bc"){
        await redis.del(stateKey(from.id));
        // naive broadcast: we don't have user list except who started; we can iterate top Z set + admin + this user
        // For demo, send to this chat and proof channel:
        await TG.send(PROOF_CHANNEL, `<b>Broadcast:</b>\n${text}`);
        await TG.send(chat_id, "✅ Broadcast sent (demo).", KB.back);
        return resOK();
      }
    }

    // Normal commands typed
    if(m.text === "/menu"){
      await showMain(chat_id, fullName(from)); return resOK();
    }
    if(m.text === "/balance"){
      const c = parseInt(await redis.get(coinsKey(from.id))||"0",10);
      await TG.send(chat_id, txt.balance(c), KB.back); return resOK();
    }
    if(m.text === "/bonus"){
      const last = parseInt(await redis.get(bonusKey(from.id))||"0",10);
      const now = Date.now();
      if(now - last < 24*60*60*1000){
        const mins = Math.ceil((24*60*60*1000 - (now-last))/60000);
        await TG.send(chat_id, txt.bonusWait(mins), KB.back); return resOK();
      }
      const credited = 50;
      const total = await addCoins(from.id, credited);
      await redis.set(bonusKey(from.id), String(now));
      await TG.send(chat_id, txt.bonusOk(credited,total), KB.back); return resOK();
    }
    if(m.text === "/withdraw"){
      await TG.send(chat_id, txt.wdChoose, KB.withdrawMenu); return resOK();
    }
    if(m.text === "/refer" || m.text==="/ref"){
      const meName = fullName(from);
      const botUser = (await (await TG.api("getMe",{})).json()).result.username;
      const count = parseInt(await redis.get(REF_COUNT(from.id))||"0",10);
      const link = startLink(botUser, from.id);
      await TG.send(chat_id, txt.ref(meName, link, count), KB.back);
      return resOK();
    }
    if(m.text === "/leaderboard" || m.text==="/top"){
      const body = await top10();
      await TG.send(chat_id, `${txt.topHeader}\n${body}`, KB.back); return resOK();
    }

    // Admin enter
    if(String(from.id)===ADMIN_ID && m.text==="/admin"){
      await TG.send(chat_id, txt.adminHome, txt.adminKb); return resOK();
    }

    // Fallback
    await TG.send(chat_id, "✅ Ping reply OK");
    return resOK();
  }

  // Callback queries
  if(update.callback_query){
    const cb = update.callback_query;
    const data = cb.data || "";
    const uid = cb.from.id;
    const chat_id = cb.message.chat.id;
    const mid = cb.message.message_id;

    // menus
    if(data==="menu:home"){
      await TG.edit(chat_id, mid, txt.main(fullName(cb.from)), KB.main(fullName(cb.from)));
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="menu:channels"){
      await TG.edit(chat_id, mid, txt.join(fullName(cb.from)), KB.channels());
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="chk:claim"){
      const ok = await isUserJoinedAll(uid);
      if(!ok){ await TG.answerCb(cb.id, "❗ अभी सभी चैनलों में joined नहीं हो।", true); return resOK(); }
      await TG.edit(chat_id, mid, txt.joinedOk, KB.back);
      await showMain(chat_id, fullName(cb.from));
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="menu:balance"){
      const c = parseInt(await redis.get(coinsKey(uid))||"0",10);
      await TG.edit(chat_id, mid, txt.balance(c), KB.back);
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="menu:bonus"){
      await TG.edit(chat_id, mid, txt.bonusAsk, {
        reply_markup:{ inline_keyboard:[
          [{text:`${em.gift} Claim Bonus`, callback_data:"do:bonus"}],
          [{text:`${em.back} Back`, callback_data:"menu:home"}]
        ]}
      });
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="do:bonus"){
      const last = parseInt(await redis.get(bonusKey(uid))||"0",10);
      const now = Date.now();
      if(now - last < 24*60*60*1000){
        const mins = Math.ceil((24*60*60*1000 - (now-last))/60000);
        await TG.answerCb(cb.id, `Wait ~${mins} min`, true); return resOK();
      }
      const credited = 50;
      const total = await addCoins(uid, credited);
      await redis.set(bonusKey(uid), String(now));
      await TG.edit(chat_id, mid, txt.bonusOk(credited,total), KB.back);
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="menu:ref"){
      const botUser = (await (await TG.api("getMe",{})).json()).result.username;
      const count = parseInt(await redis.get(REF_COUNT(uid))||"0",10);
      const link = startLink(botUser, uid);
      await TG.edit(chat_id, mid, txt.ref(fullName(cb.from), link, count), KB.back);
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="menu:withdraw"){
      await TG.edit(chat_id, mid, txt.wdChoose, KB.withdrawMenu);
      await TG.answerCb(cb.id); return resOK();
    }
    if(data.startsWith("wd:choose:")){
      const t = data.split(":")[2];
      if(t==="email"){
        await redis.set(stateKey(uid), JSON.stringify({type:"wd_email"}));
        await TG.edit(chat_id, mid, txt.wdAskEmail, KB.back);
      }else{
        await redis.set(stateKey(uid), JSON.stringify({type:"wd_upi"}));
        await TG.edit(chat_id, mid, txt.wdAskUPI, KB.back);
      }
      await TG.answerCb(cb.id); return resOK();
    }
    if(data==="menu:top"){
      const body = await top10();
      await TG.edit(chat_id, mid, `${txt.topHeader}\n${body}`, KB.back);
      await TG.answerCb(cb.id); return resOK();
    }

    // Admin callbacks
    if(String(uid)===ADMIN_ID && data==="ad:pending"){
      // Simple list: Upstash में ids scan नहीं कर रहे; admin को जैसे-जैसे आए वैसे approve/reject दिखता है.
      await TG.answerCb(cb.id, "Open latest requests (shown on arrival).", true); return resOK();
    }
    if(String(uid)===ADMIN_ID && data==="ad:broadcast"){
      await redis.set(stateKey(uid), JSON.stringify({type:"ad_bc"}));
      await TG.edit(chat_id, mid, txt.askBroadcast, KB.back);
      await TG.answerCb(cb.id); return resOK();
    }
    if(String(uid)===ADMIN_ID && data==="ad:add"){
      await redis.set(stateKey(uid), JSON.stringify({type:"ad_add"}));
      await TG.edit(chat_id, mid, txt.askUserIdAmt("ADD"), KB.back);
      await TG.answerCb(cb.id); return resOK();
    }
    if(String(uid)===ADMIN_ID && data==="ad:ded"){
      await redis.set(stateKey(uid), JSON.stringify({type:"ad_ded"}));
      await TG.edit(chat_id, mid, txt.askUserIdAmt("DED"), KB.back);
      await TG.answerCb(cb.id); return resOK();
    }
    if(String(uid)===ADMIN_ID && (data.startsWith("ad:approve:") || data.startsWith("ad:reject:"))){
      const id = data.split(":").pop();
      const wd = await redis.hgetall(wdKey(id));
      if(!wd || !wd.id){ await TG.answerCb(cb.id, "Not found", true); return resOK(); }
      if(data.startsWith("ad:approve:")){
        // approve
        await redis.hset(wdKey(id), {status:"approved"});
        // user notify + proof "paid"
        if(wd.mode==="email"){
          await TG.send(wd.user_id, txt.wdApprovedUserEmail(id, wd.target));
          await TG.send(PROOF_CHANNEL,
`✅ <b>Withdrawal Paid</b>
ID: <b>${id}</b>
User: <code>${wd.user_id}</code> (${escapeHTML(wd.user_name)})
Email: <code>${maskEmail(wd.target)}</code>
Amount: <b>${wd.amount}</b>`);
        }else{
          await TG.send(wd.user_id, txt.wdApprovedUserUPI(id, wd.target));
          await TG.send(PROOF_CHANNEL,
`✅ <b>Withdrawal Paid</b>
ID: <b>${id}</b>
User: <code>${wd.user_id}</code> (${escapeHTML(wd.user_name)})
UPI: <code>${maskUPI(wd.target)}</code>
Amount: <b>${wd.amount}</b>`);
        }
        await TG.answerCb(cb.id, "Approved ✅", false);
      }else{
        // reject: refund
        await redis.hset(wdKey(id), {status:"rejected"});
        await addCoins(wd.user_id, parseInt(wd.amount,10));
        await TG.send(wd.user_id, txt.wdRejected(id));
        await TG.answerCb(cb.id, "Rejected ❌", false);
      }
      return resOK();
    }

    // Open admin panel
    if(String(uid)===ADMIN_ID && data==="menu:home"){
      await TG.edit(chat_id, mid, txt.adminHome, txt.adminKb);
      await TG.answerCb(cb.id); return resOK();
    }

    await TG.answerCb(cb.id);
    return resOK();
  }

  return resOK();
}

function resOK(){ return new Response(JSON.stringify({ok:true}), {status:200}); }
