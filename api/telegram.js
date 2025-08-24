// api/telegram.js
export const config = { api: { bodyParser: false } };

// ===== ENV =====
const TOKEN = process.env.BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

// ===== FORCE-JOIN CHANNELS =====
const REQUIRED_CHANNELS = [
  { username: "free_redeem_codes_fire_crypto", url: "https://t.me/free_redeem_codes_fire_crypto" },
  { username: "Withdrawal_Proofsj", url: "https://t.me/Withdrawal_Proofsj" },
  { username: "loot4udeal", url: "https://t.me/loot4udeal" }
];

// ===== PROOF CHANNEL =====
const PROOF_CHANNEL_USERNAME = "Withdrawal_Proofsj";
const PROOF_CHANNEL_LINK = "https://t.me/Withdrawal_Proofsj";

// ===== BONUS CONFIG =====
const REF_BONUS_REF = 50;
const REF_BONUS_NEW = 25;
const DAILY_BONUS = 10;
const MIN_WITHDRAW = 500;

// ===== TELEGRAM HELPERS =====
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
  getMember: (chat, user_id) =>
    fetch(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${user_id}`)
      .then(r => r.json()),
};

// ===== REDIS HELPERS =====
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

// ===== KEYS =====
const k = {
  payload: uid => `payload:${uid}`,
  coins: uid => `coins:${uid}`,
  credited: uid => `credited:${uid}`,
  daily: uid => `daily:${uid}`,
  users: () => `users_all`,
  refCount: uid => `ref:${uid}`,
  name: uid => `name:${uid}`,
  wseq: () => `w:seq`,
  w: wid => `w:${wid}`,
};

// ===== COINS =====
async function getCoins(uid) { return Number(await rget(k.coins(uid)) || 0); }
async function addCoins(uid, amt) { return rincrby(k.coins(uid), amt); }

// ===== JOIN GATE =====
async function isJoinedAll(userId) {
  for (const c of REQUIRED_CHANNELS) {
    const j = await TG.getMember(`@${c.username}`, userId);
    if (!j.ok) return false;
    const st = j.result?.status;
    if (!["creator","administrator","member"].includes(st)) return false;
  }
  return true;
}
function joinGateKb() {
  const rows = REQUIRED_CHANNELS.map(c => [{ text: "Join", url: c.url }]);
  rows.push([{ text: "✅ Claim", callback_data: "gate:claim" }]);
  return { reply_markup: { inline_keyboard: rows } };
}
async function showJoinGate(chatId) {
  return TG.send(chatId, "🟢 Must Join All Channels To Use Bot\n◼️ After joining click <b>Claim</b>", joinGateKb());
}

// ===== MAIN MENU =====
function mainMenuKb() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📣 Channels", callback_data: "open:channels" }, { text: "📑 Proofs", callback_data: "open:proofs" }],
        [{ text: "💰 Balance", callback_data: "open:balance" }, { text: "🎁 Daily Bonus", callback_data: "open:daily" }],
        [{ text: "👥 Referral", callback_data: "open:ref" }, { text: "💸 Withdraw", callback_data: "open:wd" }],
        [{ text: "🏆 Leaderboard", callback_data: "open:leader" }],
      ],
    },
  };
}
const backKb = { reply_markup: { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "back:main" }]] } };
async function sendMainMenu(chatId) {
  return TG.send(chatId, "Welcome 👋\nEarn via referrals & daily bonus; redeem by withdraw.", mainMenuKb());
}

// ===== REFERRAL =====
async function applyReferral(uid, name) {
  const payload = await rget(k.payload(uid));
  if (!payload || !payload.startsWith("ref_")) return;
  const refId = payload.slice(4);
  if (refId === String(uid)) return;
  const already = await rget(k.credited(uid));
  if (already) return;
  await addCoins(uid, REF_BONUS_NEW);
  await addCoins(refId, REF_BONUS_REF);
  await rincrby(k.refCount(refId), 1);
  if (name) await rset(k.name(uid), name);
  await rset(k.credited(uid), "1");
}

// ===== WITHDRAW HELPERS =====
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
function maskEmail(email) {
  const [u,d] = email.split("@");
  return u.slice(0,3)+"***@"+d;
}
function maskUpi(upi) {
  return upi.slice(0,3)+"***"+upi.slice(-3);
}

// ===== HANDLERS =====
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const uname = msg.from.first_name || "User";
  const parts = (msg.text||"").split(" ");
  if (parts[1]) await rset(k.payload(uid), parts[1]);

  // हर बार पहले gate check
  const ok = await isJoinedAll(uid);
  if (!ok) return showJoinGate(chatId);

  await applyReferral(uid, uname);
  await rset(k.name(uid), uname);
  return sendMainMenu(chatId);
}
async function handleGateClaim(cb) {
  const ok = await isJoinedAll(cb.from.id);
  if (!ok) return showJoinGate(cb.message.chat.id);
  await applyReferral(cb.from.id, cb.from.first_name);
  await rset(k.name(cb.from.id), cb.from.first_name);
  await sendMainMenu(cb.message.chat.id);
}

// ===== SECTIONS =====
async function openSection(section, cb) {
  const chatId = cb.message.chat.id;
  const uid = cb.from.id;

  if (section==="proofs") {
    return TG.send(chatId,"📑 Withdrawal proofs:",{
      reply_markup:{inline_keyboard:[
        [{text:"🔗 Open Proof Channel",url:PROOF_CHANNEL_LINK}],
        [{text:"⬅️ Back",callback_data:"back:main"}]
      ]}
    });
  }
  if (section==="balance") {
    const coins=await getCoins(uid);
    return TG.send(chatId,`💰 Balance: <b>${coins}</b> coins`,backKb);
  }
  if (section==="daily") {
    const today=new Date().toISOString().slice(0,10);
    const last=await rget(k.daily(uid));
    if(last===today) return TG.send(chatId,"✅ Already claimed today",backKb);
    await rset(k.daily(uid),today);
    const bal=await addCoins(uid,DAILY_BONUS);
    return TG.send(chatId,`+${DAILY_BONUS} coins added!\nNew balance: <b>${bal}</b>`,backKb);
  }
  if (section==="ref") {
    const me=cb.from.id;
    const botInfo=await TG.api("getMe",{});
    const botUser=botInfo?.result?.username;
    const link=`https://t.me/${botUser}?start=ref_${me}`;
    const count=await rget(k.refCount(me))||0;
    return TG.send(chatId,`👥 Referral link:\n<code>${link}</code>\nRefs: <b>${count}</b>`,backKb);
  }
  if (section==="leader") {
    const users=await rsmembers(k.users());
    const arr=[];
    for(const u of users){
      const c=Number(await rget(k.refCount(u))||0);
      const nm=await rget(k.name(u))||u;
      arr.push({nm,c});
    }
    arr.sort((a,b)=>b.c-a.c);
    const top=arr.slice(0,10);
    let txt="🏆 Leaderboard\n";
    let i=1;
    for(const t of top){
      txt+=`${i}. ${t.nm} - ${t.c} refs\n`;
      i++;
    }
    return TG.send(chatId,txt,backKb);
  }
  if (section==="wd") {
    return TG.send(chatId,"Choose withdraw method:",{
      reply_markup:{inline_keyboard:[
        [{text:"💌 Gmail Withdraw",callback_data:"wd:gmail"}],
        [{text:"🏦 UPI Withdraw",callback_data:"wd:upi"}],
        [{text:"⬅️ Back",callback_data:"back:main"}]
      ]}
    });
  }
}

// ===== WITHDRAW FLOW =====
async function handleWithdrawFlow(cb) {
  const chatId=cb.message.chat.id;
  if(cb.data==="wd:gmail") return TG.send(chatId,"Send Gmail like:\n<code>/gmail yourmail@gmail.com amount</code>",backKb);
  if(cb.data==="wd:upi") return TG.send(chatId,"Send UPI like:\n<code>/upi upi@okicici amount</code>",backKb);
}

// ===== WITHDRAW CMD =====
async function handleWithdrawCmd(msg){
  const chatId=msg.chat.id;
  const uid=msg.from.id;
  const parts=(msg.text||"").trim().split(/\s+/);

  if(parts[0]==="/gmail"){
    const email=parts[1]; const amt=Number(parts[2]);
    const coins=await getCoins(uid);
    if(coins<amt||amt<MIN_WITHDRAW) return TG.send(chatId,"❌ Not enough balance or below minimum",backKb);
    await addCoins(uid,-amt);
    const wid=await newWithdrawId();
    const req={id:wid,uid,email,upi:null,amt,status:"pending"};
    await saveWithdraw(wid,req);
    await TG.send(chatId,`✅ Withdraw request ID ${wid} submitted (Email).`,backKb);
    await TG.send(ADMIN_ID,`Req #${wid}\nUser:${uid}\nEmail:${email}\nAmt:${amt}`,{
      reply_markup:{inline_keyboard:[
        [{text:"Approve",callback_data:"adm:approve:"+wid},{text:"Reject",callback_data:"adm:reject:"+wid}]
      ]}
    });
  }

  if(parts[0]==="/upi"){
    const upi=parts[1]; const amt=Number(parts[2]);
    const coins=await getCoins(uid);
    if(coins<amt||amt<MIN_WITHDRAW) return TG.send(chatId,"❌ Not enough balance or below minimum",backKb);
    await addCoins(uid,-amt);
    const wid=await newWithdrawId();
    const req={id:wid,uid,email:null,upi,amt,status:"pending"};
    await saveWithdraw(wid,req);
    await TG.send(chatId,`✅ Withdraw request ID ${wid} submitted (UPI).`,backKb);
    await TG.send(ADMIN_ID,`Req #${wid}\nUser:${uid}\nUPI:${upi}\nAmt:${amt}`,{
      reply_markup:{inline_keyboard:[
        [{text:"Approve",callback_data:"adm:approve:"+wid},{text:"Reject",callback_data:"adm:reject:"+wid}]
      ]}
    });
  }
}

// ===== ADMIN ACTION =====
async function onAdminApprove(wid){
  const w=await loadWithdraw(wid);
  if(!w||w.status!=="pending") return;
  w.status="approved"; await saveWithdraw(wid,w);
  let masked=w.email?maskEmail(w.email):maskUpi(w.upi);
  await TG.send(`@${PROOF_CHANNEL_USERNAME}`,`✅ Paid #${w.id}\nUser:${w.uid}\n${masked}\nAmt:${w.amt}`);
  await TG.send(w.uid,`🎉 Withdraw #${w.id} Approved.`);
}
async function onAdminReject(wid){
  const w=await loadWithdraw(wid);
  if(!w||w.status!=="pending") return;
  w.status="rejected"; await saveWithdraw(wid,w);
  await addCoins(w.uid,w.amt);
  await TG.send(w.uid,`🚫 Withdraw #${w.id} Rejected. Refunded.`);
}

// ===== ADMIN COMMANDS =====
async function handleAdminCommands(msg) {
  if (msg.from.id !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  const text = (msg.text||"").trim();

  if(text.startsWith("/add ")){
    const [,id,amt]=text.split(" ");
    await addCoins(id,Number(amt));
    const bal=await getCoins(id);
    return TG.send(chatId,`Added ${amt} → ${id} balance: ${bal}`);
  }
  if(text.startsWith("/deduct ")){
    const [,id,amt]=text.split(" ");
    await addCoins(id,-Number(amt));
    const bal=await getCoins(id);
    return TG.send(chatId,`Deducted ${amt} → ${id} balance: ${bal}`);
  }
  if(text.startsWith("/bal ")){
    const [,id]=text.split(" ");
    const bal=await getCoins(id);
    return TG.send(chatId,`${id} balance: ${bal}`);
  }
  if(text.startsWith("/broadcast ")){
    const message=text.replace("/broadcast ","");
    const users=await rsmembers(k.users());
    for(const u of users) await TG.send(u,`📣 ${message}`).catch(()=>{});
    return TG.send(chatId,`Broadcast sent to ${users.length}`);
  }
  if(text.startsWith("/help")){
    return TG.send(chatId,"Admin commands:\n/add id amt\n/deduct id amt\n/bal id\n/broadcast msg");
  }
}

// ===== MAIN HANDLER =====
async function parseBody(req){const chunks=[];for await(const c of req)chunks.push(c);return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");}
export default async function handler(req,res){
  const url=new URL(req.url,"http://localhost");
  if(SECRET && url.searchParams.get("secret")!==SECRET) return res.status(401).json({ok:false});
  if(req.method!=="POST") return res.status(200).json({ok:true});
  const u=await parseBody(req);

  if(u.message){
    const m=u.message; const t=m.text||"";
    if(m.from.id===ADMIN_ID && /^\/(add|deduct|bal|broadcast|help)/.test(t)) await handleAdminCommands(m);
    if(t.startsWith("/start")) await handleStart(m);
    if(t.startsWith("/gmail")||t.startsWith("/upi")) await handleWithdrawCmd(m);
  }
  if(u.callback_query){
    const cb=u.callback_query; const d=cb.data;
    if(d==="gate:claim") await handleGateClaim(cb);
    if(d.startsWith("open:")) await openSection(d.split(":")[1],cb);
    if(d.startsWith("wd:")) await handleWithdrawFlow(cb);
    if(d==="back:main") await sendMainMenu(cb.message.chat.id);
    if(d.startsWith("adm:approve:")) await onAdminApprove(d.split(":")[2]);
    if(d.startsWith("adm:reject:")) await onAdminReject(d.split(":")[2]);
  }
  return res.status(200).json({ok:true});
}
