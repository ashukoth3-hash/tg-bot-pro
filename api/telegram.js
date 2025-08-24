// api/telegram.js
export const config = { runtime: 'edge' };

const BOT_TOKEN = process.env.BOT_TOKEN;
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

function api(method, data) {
  return fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json());
}

const CHANNELS = (process.env.FORCE_JOIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => s.replace(/^@/, '')); // normalize

const OK_STATUSES = new Set(['member', 'administrator', 'creator']);

async function userJoinedAll(userId) {
  if (!CHANNELS.length) return true;
  for (const ch of CHANNELS) {
    const res = await api('getChatMember', { chat_id: `@${ch}`, user_id: userId });
    if (!res.ok || !OK_STATUSES.has(res.result?.status)) return false;
  }
  return true;
}

function mainMenuKb() {
  return {
    inline_keyboard: [
      [{ text: '📣 Channels', callback_data: 'channels' }, { text: '🧾 Proofs', callback_data: 'proofs' }],
      [{ text: '💰 Balance', callback_data: 'balance' }, { text: '🎁 Daily Bonus', callback_data: 'daily' }],
      [{ text: '👥 Referral', callback_data: 'ref' }, { text: '💸 Withdraw', callback_data: 'wd' }],
    ]
  };
}

function joinGateKb() {
  const rows = [];
  // First row: Follow now (optional – first channel)
  if (CHANNELS[0]) rows.push([{ text: 'Follow Now ➜', url: `https://t.me/${CHANNELS[0]}` }]);

  // Grid of Join buttons (generic names)
  for (let i = 0; i < CHANNELS.length; i += 2) {
    rows.push([
      { text: 'Join ➜', url: `https://t.me/${CHANNELS[i]}` },
      CHANNELS[i + 1]
        ? { text: 'Join ➜', url: `https://t.me/${CHANNELS[i + 1]}` }
        : { text: '—', callback_data: 'noop' }
    ]);
  }

  rows.push([{ text: 'Claim 💸', callback_data: 'claim' }]);
  return { inline_keyboard: rows };
}

async function sendMainMenu(chat_id) {
  return api('sendMessage', {
    chat_id,
    text: 'Welcome Support 🇮🇳👋\nEarn via referrals & daily bonus; redeem by withdraw.',
    reply_markup: mainMenuKb()
  });
}

async function sendJoinGate(chat_id) {
  const lines = [
    '😍 Hey!! User Welcome To Bot',
    '🟢 Must Join All Channels To Use Bot',
    '▪️ After joining click Claim'
  ];
  return api('sendMessage', {
    chat_id,
    text: lines.join('\n'),
    reply_markup: joinGateKb()
  });
}

function backKb() {
  return { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'back_home' }]] };
}

async function handleBalance(chat_id, user_id) {
  // TODO: yahan apna actual balance storage logic lagao (Upstash/Redis)
  const coins = 0; // example
  return api('sendMessage', {
    chat_id,
    text: `Your balance: ${coins} coins`,
    reply_markup: backKb()
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('OK');

  const update = await req.json();

  const msg = update.message;
  const cb = update.callback_query;

  const chat_id = msg?.chat?.id ?? cb?.message?.chat?.id;
  const user_id = msg?.from?.id ?? cb?.from?.id;

  // /start
  if (msg?.text?.startsWith('/start')) {
    const ok = await userJoinedAll(user_id);
    if (!ok) await sendJoinGate(chat_id);
    else await sendMainMenu(chat_id);
    return new Response('OK');
  }

  // Callbacks
  if (cb) {
    const data = cb.data;

    if (data === 'claim') {
      const ok = await userJoinedAll(user_id);
      if (!ok) await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Please join all channels first.' });
      await sendMainMenu(chat_id);
      return new Response('OK');
    }

    if (data === 'back_home') {
      await sendMainMenu(chat_id);
      return new Response('OK');
    }

    if (data === 'balance') {
      await handleBalance(chat_id, user_id);
      return new Response('OK');
    }

    // Placeholders for other menus (copy this style & keep Back button)
    if (['daily', 'ref', 'wd', 'channels', 'proofs'].includes(data)) {
      await api('sendMessage', { chat_id, text: `Opened: ${data}`, reply_markup: backKb() });
      return new Response('OK');
    }

    // ignore no-op
    if (data === 'noop') return new Response('OK');
  }

  return new Response('OK');
}
