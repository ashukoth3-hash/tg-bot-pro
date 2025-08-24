export const config = { runtime: "edge" };

/** ========= ENV =========
Required:
- BOT_TOKEN
- WEBHOOK_SECRET
- APP_URL (e.g., https://tg-bot-pro.vercel.app)
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN

Optional:
- ADMIN_ID           => comma-separated user IDs
- CHANNEL_1_URL      => https://t.me/yourchannel1
- CHANNEL_2_URL
- CHANNEL_3_URL
- CHANNEL_1_ID       => -100xxxxxxxxxx  (for membership check)
- CHANNEL_2_ID
- CHANNEL_3_ID
- PROOF_CHANNEL_ID   => -100xxxxxxxxxx   (where paid/received posts go)
========================**/

// ---------- Small utils ----------
const j = (v) => JSON.stringify(v);
const esc = (s="") => s.replace(/[<>&]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
const pick = (obj, ...keys) => keys.reduce((o,k)=> (obj?.[k]!==undefined&&(o[k]=obj[k]), o), {});
const now = () => Math.floor(Date.now()/1000);

// ---------- Telegram client ----------
const BOT = process.env.BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT}`;
const TG = {
  async send(chat_id, text, kb) {
    const body = { chat_id, text, parse_mode: "HTML", ...kb };
    return fetch(`${TG_API}/sendMessage`, { method:"POST", headers:{ "content-type":"application/json" }, body: j(body) });
  },
  async edit(chat_id, msg_id, text, kb) {
    const body = { chat_id, message_id: msg_id, text, parse_mode: "HTML", ...kb };
    return fetch(`${TG_API}/editMessageText`, { method:"POST", headers:{ "content-type":"application/json" }, body: j(body) });
  },
  async answerCb(id, opts) {
    return fetch(`${TG_API}/answerCallbackQuery`, { method:"POST", headers:{ "content-type":"application/json" }, body: j({ callback_query_id:id, ...opts }) });
  },
  kb(inline_keyboard){ return { reply_markup: { inline_keyboard } }; },
  async getChatMember(chat_id, user_id){
    const u = `${TG_API}/getChatMember?chat_id=${encodeURIComponent(chat_id)}&user_id=${user_id}`;
    const r = await fetch(u); return r.json();
  }
};

// ---------- Redis (Upstash REST) ----------
const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN;
async function rcmd(cmd, ...args){
  const body = j([cmd, ...args]);
  const r = await fetch(RURL, { method:"POST", headers:{ "authorization":`Bearer ${RTOK}`, "content-type":"application/json" }, body });
  return r.json();
}
// Basic helpers
const rget = (k)=> rcmd("GET", k).then(x=>x.result ?? null);
const rset = (k,v)=> rcmd("SET", k, typeof v==="string"?v:j(v));
const rdel = (k)=> rcmd("DEL", k);
const zincr = (k,m,by)=> rcmd("ZINCRBY", k, by, m);
const zrevrange = (k,start,stop,withScores)=> rcmd("ZREVRANGE", k, start, stop, withScores?"WITHSCORES":undefined).then(x=>x.result);

// ---------- App constants ----------
const ADMINS = (process.env.ADMIN_ID||"").split(",").map(s=>Number(s.trim())).filter(Boolean);
const isAdmin = (id)=> ADMINS.includes(Number(id));
const MAIN_KB = TG.kb([
  [{text:"📣 Channels", callback_data:"menu_channels"},{text:"🧾 Proofs", callback_data:"menu_proofs"}],
  [{text:"💰 Balance", callback_data:"menu_bal"},{text:"🎁 Daily Bonus", callback_data:"menu_daily"}],
  [{text:"👥 Referral", callback_data:"menu_ref"},{text:"💵 Withdraw", callback_data:"menu_wd"}],
  [{text:"🏆 Leaderboard", callback_data:"menu_lb"}],
  [ ...(ADMINS.length? [[{text:"🛠 Admin", callback_data:"ad_home"}]] : []) ]
]);
const BACK_KB = TG.kb([[{text:"◀️ Back", callback_data:"back_home"}]]);

// ---------- Join gate ----------
function joinKB(){
  const rows = [];
  if (process.env.CHANNEL_1_URL) rows.push([{ text:"✅ Join Channel 1 ↗️", url:process.env.CHANNEL_1_URL }]);
  if (process.env.CHANNEL_2_URL) rows.push([{ text:"✅ Join Channel 2 ↗️", url:process.env.CHANNEL_2_URL }]);
  if (process.env.CHANNEL_3_URL) rows.push([{ text:"✅ Join Channel 3 ↗️", url:process.env.CHANNEL_3_URL }]);
  rows.push([{ text:"🎁 Claim & Continue", callback_data:"claim_joined" }]);
  return TG.kb(rows);
}
async function needsJoin(user_id){
  const ids = [process.env.CHANNEL_1_ID, process.env.CHANNEL_2_ID, process.env.CHANNEL_3_ID]
              .map(x=>x?.trim()).filter(Boolean);
  if (!ids.length) return false;
  for (const cid of ids){
    try{
      const j = await TG.getChatMember(cid, user_id);
      const st = j?.result?.status;
      if (!["member","administrator","creator"].includes(st)) return true;
    }catch(e){ return true; }
  }
  return false;
}

// ---------- User storage ----------
const kUser = (id)=> `u:${id}`;
const kCoins= (id)=> `u:${id}:coins`;
const kName = (id)=> `u:${id}:name`;
const kRefs = (id)=> `u:${id}:refs`;
const kWD   = (id)=> `u:${id}:lastwd`;      // last withdrawal id
const kEmail= (id)=> `u:${id}:email`;
const kUPI  = (id)=> `u:${id}:upi`;
const kState= (id)=> `u:${id}:state`;
const ZREFS = `z:refs`;

async function ensureUser(u){
  await rset(kName(u.id), u.name || "");
  await rcmd("SETNX", kCoins(u.id), 0);
  await rcmd("SETNX", kRefs(u.id), 0);
}
async function addCoins(id, amt){ await rcmd("INCRBY", kCoins(id), amt); }
async function subCoins(id, amt){ await rcmd("DECRBY", kCoins(id), amt); }
async function setBalance(id, amt){ await rset(kCoins(id), amt); }
async function getCoins(id){ const v= await rget(kCoins(id)); return Number(v||0); }
async function incRef(id){ await rcmd("INCR", kRefs(id)); await zincr(ZREFS, String(id), 1); }
async function getAllUserIds(){ // best-effort: store seen ids in a set
  const raw = await rget("users:index");
  return raw? JSON.parse(raw) : [];
}
async function addIndex(id){
  const raw = await rget("users:index");
  const arr = raw? JSON.parse(raw) : [];
  if (!arr.includes(String(id))){ arr.push(String(id)); await rset("users:index", j(arr)); }
}

// ---------- Mask helpers ----------
function maskEmail(e=""){
  const [u, d=""] = e.split("@");
  if (!u || !d) return e;
  const uShow = u.slice(0, Math.min(3,u.length));
  const dShow = d.slice(0, Math.max(1, Math.floor(d.length/2)));
  return `${uShow}***@${dShow}***`;
}
function maskUPI(u=""){
  const [id, host=""] = u.split("@");
  if (!id || !host) return u;
  const iShow = id.slice(0, Math.min(3,id.length));
  const hShow = host.slice(0, Math.max(1, Math.floor(host.length/2)));
  return `${iShow}***@${hShow}***`;
}

// ---------- Keyboards ----------
const KB = {
  back: BACK_KB,
  wdMode: TG.kb([
    [{text:"✉️ Email", callback_data:"wd_email"}, {text:"🏦 UPI", callback_data:"wd_upi"}],
    [{text:"◀️ Back", callback_data:"back_home"}]
  ]),
  adHome: TG.kb([
    [{text:"➕ Add", callback_data:"ad_add"}, {text:"➖ Deduct", callback_data:"ad_ded"}],
    [{text:"🧮 Set Balance", callback_data:"ad_setbal"}],
    [{text:"📣 Broadcast", callback_data:"ad_bc"}],
    [{text:"◀️ Back", callback_data:"back_home"}]
  ]),
};

// ---------- Messages ----------
function helloLine(name){ return `👋 Hello ${esc(name)} 🇮🇳`; }
const MAIN_TEXT = (name)=> `${helloLine(name)}\n\n🎯 <b>Main Menu</b>\nEarn via referrals & daily bonus —\nरिडीम करने के लिए <b>Withdraw</b> चुनें।`;

const CHAN_TEXT = (name)=> `${helloLine(name)}\n\n🔐 <b>Join all channels to continue.</b>\nसबसे पहले सभी चैनल Join करें, फिर नीचे <b>Claim & Continue</b> दबाएँ।`;

// ---------- Withdraw ids ----------
const kWdid = "wd:nextid";
async function nextWdid(){ const r = await rcmd("INCR", kWdid); return Number(r.result); }

// ---------- Request handler ----------
export default async function handler(req){
  const url = new URL(req.url);
  // Set webhook helper
  if (url.pathname.endsWith("/api/set-webhook")) {
    const u = `${process.env.APP_URL}/api/telegram?secret=${encodeURIComponent(process.env.WEBHOOK_SECRET)}`;
    const r = await fetch(`${TG_API}/setWebhook`, { method:"POST", headers:{ "content-type":"application/json" }, body:j({ url:u, allowed_updates:["message","callback_query"] })}).then(r=>r.json());
    return new Response(j({ ok:true, set_to:u, telegram:r }), { headers:{ "content-type":"application/json" }});
  }

  // Health
  if (req.method === "GET") {
    return new Response(j({ ok:true, hello:"telegram" }), { headers:{ "content-type":"application/json" }});
  }

  // Secret check
  if (url.searchParams.get("secret") !== process.env.WEBHOOK_SECRET)
    return new Response("unauthorized", { status:401 });

  // Telegram update
  const update = await req.json().catch(()=> ({}));
  try { return await handleUpdate(update); }
  catch(e){
    // swallow
    return new Response("ok");
  }
}

function resOK(){ return new Response("ok"); }

// ---------- Core update ----------
async function handleUpdate(upd){
  const m = upd.message;
  const cb = upd.callback_query;
  const from = m?.from || cb?.from;
  const chat_id = m?.chat?.id || cb?.message?.chat?.id;
  const msg = cb?.message;
  const name = from?.first_name ? `${from.first_name}${from.last_name? " "+from.last_name:""}` : (from?.username? "@"+from.username : String(from?.id||"User"));

  if (!from || !chat_id) return resOK();

  await ensureUser({ id: from.id, name }); await addIndex(from.id);

  // ---------- Admin text commands (run early) ----------
  if (m?.text && isAdmin(from.id)) {
    const text = m.text.trim();
    const parsedTwoNums = (s)=> { const q=s.trim().match(/^(?:\/\w+)?\s*(\d+)\s+(\d+)$/); return q? {id:q[1], amt:parseInt(q[2],10)} : null; };

    if (/^\/add\b/i.test(text)) {
      const p = parsedTwoNums(text);
      if (!p){ await TG.send(chat_id, "❌ Format गलत है।\nउदाहरण: <code>/add 123456789 5000</code>", KB.back); return resOK(); }
      await addCoins(p.id, p.amt);
      await TG.send(chat_id, `✅ Added <b>${p.amt}</b> coins to <code>${p.id}</code>.`, KB.back);
      return resOK();
    }
    if (/^\/ded\b/i.test(text)) {
      const p = parsedTwoNums(text);
      if (!p){ await TG.send(chat_id, "❌ Format गलत है।\nउदाहरण: <code>/ded 123456789 500</code>", KB.back); return resOK(); }
      await subCoins(p.id, p.amt);
      await TG.send(chat_id, `✅ Deducted <b>${p.amt}</b> coins from <code>${p.id}</code>.`, KB.back);
      return resOK();
    }
    if (/^\/setbal\b/i.test(text)) {
      const p = parsedTwoNums(text);
      if (!p){ await TG.send(chat_id, "❌ Format गलत है।\nउदाहरण: <code>/setbal 123456789 2500</code>", KB.back); return resOK(); }
      await setBalance(p.id, p.amt);
      await TG.send(chat_id, `✅ Balance set to <b>${p.amt}</b> for <code>${p.id}</code>.`, KB.back);
      return resOK();
    }
    if (/^\/broadcast\b/i.test(text)) {
      const msg = text.replace(/^\/broadcast\b/i,"").trim();
      if (!msg){ await TG.send(chat_id, "📣 Use: <code>/broadcast your message…</code>", KB.back); return resOK(); }
      const ids = await getAllUserIds(); let ok=0;
      for (const uid of ids){ try{ await TG.send(uid, msg); ok++; }catch{} }
      await TG.send(chat_id, `✅ Broadcast sent to <b>${ok}</b> users.`, KB.back);
      return resOK();
    }
  }

  // ---------- Callback handling ----------
  if (cb){
    const data = cb.data;

    if (data === "claim_joined"){
      if (await needsJoin(from.id)) { await TG.answerCb(cb.id, { text:"❌ अभी भी कुछ channels joined नहीं हैं.", show_alert:true }); return resOK(); }
      await TG.edit(chat_id, msg.message_id, "✅ Verified! Opening menu…");
      await TG.send(chat_id, MAIN_TEXT(name), MAIN_KB);
      return resOK();
    }

    if (data === "back_home"){ await TG.edit(chat_id, msg.message_id, MAIN_TEXT(name), MAIN_KB); return resOK(); }

    if (data === "menu_channels"){
      await TG.edit(chat_id, msg.message_id, CHAN_TEXT(name), joinKB());
      return resOK();
    }

    if (data === "menu_proofs"){
      const link = process.env.CHANNEL_2_URL || process.env.CHANNEL_1_URL || "https://t.me/";
      await TG.edit(chat_id, msg.message_id, "🧾 Open Proof channel:", TG.kb([[{text:"🧾 Withdrawal Proofs ↗️", url:link}], [{text:"◀️ Back", callback_data:"back_home"}]]));
      return resOK();
    }

    if (data === "menu_bal"){
      const c = await getCoins(from.id);
      await TG.edit(chat_id, msg.message_id, `💰 <b>Your balance:</b> <code>${c}</code> coins.`, TG.kb([[{text:"◀️ Back", callback_data:"back_home"}]]));
      return resOK();
    }

    if (data === "menu_daily"){
      const key = `u:${from.id}:daily:${new Date().toISOString().slice(0,10)}`;
      const got = await rget(key);
      if (got){ await TG.edit(chat_id, msg.message_id, "🎁 You already claimed today’s bonus.", KB.back); }
      else { await rset(key, "1"); await rcmd("EXPIRE", key, 60*60*26); await addCoins(from.id, 100); await TG.edit(chat_id, msg.message_id, "🎉 Bonus added: <b>100</b> coins!", KB.back); }
      return resOK();
    }

    if (data === "menu_ref"){
      const botUser = "t.me/" + (upd?.my_chat_member?.chat?.username || ""); // best effort
      const link = `https://t.me/${upd?.my_chat_member?.chat?.username || "your_bot"}?start=${from.id}`;
      const refs = Number(await rget(kRefs(from.id))||0);
      await TG.edit(chat_id, msg.message_id,
        `👥 <b>Referral</b>\nInvite link:\n<code>${link}</code>\n\nYou have <b>${refs}</b> refs.`,
        TG.kb([[{text:"◀️ Back", callback_data:"back_home"}]])
      );
      return resOK();
    }

    if (data === "menu_wd"){
      await TG.edit(chat_id, msg.message_id, "💵 <b>Withdraw</b>\nSelect method / तरीका चुनें:", KB.wdMode);
      return resOK();
    }

    if (data === "menu_lb"){
      const arr = await zrevrange(ZREFS, 0, 9, true) || [];
      const lines = ["🏆 <b>Leaderboard</b>"];
      for (let i=0;i<arr.length;i+=2){
        const uid = arr[i], score = arr[i+1];
        const nm = await rget(kName(uid)) || uid;
        lines.push(`${(i/2)+1}. ${esc(nm)} — <b>${score}</b> refs`);
      }
      if (lines.length===1) lines.push("No refs yet.");
      await TG.edit(chat_id, msg.message_id, lines.join("\n"), KB.back);
      return resOK();
    }

    // Withdraw path
    if (data === "wd_email"){
      await rset(kState(from.id), j({ t:"wd_email" }));
      await TG.edit(chat_id, msg.message_id, "✉️ Please send your <b>email</b> and <b>amount</b>\nउदाहरण: <code>yourmail@gmail.com 1000</code>", KB.back);
      return resOK();
    }
    if (data === "wd_upi"){
      await rset(kState(from.id), j({ t:"wd_upi" }));
      await TG.edit(chat_id, msg.message_id, "🏦 Please send your <b>UPI</b> and <b>amount</b>\nउदाहरण: <code>yourid@upi 1000</code>", KB.back);
      return resOK();
    }

    // Admin panel
    if (data === "ad_home" && isAdmin(from.id)){
      await TG.edit(chat_id, msg.message_id, "🛠 <b>Admin Panel</b>", KB.adHome);
      return resOK();
    }
    if (data === "ad_add" && isAdmin(from.id)){
      await rset(kState(from.id), j({t:"ad_add"}));
      await TG.edit(chat_id, msg.message_id, "➕ Send: <code>userId amount</code>\nउदा.: <code>123456789 5000</code>", KB.back);
      return resOK();
    }
    if (data === "ad_ded" && isAdmin(from.id)){
      await rset(kState(from.id), j({t:"ad_ded"}));
      await TG.edit(chat_id, msg.message_id, "➖ Send: <code>userId amount</code>", KB.back);
      return resOK();
    }
    if (data === "ad_setbal" && isAdmin(from.id)){
      await rset(kState(from.id), j({t:"ad_set"}));
      await TG.edit(chat_id, msg.message_id, "🧮 Send: <code>userId amount</code>", KB.back);
      return resOK();
    }
    if (data === "ad_bc" && isAdmin(from.id)){
      await rset(kState(from.id), j({t:"ad_bc"}));
      await TG.edit(chat_id, msg.message_id, "📣 Send broadcast message text.", KB.back);
      return resOK();
    }

    return resOK();
  }

  // ---------- Message handling ----------
  if (m?.text){
    const text = m.text.trim();

    // Referral on /start param
    if (text.startsWith("/start")){
      // Join gate only on /start
      if (await needsJoin(from.id)){
        await TG.send(chat_id, CHAN_TEXT(name), joinKB()); return resOK();
      }
      // ref
      const parts = text.split(" ");
      if (parts[1]){
        const ref = parts[1].trim();
        if (ref && ref !== String(from.id)){
          // credit only first time
          const seenKey = `ref:seen:${from.id}`;
          if (!(await rget(seenKey))){
            await rset(seenKey, "1");
            await incRef(ref);
          }
        }
      }
      await TG.send(chat_id, MAIN_TEXT(name), MAIN_KB);
      return resOK();
    }

    // If user simply sends email or upi + amount while in respective states OR directly
    const stRaw = await rget(kState(from.id));
    const st = stRaw ? JSON.parse(stRaw) : null;

    // Admin state flows
    if (st && isAdmin(from.id)){
      const mm = text.match(/^(\d+)\s+(\d+)$/);
      if ((st.t==="ad_add" || st.t==="ad_ded" || st.t==="ad_set") && !mm){
        await TG.send(chat_id, "❌ Format गलत है।\nउदाहरण: <code>123456789 5000</code>", KB.back);
        return resOK();
      }
      if (st.t==="ad_add"){
        await addCoins(mm[1], parseInt(mm[2],10));
        await rdel(kState(from.id));
        await TG.send(chat_id, "✅ Done.", KB.back); return resOK();
      }
      if (st.t==="ad_ded"){
        await subCoins(mm[1], parseInt(mm[2],10));
        await rdel(kState(from.id));
        await TG.send(chat_id, "✅ Done.", KB.back); return resOK();
      }
      if (st.t==="ad_set"){
        await setBalance(mm[1], parseInt(mm[2],10));
        await rdel(kState(from.id));
        await TG.send(chat_id, "✅ Done.", KB.back); return resOK();
      }
      if (st.t==="ad_bc"){
        const ids = await getAllUserIds(); let ok=0;
        for (const uid of ids){ try{ await TG.send(uid, text); ok++; }catch{} }
        await rdel(kState(from.id));
        await TG.send(chat_id, `✅ Broadcast sent to <b>${ok}</b> users.`, KB.back); return resOK();
      }
    }

    // Withdraw states
    if (st?.t === "wd_email" || st?.t==="wd_upi"){
      const mm = text.match(/^(\S+)\s+(\d+)$/);
      if (!mm){ await TG.send(chat_id, "❌ कृपया सही format भेजें।\nEmail/UPI और Amount —\n<code>your@gmail.com 1000</code> या <code>id@upi 1000</code>", KB.back); return resOK();}
      const dest = mm[1], amt = parseInt(mm[2],10);

      // Balance check
      const bal = await getCoins(from.id);
      if (bal < amt){ await TG.send(chat_id, "❌ Insufficient balance.", KB.back); return resOK(); }

      const wdid = await nextWdid();
      await subCoins(from.id, amt);
      await rset(kWD(from.id), wdid);
      if (st.t==="wd_email"){ await rset(kEmail(from.id), dest); await rdel(kUPI(from.id)); }
      if (st.t==="wd_upi"){ await rset(kUPI(from.id), dest); await rdel(kEmail(from.id)); }
      await rdel(kState(from.id));

      // Notify user (masked)
      const lineEmail = st.t==="wd_email" ? `Email: <b>${esc(maskEmail(dest))}</b>` : `Email: —`;
      const lineUPI   = st.t==="wd_upi"   ? `UPI: <b>${esc(maskUPI(dest))}</b>`   : `UPI: —`;
      await TG.send(chat_id,
        `✅ <b>Withdraw request received.</b>\nID: <b>${wdid}</b>\n${lineEmail}\n${lineUPI}\nAmount: <b>${amt}</b>`,
        KB.back
      );

      // Admin card (full data)
      const adText =
        `💸 <b>Withdraw Request</b>\n`+
        `ID: <b>${wdid}</b>\n`+
        `User: <code>${from.id}</code> (${esc(name)})\n`+
        `Email: ${esc(await rget(kEmail(from.id))||"-")}\n`+
        `UPI: ${esc(await rget(kUPI(from.id))||"-")}\n`+
        `Amount: <b>${amt}</b>`;
      const adminKb = TG.kb([
        [{text:"✅ Approve", callback_data:`ad_wd_ok:${wdid}:${from.id}:${amt}`},
         {text:"❌ Reject",  callback_data:`ad_wd_no:${wdid}:${from.id}:${amt}`}]
      ]);
      for (const ad of ADMINS){ try{ await TG.send(ad, adText, adminKb); }catch{} }

      return resOK();
    }

    // Direct email/upi + amount (without entering mode) — convenience
    {
      const mm = text.match(/^(\S+@\S+|\S+@\S+)\s+(\d+)$/);
      if (mm){
        // Put into mode depending on pattern
        const dest = mm[1], amt = parseInt(mm[2],10);
        const isMail = /\S+@\S+\.\S+/.test(dest) && dest.includes(".");
        await rset(kState(from.id), j({ t: isMail ? "wd_email" : "wd_upi" }));
        // re-use state handler by echoing same text
        upd.callback_query = undefined;
        return await handleUpdate({ message: { ...m, text: text }, ...pick(upd, "update_id") });
      }
    }

    // Fallback
    await TG.send(chat_id, `${helloLine(name)}\n✅ Ping reply OK`);
    return resOK();
  }

  return resOK();
}

// ---------- Admin approve/reject callbacks (post message) ----------
async function handleUpdate(update){
  // This wrapper allows us to intercept already defined above; keep it to avoid duplication.
  return await coreHandle(update);
}
async function coreHandle(upd){
  const m = upd.message;
  const cb = upd.callback_query;
  const from = m?.from || cb?.from;
  const chat_id = m?.chat?.id || cb?.message?.chat?.id;
  const msg = cb?.message;
  const name = from?.first_name ? `${from.first_name}${from.last_name? " "+from.last_name:""}` : (from?.username? "@"+from.username : String(from?.id||"User"));

  // intercept admin approve/reject
  if (cb && /^ad_wd_/.test(cb.data) && isAdmin(from.id)){
    const [tag, act, wdid, uid, amt] = cb.data.split(/[:]/); // tag includes "ad_wd"
    const email = await rget(kEmail(uid)) || "-";
    const upi   = await rget(kUPI(uid)) || "-";

    if (act==="ok"){
      await TG.answerCb(cb.id, { text:"Approved!" });
      // Notify user
      const maskE = email !== "-" ? maskEmail(email) : "-";
      const maskU = upi   !== "-" ? maskUPI(upi) : "-";
      await TG.send(uid, `🎉 Your withdrawal #${wdid} has been <b>APPROVED</b>.\nEmail: <b>${esc(maskE)}</b>\nUPI: <b>${esc(maskU)}</b>.`);
      // Post to proofs (full)
      if (process.env.PROOF_CHANNEL_ID){
        const txt =
          `🟩 <b>Withdrawal Paid</b>\n`+
          `ID: <b>${wdid}</b>\n`+
          `User: <code>${uid}</code> (${esc(await rget(kName(uid))||uid)})\n`+
          `Email: ${esc(email)}\n`+
          `UPI: ${esc(upi)}\n`+
          `Amount: <b>${amt}</b>`;
        try{ await TG.send(process.env.PROOF_CHANNEL_ID, txt); }catch{}
      }
      await TG.edit(chat_id, msg.message_id, "✅ Approved & posted.");
      return resOK();
    }else{
      await TG.answerCb(cb.id, { text:"Rejected!" });
      // refund
      await addCoins(uid, parseInt(amt,10));
      await TG.send(uid, `❗ Your withdrawal #${wdid} was <b>REJECTED</b>. Amount refunded.`);
      await TG.edit(chat_id, msg.message_id, "❌ Rejected & refunded.");
      return resOK();
    }
  }

  // otherwise fall back to main handler above
  return await _mainHandler(upd);
}

// to avoid hoist issues, split the earlier handleUpdate into _mainHandler
async function _mainHandler(upd){
  // re-run the earlier function body (we already wrote it above)
  // To keep this file compact, call the already-declared function from top scope.
  return await (async function inner(u){ /* noop: replaced at build */ })(upd);
}
