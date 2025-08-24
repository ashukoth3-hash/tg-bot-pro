import { Telegraf, Markup } from 'telegraf';
import { Redis } from '@upstash/redis';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN missing');

const bot = new Telegraf(token, { handlerTimeout: 9000 });

/** ===== ENV ===== */
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const FORCE_JOIN_CHANNELS = (process.env.FORCE_JOIN_CHANNELS || '')
  .split(/[,\s]+/).filter(Boolean).map(s => s.replace(/^https?:\/\/t\.me\//, '@'));
const PROOF_LINKS = (process.env.PROOF_LINKS || '').split(/[,\s]+/).filter(Boolean);

const JOIN_BONUS = Number(process.env.JOIN_BONUS ?? 0);
const REF_BONUS_REF = Number(process.env.REFERRAL_BONUS_REFERRER ?? 50);
const REF_BONUS_NEW = Number(process.env.REFERRAL_BONUS_NEW ?? 25);
const DAILY_BONUS = Number(process.env.DAILY_BONUS ?? 10);
const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW ?? 500);

/** ===== DB (Upstash Redis REST) ===== */
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const kUser = id => `u:${id}`;         // {coins, joinedAt, refBy, lastDaily, firstStartDone}
const kRef  = id => `ref:${id}`;       // set of referred
const kTask = id => `task:${id}`;      // set of completed tasks
const kWQ   = ()  => `withdraw:q`;     // list queue

async function ensureUser(id){ if(!(await redis.exists(kUser(id)))) await redis.hset(kUser(id), { coins: 0, joinedAt: Date.now() }); }
async function getUser(id){ const d = await redis.hgetall(kUser(id)); if(!d) return null; const n = {...d}; for(const f of ['coins','joinedAt','lastDaily']) if(n[f]!=null) n[f]=Number(n[f]); return n; }
async function addCoins(id, amt){ return redis.hincrby(kUser(id), 'coins', amt); }

/** ===== force-join ===== */
async function forceJoinCheck(ctx){
  if(!FORCE_JOIN_CHANNELS.length) return true;
  const handles = FORCE_JOIN_CHANNELS.map(c=>c.replace(/^@/,''));
  try{
    for(const h of handles){
      const m = await ctx.telegram.getChatMember(`@${h}`, ctx.from.id);
      const st = m?.status;
      if(!st || st==='left' || st==='kicked'){
        const text = '👋 पहले इन channels को join करो:\n' + handles.map(x=>`• https://t.me/${x}`).join('\n') + '\n\nJoin के बाद /start दुबारा भेजो.';
        const btns = handles.map(x=>[Markup.button.url(`Join ${x}`, `https://t.me/${x}`)]);
        await ctx.reply(text, { disable_web_page_preview: true, ...Markup.inlineKeyboard(btns) });
        return false;
      }
    }
  }catch(_e){
    const btns = handles.map(x=>[Markup.button.url(`Join ${x}`, `https://t.me/${x}`)]);
    await ctx.reply('ℹ️ Join check नहीं हो पाया. ऊपर दिये links से join करो और /start फिर से भेजो.', { disable_web_page_preview: true, ...Markup.inlineKeyboard(btns) });
    return false;
  }
  return true;
}

/** ===== UI menu ===== */
function menu(){
  const rows = [
    [Markup.button.callback('📢 Channels', 'channels'), Markup.button.callback('📑 Proofs', 'proofs')],
    [Markup.button.callback('💰 Balance', 'bal'), Markup.button.callback('🎁 Daily Bonus', 'daily')],
    [Markup.button.callback('👥 Referral', 'refer'), Markup.button.callback('💸 Withdraw', 'wd')],
  ];
  if(FORCE_JOIN_CHANNELS.length){
    for(const c of FORCE_JOIN_CHANNELS){
      const h = c.replace(/^@/,'');
      rows.push([Markup.button.url(`✅ Join ${h}`, `https://t.me/${h}`)]);
    }
  }
  return Markup.inlineKeyboard(rows);
}

/** ===== Start + Referral ===== */
bot.start(async (ctx)=>{
  if(!(await forceJoinCheck(ctx))) return;
  await ensureUser(ctx.from.id);

  const payload = ctx.startPayload;
  const refId = payload && /^\d+$/.test(payload) ? Number(payload) : null;

  const u = await getUser(ctx.from.id);
  if(!u?.firstStartDone){
    const updates = { firstStartDone: '1' };
    if(refId && refId !== ctx.from.id){
      updates.refBy = String(refId);
      await addCoins(ctx.from.id, REF_BONUS_NEW);
      await addCoins(refId, REF_BONUS_REF);
      await redis.sadd(kRef(refId), String(ctx.from.id));
    }
    if(JOIN_BONUS>0) await addCoins(ctx.from.id, JOIN_BONUS);
    await redis.hset(kUser(ctx.from.id), updates);
  }

  await ctx.reply(`Welcome ${ctx.from.first_name || 'buddy'} 👋\nEarn via referrals & daily bonus; redeem by withdraw.`, menu());
});

/** ===== Channels / Proofs ===== */
bot.action('channels', async (ctx)=>{ await ctx.answerCbQuery();
  const txt = FORCE_JOIN_CHANNELS.length ? ('Required:\n' + FORCE_JOIN_CHANNELS.map(c=>`• ${c}`).join('\n')) : 'No channels configured.';
  const btns = FORCE_JOIN_CHANNELS.map(c=>[Markup.button.url(`Open ${c.replace(/^@/,'')}`, `https://t.me/${c.replace(/^@/,'')}`)]);
  return ctx.reply(txt, { disable_web_page_preview: true, ...Markup.inlineKeyboard(btns) });
});
bot.action('proofs', async (ctx)=>{ await ctx.answerCbQuery();
  if(!PROOF_LINKS.length) return ctx.reply('No proofs yet.');
  const txt = 'Proof links:\n' + PROOF_LINKS.map(u=>`• ${u}`).join('\n');
  const btns = PROOF_LINKS.map(u=>[Markup.button.url('Open', u)]);
  return ctx.reply(txt, { disable_web_page_preview: true, ...Markup.inlineKeyboard(btns) });
});

/** ===== Balance / Daily ===== */
bot.action('bal', async (ctx)=>{ await ctx.answerCbQuery(); await ensureUser(ctx.from.id); const u=await getUser(ctx.from.id);
  return ctx.reply(`💰 Balance: *${u?.coins ?? 0}* coins`, { parse_mode:'Markdown' });
});
bot.action('daily', async (ctx)=>{ await ctx.answerCbQuery(); await ensureUser(ctx.from.id); const u=await getUser(ctx.from.id);
  const now = Date.now(), next = (u?.lastDaily ?? 0) + 24*60*60*1000;
  if(now<next){ const left=Math.ceil((next-now)/3600000); return ctx.reply(`⏳ Already claimed. Try after ~${left}h.`); }
  const bal = await addCoins(ctx.from.id, DAILY_BONUS); await redis.hset(kUser(ctx.from.id), { lastDaily: now });
  return ctx.reply(`🎁 Daily +${DAILY_BONUS}. New balance: ${bal}`);
});

/** ===== Referral ===== */
let CACHED_BOT_USERNAME = process.env.BOT_USERNAME || null;
async function botUsername(ctx){ if(CACHED_BOT_USERNAME) return CACHED_BOT_USERNAME; try{ const me=await ctx.telegram.getMe(); CACHED_BOT_USERNAME=me?.username||null; }catch{} return CACHED_BOT_USERNAME; }
bot.action('refer', async (ctx)=>{ await ctx.answerCbQuery(); const me=ctx.from.id; const u=(await botUsername(ctx))||process.env.BOT_USERNAME||'your_bot';
  const link = `https://t.me/${u}?start=${me}`; const cnt = await redis.scard(kRef(me));
  const text = `👥 *Referral* \n• Your link: ${link}\n• You: +${REF_BONUS_REF} / friend\n• New user: +${REF_BONUS_NEW}\n• Joined by you: ${cnt}`;
  return ctx.reply(text, { parse_mode:'Markdown', disable_web_page_preview:true });
});

/** ===== Withdraw ===== */
bot.action('wd', async (ctx)=>{ await ctx.answerCbQuery(); await ensureUser(ctx.from.id); const u=await getUser(ctx.from.id);
  if((u?.coins ?? 0) < MIN_WITHDRAW) return ctx.reply(`❗ Minimum ${MIN_WITHDRAW}. Your balance: ${u?.coins ?? 0}`);
  return ctx.reply('💸 Format:\n`/withdraw upi amount`\nExample: `/withdraw gpay@okicici 500`', { parse_mode:'Markdown' });
});
bot.hears(/^\/withdraw\s+(\S+)\s+(\d+)/i, async (ctx)=>{ const upi=ctx.match[1]; const amt=Number(ctx.match[2]); const u=await getUser(ctx.from.id);
  if(!u || (u.coins ?? 0) < amt) return ctx.reply('❌ Not enough balance.');
  await redis.lpush(kWQ(), JSON.stringify({ uid: ctx.from.id, name: ctx.from.first_name, upi, amt, ts: Date.now() }));
  if(ADMIN_ID){ await ctx.telegram.sendMessage(ADMIN_ID, `💸 Withdraw\nUser: ${ctx.from.id} (${ctx.from.first_name})\nUPI: ${upi}\nAmount: ${amt}\nCoins: ${u?.coins ?? 0}`); }
  return ctx.reply('✅ Withdraw request received. Admin will review.');
});

/** ===== Basics ===== */
bot.command('ping', (ctx)=>ctx.reply('🏓 pong'));

/** ===== Webhook (Vercel) ===== */
export default async function handler(req, res){
  if(process.env.WEBHOOK_SECRET){
    const q = req.query?.secret;
    if(q !== process.env.WEBHOOK_SECRET){ res.status(403).json({ ok:false, error:'bad secret' }); return; }
  }
  if(req.method === 'POST'){
    try{ await bot.handleUpdate(req.body); res.status(200).json({ ok:true }); }
    catch(e){ console.error('handleUpdate error', e); res.status(200).json({ ok:true }); }
  } else { res.status(200).json({ ok:true, hello:'telegram' }); }
}
