import express from 'express';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';

const app = express();
app.use(express.json({ limit: '256kb' }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex');
const PORT = Number(process.env.PORT || 10000);

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const sessions = new Map();

const CHALLENGES = [
  {
    title: 'светофор',
    // Public Wikimedia Commons image. The expected cells are maintained per source image.
    image: 'https://commons.wikimedia.org/wiki/Special:FilePath/Traffic_lights.jpg?width=480',
    // This image is intentionally used as a first MVP fixture. Replace with reviewed fixtures as the catalog grows.
    expected: [4],
  },
  {
    title: 'объект в центре',
    image: 'https://picsum.photos/seed/htmlbubbles-verification/480/480',
    expected: [4],
  },
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function telegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.description || 'Telegram API error'}`);
  return result.result;
}

async function fetchImageData(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const image = await sharp(bytes).rotate().resize(96, 96, { fit: 'cover' }).jpeg({ quality: 20, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${image.toString('base64')}`;
}

function widgetHtml({ title, imageData }) {
  const tileMarkup = Array.from({ length: 9 }, (_, index) => `<button class="tile p${index}" data-i="${index}" aria-label="Квадратик ${index + 1}"></button>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:12px;font:15px system-ui,sans-serif;color:var(--tg-theme-text-color,#222);background:var(--tg-theme-bg-color,#fff)}.head{font-weight:700;margin-bottom:8px}.hint{font-size:13px;opacity:.72;margin-bottom:10px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-width:330px}.tile{padding:0;border:2px solid transparent;border-radius:7px;overflow:hidden;background-color:#ddd;background-image:url('${imageData}');background-size:300% 300%;background-repeat:no-repeat;aspect-ratio:1;cursor:pointer}.p0{background-position:0 0}.p1{background-position:50% 0}.p2{background-position:100% 0}.p3{background-position:0 50%}.p4{background-position:50% 50%}.p5{background-position:100% 50%}.p6{background-position:0 100%}.p7{background-position:50% 100%}.p8{background-position:100% 100%}.tile.selected{border-color:#2481cc;box-shadow:0 0 0 2px #2481cc55}.submit{margin-top:10px;border:0;border-radius:8px;padding:9px 14px;background:#2481cc;color:#fff;font-weight:700}.result{margin-top:8px;font-weight:600}
</style></head><body><div class="head">Проверка: отметьте клетки с объектом «${escapeHtml(title)}»</div><div class="hint">Выберите один или несколько квадратиков и нажмите «Проверить».</div><div class="grid">${tileMarkup}</div><button class="submit" id="submit">Проверить</button><div class="result" id="result"></div><script>
const selected=new Set();document.querySelectorAll('.tile').forEach((el)=>el.addEventListener('click',()=>{const i=Number(el.dataset.i);if(selected.has(i)){selected.delete(i);el.classList.remove('selected')}else{selected.add(i);el.classList.add('selected')}}));document.getElementById('submit').addEventListener('click',()=>{const result=document.getElementById('result');if(!window.TelegramWidget){result.textContent='Откройте этот виджет внутри Telegram.';return}if(!selected.size){result.textContent='Выберите хотя бы одну клетку.';return}TelegramWidget.request(JSON.stringify({selected:[...selected].sort((a,b)=>a-b)})).then((answer)=>{try{const data=JSON.parse(answer.result||'{}');result.textContent=data.ok?'Проверка пройдена.':'Есть ошибка. Попробуйте ещё раз.';if(data.ok)document.getElementById('submit').disabled=true}catch{result.textContent='Ответ получен.'}}).catch((error)=>{result.textContent='Не удалось отправить ответ: '+error.code})});if(window.TelegramWidget)TelegramWidget.ready();
</script></body></html>`;
}

async function sendChallenge(chatId) {
  const challenge = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
  const imageData = await fetchImageData(challenge.image);
  const html = widgetHtml({ title: challenge.title, imageData });
  const compressedBytes = deflateSync(Buffer.from(html), { level: 9 }).length;
  console.log(`Widget payload: ${Buffer.byteLength(html)} bytes HTML, ${compressedBytes} bytes zlib`);
  if (compressedBytes > 4096) throw new Error(`Widget payload is ${compressedBytes} compressed bytes; Telegram limit is 4096`);
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { chatId, expected: challenge.expected, createdAt: Date.now() });
  // State is carried in chat_data; the widget itself remains fixed and offline.
  await telegram('sendWidget', {
    chat_id: chatId,
    html,
    width: 360,
    height: 470,
    chat_data: JSON.stringify({ sessionId, status: 'pending' }),
    allow_queries: true,
    caption: 'HTMLBubbles CAPTCHA MVP',
  });
}

async function handleMessage(message) {
  if (!message?.chat?.id) return;
  const text = message.text || '';
  if (text.startsWith('/start') || text.startsWith('/verify')) {
    await telegram('sendMessage', { chat_id: message.chat.id, text: 'Нажмите на кнопку ниже, чтобы начать проверку.' });
    await sendChallenge(message.chat.id);
  } else if (text === '/help') {
    await telegram('sendMessage', { chat_id: message.chat.id, text: 'Команды: /start или /verify — начать проверку.' });
  }
}

async function handleWidgetQuery(query) {
  let payload;
  try { payload = JSON.parse(query.data); } catch { payload = {}; }
  const selected = Array.isArray(payload.selected) ? payload.selected.map(Number).filter(Number.isInteger).sort((a,b)=>a-b) : [];
  // In a production implementation, resolve session state from durable storage keyed by message_id.
  // This MVP uses the latest session for the private chat and is intentionally easy to replace with Postgres/Redis.
  const session = [...sessions.values()].reverse().find((item) => item.chatId === query.from?.id);
  const expected = session?.expected || [4];
  const ok = selected.length === expected.length && selected.every((value, index) => value === expected[index]);
  await telegram('answerWidgetQuery', { widget_query_id: query.id, data: JSON.stringify({ ok, selected, expectedCount: expected.length }) });
  if (ok && query.chat?.id) {
    await telegram('sendMessage', { chat_id: query.chat.id, text: '✅ Проверка пройдена. Вы подтвердили, что вы не робот.' });
    if (query.message_id) await telegram('editMessageWidgetData', { chat_id: query.chat.id, message_id: query.message_id, chat_data: JSON.stringify({ status: 'verified' }) });
  }
}

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'telegram-htmlbubbles-bot' }));
app.post('/telegram/webhook', async (req, res) => {
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    if (req.body.message) await handleMessage(req.body.message);
    if (req.body.widget_query) await handleWidgetQuery(req.body.widget_query);
  } catch (error) {
    console.error(error);
  }
});

app.listen(PORT, async () => {
  console.log(`HTMLBubbles bot listening on ${PORT}`);
  if (BOT_TOKEN && PUBLIC_URL) {
    try {
      await telegram('setWebhook', { url: `${PUBLIC_URL}/telegram/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'widget_query'], drop_pending_updates: false });
      console.log(`Webhook configured: ${PUBLIC_URL}/telegram/webhook`);
    } catch (error) { console.error('Webhook setup failed:', error.message); }
  } else {
    console.log('BOT_TOKEN/PUBLIC_URL not configured yet; webhook setup skipped.');
  }
});
