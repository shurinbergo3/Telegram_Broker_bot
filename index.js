require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const Groq = require('groq-sdk');
const { HttpsProxyAgent } = require('https-proxy-agent');
const express = require('express');
const db = require('./db');

const { TELEGRAM_BOT_TOKEN, GROQ_API_KEY, TELEGRAM_GROUP_ID, ADMIN_ID, AI_MODEL, WEBHOOK_SECRET, PORT, HTTPS_PROXY } = process.env;

if (!TELEGRAM_BOT_TOKEN || !GROQ_API_KEY || !TELEGRAM_GROUP_ID || !ADMIN_ID) {
  console.error('Missing required env vars: TELEGRAM_BOT_TOKEN, GROQ_API_KEY, TELEGRAM_GROUP_ID, ADMIN_ID');
  process.exit(1);
}

const telegrafOptions = {};
if (HTTPS_PROXY) {
  telegrafOptions.telegram = { agent: new HttpsProxyAgent(HTTPS_PROXY) };
  console.log(`[PROXY] Telegraf using proxy: ${HTTPS_PROXY}`);
}
const bot = new Telegraf(TELEGRAM_BOT_TOKEN, telegrafOptions);
const groqOptions = { apiKey: GROQ_API_KEY };
if (HTTPS_PROXY) {
  groqOptions.httpAgent = new HttpsProxyAgent(HTTPS_PROXY);
  console.log(`[PROXY] Groq using proxy: ${HTTPS_PROXY}`);
}
const groq = new Groq(groqOptions);

const TARGET_GROUP_ID = String(TELEGRAM_GROUP_ID);
const ADMIN_USER_ID = String(ADMIN_ID);

// In-memory state
const awaitingPromptInput = new Set();
const awaitingNewAdmin = new Set();

// --- In-memory log buffer (last 100 entries) ---
const LOG_BUFFER_MAX = 100;
const logBuffer = [];

function addLog(entry) {
  logBuffer.push({ ts: new Date(), ...entry });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

function getLogsLastHour() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return logBuffer.filter((e) => e.ts.getTime() >= cutoff);
}

function formatLogs(entries) {
  if (!entries.length) return 'Нет событий за последний час.';
  return entries
    .map((e) => {
      const time = e.ts.toTimeString().slice(0, 8);
      const icon = e.type === 'error' ? '❌' : e.type === 'no_buyers' ? '🎯' : '✅';
      return `${icon} ${time} | ${e.inn || '?'} | ${e.company || '—'}\n   ${e.summary}`;
    })
    .join('\n\n');
}

// --- Helpers ---

function getTodayDate() {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function buildSystemPrompt() {
  const template = db.getPromptTemplate();
  return template.replace('{{now}}', getTodayDate()).replace('{{TODAY}}', getTodayDate());
}

async function analyzeWithGemini(text) {
  const completion = await groq.chat.completions.create({
    model: AI_MODEL || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: text },
    ],
  });
  return completion.choices[0].message.content;
}

function isAdmin(ctx) {
  const id = String(ctx.from?.id);
  if (id === ADMIN_USER_ID) return true;
  return db.getAdmins().some((a) => a.id === id);
}

function isSuperAdmin(ctx) {
  return String(ctx.from?.id) === ADMIN_USER_ID;
}

function adminMenu(ctx) {
  const buttons = [
    [Markup.button.callback('📊 Статистика', 'admin_stats')],
    [Markup.button.callback('👥 Список пользователей', 'admin_users')],
    [Markup.button.callback('📋 Логи (последний час)', 'admin_logs')],
    [Markup.button.callback('📝 Редактировать промпт', 'admin_edit_prompt')],
  ];
  if (isSuperAdmin(ctx)) {
    buttons.push([Markup.button.callback('👮 Управление админами', 'admin_manage_admins')]);
  }
  return Markup.inlineKeyboard(buttons);
}

function buildAdminsText() {
  const extra = db.getAdmins();
  const lines = [`👑 Суперадмин: ID ${ADMIN_USER_ID}`];
  if (extra.length) {
    lines.push('');
    extra.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.username ? `@${a.username}` : `ID ${a.id}`}`);
    });
  }
  lines.push('');
  lines.push(extra.length ? 'Нажми ❌ чтобы удалить или ➕ чтобы добавить.' : 'Нажми ➕ чтобы добавить.');
  return `👮 Управление админами\n\n${lines.join('\n')}`;
}

function adminsMenu() {
  const admins = db.getAdmins();
  const rows = admins.map((a) => {
    const label = a.username ? `@${a.username}` : `ID ${a.id}`;
    return [Markup.button.callback(`❌ ${label}`, `admin_remove_${a.id}`)];
  });
  rows.push([Markup.button.callback('➕ Добавить админа', 'admin_add_admin')]);
  rows.push([Markup.button.callback('« Назад', 'admin_back')]);
  return Markup.inlineKeyboard(rows);
}

function formatUsersList(users) {
  if (!users.length) return 'Пользователей пока нет.';
  return users
    .map((u, i) => {
      const name = u.username ? `@${u.username}` : `ID ${u.id}`;
      return `${i + 1}. ${name} (с ${u.firstSeen.slice(0, 10)})`;
    })
    .join('\n');
}

// --- Admin command ---

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Панель администратора доступна только в личных сообщениях с ботом.');
    return;
  }
  await ctx.reply('Панель администратора:', adminMenu(ctx));
});

// --- Admin callbacks ---

bot.action('admin_stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const { usersCount, analysesCount } = db.getStats();
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📊 Статистика\n\nПользователей: ${usersCount}\nАнализов выполнено: ${analysesCount}`,
    adminMenu(ctx)
  );
});

bot.action('admin_users', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const { users } = db.getStats();
  await ctx.answerCbQuery();
  const list = formatUsersList(users);
  const text = `👥 Пользователи (${users.length}):\n\n${list}`;
  if (text.length <= 4096) {
    await ctx.editMessageText(text, adminMenu(ctx));
  } else {
    await ctx.editMessageText('👥 Список слишком длинный, отправляю отдельно.', adminMenu(ctx));
    await ctx.reply(list);
  }
});

bot.action('admin_edit_prompt', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const current = db.getPromptTemplate();
  awaitingPromptInput.add(String(ctx.from.id));
  const buf = Buffer.from(current, 'utf8');
  await ctx.replyWithDocument({ source: buf, filename: 'prompt.txt' }, {
    caption: '📝 Текущий промпт (полный). Скачай, отредактируй и отправь обратно .txt файлом.\n\nДля отмены напиши /cancel.',
  });
});

bot.action('admin_logs', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const entries = getLogsLastHour();
  const text = `📋 Логи за последний час (${entries.length} событий):\n\n${formatLogs(entries)}`;
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  await ctx.editMessageText(chunks[0], adminMenu(ctx));
  for (let i = 1; i < chunks.length; i++) await ctx.reply(chunks[i]);
});

bot.action('admin_manage_admins', async (ctx) => {
  if (!isSuperAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText(buildAdminsText(), adminsMenu());
});

bot.action('admin_add_admin', async (ctx) => {
  if (!isSuperAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  awaitingNewAdmin.add(ADMIN_USER_ID);
  await ctx.reply('Отправь Telegram ID нового админа (только цифры).\n\nДля отмены напиши /cancel.');
});

bot.action('admin_back', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText('Панель администратора:', adminMenu(ctx));
});

// Dynamic callback: admin_remove_<userId>
bot.action(/^admin_remove_(.+)$/, async (ctx) => {
  if (!isSuperAdmin(ctx)) return ctx.answerCbQuery();
  const targetId = ctx.match[1];
  db.removeAdmin(targetId);
  await ctx.answerCbQuery('Админ удален.');
  await ctx.editMessageText(buildAdminsText(), adminsMenu());
});

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat?.type !== 'private') return;
  const uid = String(ctx.from.id);
  if (awaitingPromptInput.has(uid) || awaitingNewAdmin.has(uid)) {
    awaitingPromptInput.delete(uid);
    awaitingNewAdmin.delete(uid);
    await ctx.reply('Отменено.');
  }
});

// --- Shared group analysis logic ---

const APPLICATION_PATTERN = /ИНН\s*\d{10,12}/i;
const INN_EXTRACT = /ИНН\s*(\d{10,12})/i;
const COMPANY_EXTRACT = /^([А-ЯЁа-яёA-Za-z0-9«»"'\-\s]{1,40})/;

async function analyzeGroupMessage(ctx, msg) {
  const chatId = String(msg.chat?.id ?? ctx.chat?.id);
  console.log(`[MSG] chatId=${chatId} target=${TARGET_GROUP_ID} match=${chatId === TARGET_GROUP_ID} from=${msg.from?.username || msg.from?.id} isBot=${msg.from?.is_bot}`);
  if (chatId !== TARGET_GROUP_ID) return;

  const text = msg.text || msg.caption;
  console.log(`[MSG] hasText=${!!text} len=${text?.length || 0} preview=${(text || '').slice(0, 60)}`);
  if (!text || text.startsWith('/')) return;

  const hasInn = APPLICATION_PATTERN.test(text);
  console.log(`[MSG] hasINN=${hasInn}`);
  if (!hasInn) return;

  if (!msg.from?.is_bot) {
    db.upsertUser(String(msg.from?.id), msg.from?.username);
  }

  const inn = (INN_EXTRACT.exec(text) || [])[1] || null;
  const company = (COMPANY_EXTRACT.exec(text.trim()) || [])[1]?.trim() || null;

  // Status "Ядро" — skip AI, reply immediately
  if (/Статус\s*:?\s*ядро/i.test(text)) {
    const label = company && inn ? `${company}, ${inn}` : inn || company || '?';
    const reply = `🎯 Для [${label}] Покупателей не найдено. Рекомендую отправить в рекламу.`;
    addLog({ type: 'no_buyers', inn, company, summary: 'Статус: Ядро — без анализа' });
    await ctx.reply(reply, { reply_to_message_id: msg.message_id });
    return;
  }

  try {
    console.log(`[AI] Calling Gemini for INN=${inn}...`);
    const reply = await analyzeWithGemini(text);
    console.log(`[AI] Gemini OK, reply len=${reply.length}, preview=${reply.slice(0, 80)}`);
    db.incrementAnalyses();

    const noBuyers = /покупател\w*\s+не\s+найден|не\s+найден\w*\s+покупател/i.test(reply);
    const firstLine = reply.split('\n').find((l) => l.trim()) || reply.slice(0, 80);

    addLog({
      type: noBuyers ? 'no_buyers' : 'found',
      inn,
      company,
      summary: firstLine.slice(0, 100),
    });

    console.log(`[REPLY] Sending reply to msg ${msg.message_id}...`);
    await ctx.reply(reply, { reply_to_message_id: msg.message_id });
    console.log(`[REPLY] Sent OK`);
  } catch (err) {
    console.error(`[ERROR] ${err.name}: ${err.message}`);
    console.error(err.stack);
    addLog({ type: 'error', inn, company, summary: err.message.slice(0, 100) });
  }
}

// --- Utility commands (must be before bot.on('text') to not be intercepted) ---

bot.command('myid', (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}\nТвой ID: ${ctx.from.id}`));

// --- Document handler: accept .txt file as new prompt ---

bot.on('document', async (ctx) => {
  if (ctx.chat?.type !== 'private') return;
  const userId = String(ctx.from?.id);
  if (!isAdmin(ctx) || !awaitingPromptInput.has(userId)) return;

  const doc = ctx.message.document;
  console.log(`[PROMPT_UPLOAD] user=${userId} file=${doc.file_name} size=${doc.file_size} mime=${doc.mime_type}`);

  if (!doc.mime_type?.includes('text') && !doc.file_name?.endsWith('.txt')) {
    await ctx.reply('Нужен .txt файл. Попробуй ещё раз или /cancel.');
    return;
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    console.log(`[PROMPT_UPLOAD] downloading ${fileLink.href}`);
    const res = await fetch(fileLink.href);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const newPrompt = await res.text();
    if (!newPrompt || newPrompt.trim().length === 0) {
      await ctx.reply('❌ Файл пустой. Попробуй ещё раз или /cancel.');
      return;
    }
    db.savePromptTemplate(newPrompt);
    awaitingPromptInput.delete(userId);
    console.log(`[PROMPT_UPLOAD] saved ${newPrompt.length} chars`);
    await ctx.reply(`✅ Промпт обновлен (${newPrompt.length} символов).`);
  } catch (err) {
    console.error(`[PROMPT_UPLOAD] error: ${err.name}: ${err.message}`);
    console.error(err.stack);
    await ctx.reply(`❌ Не удалось загрузить промпт: ${err.message}\n\nПопробуй ещё раз или /cancel.`);
  }
});

// --- Main text handler (regular group messages, including from bots) ---

bot.on('text', async (ctx) => {
  console.log(`[HANDLER:text] chat=${ctx.chat?.id} type=${ctx.chat?.type} from=${ctx.from?.username || ctx.from?.id}`);
  const userId = String(ctx.from?.id);
  const text = ctx.message.text;

  if (!text) return;

  const isPrivate = ctx.chat?.type === 'private';

  // Admin flows only apply in private chat with the bot
  if (isPrivate && isAdmin(ctx) && awaitingPromptInput.has(userId)) {
    if (text.startsWith('/')) return;
    await ctx.reply('Пожалуйста, отправь промпт как .txt файл, а не текстом. Или /cancel для отмены.');
    return;
  }

  if (isPrivate && isSuperAdmin(ctx) && awaitingNewAdmin.has(userId)) {
    if (text.startsWith('/')) return;
    awaitingNewAdmin.delete(userId);
    const newId = text.trim();
    if (!/^\d+$/.test(newId)) {
      await ctx.reply('Некорректный ID. Должны быть только цифры. Попробуй снова через /admin.');
      return;
    }
    db.addAdmin(newId, null);
    await ctx.reply(`Админ ${newId} добавлен.`);
    return;
  }

  await analyzeGroupMessage(ctx, ctx.message);
});

// Photo messages — read caption as text, ignore the image
bot.on('photo', async (ctx) => {
  console.log(`[HANDLER:photo] chat=${ctx.chat?.id} type=${ctx.chat?.type} from=${ctx.from?.username || ctx.from?.id} caption=${!!ctx.message?.caption}`);
  const userId = String(ctx.from?.id);
  const isPrivate = ctx.chat?.type === 'private';
  if (isPrivate && (awaitingPromptInput.has(userId) || awaitingNewAdmin.has(userId))) return;
  await analyzeGroupMessage(ctx, ctx.message);
});

// Channel posts (when the group is linked to a Telegram channel)
bot.on('channel_post', async (ctx) => {
  console.log(`[HANDLER:channel_post] chat=${ctx.channelPost?.chat?.id} hasText=${!!ctx.channelPost?.text} hasCaption=${!!ctx.channelPost?.caption}`);
  await analyzeGroupMessage(ctx, ctx.channelPost);
});

// --- Global error handler (prevents crashes on unhandled middleware errors) ---

bot.catch((err, ctx) => {
  console.error(`Error for update ${ctx?.update?.update_id}:`, err.message);
});

// --- Incoming webhook from external bot ---

async function handleIncomingWebhook(text, messageId) {
  const hasInn = APPLICATION_PATTERN.test(text);
  console.log(`[WEBHOOK] messageId=${messageId} hasINN=${hasInn} preview=${text.slice(0, 60)}`);
  if (!hasInn) return;

  const inn = (INN_EXTRACT.exec(text) || [])[1] || null;
  const company = (COMPANY_EXTRACT.exec(text.trim()) || [])[1]?.trim() || null;

  if (/Статус\s*:?\s*ядро/i.test(text)) {
    const label = company && inn ? `${company}, ${inn}` : inn || company || '?';
    const reply = `🎯 Для [${label}] Покупателей не найдено. Рекомендую отправить в рекламу.`;
    addLog({ type: 'no_buyers', inn, company, summary: 'Статус: Ядро — без анализа' });
    await bot.telegram.sendMessage(TARGET_GROUP_ID, reply, { reply_to_message_id: messageId });
    return;
  }

  try {
    console.log(`[WEBHOOK/AI] Calling Gemini for INN=${inn}...`);
    const reply = await analyzeWithGemini(text);
    console.log(`[WEBHOOK/AI] Gemini OK, len=${reply.length}`);
    db.incrementAnalyses();

    const noBuyers = /покупател\w*\s+не\s+найден|не\s+найден\w*\s+покупател/i.test(reply);
    const firstLine = reply.split('\n').find((l) => l.trim()) || reply.slice(0, 80);
    addLog({ type: noBuyers ? 'no_buyers' : 'found', inn, company, summary: firstLine.slice(0, 100) });

    await bot.telegram.sendMessage(TARGET_GROUP_ID, reply, { reply_to_message_id: messageId });
    console.log(`[WEBHOOK/REPLY] Sent OK`);
  } catch (err) {
    console.error(`[WEBHOOK/ERROR] ${err.name}: ${err.message}`);
    addLog({ type: 'error', inn, company, summary: err.message.slice(0, 100) });
  }
}

function startHttpServer() {
  const app = express();
  app.use(express.json());

  app.post('/incoming', async (req, res) => {
    const secret = req.headers['x-secret'];
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
      console.warn('[WEBHOOK] Unauthorized request');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { text, messageId } = req.body;
    if (!text || !messageId) {
      return res.status(400).json({ error: 'text and messageId are required' });
    }

    res.json({ ok: true });
    handleIncomingWebhook(String(text), Number(messageId)).catch(console.error);
  });

  const port = Number(PORT) || 3001;
  app.listen(port, () => console.log(`[HTTP] Webhook server listening on port ${port}`));
}

// --- Launch ---

async function startBot(retries = 10, delay = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      await bot.launch({ allowedUpdates: ['message', 'channel_post', 'callback_query'] });
      console.log(`Bot started (attempt ${i}). Group: ${TARGET_GROUP_ID} | Admin: ${ADMIN_USER_ID}`);
      return;
    } catch (err) {
      console.error(`Attempt ${i}/${retries} failed: ${err.message}`);
      if (i < retries) {
        const wait = delay * i;
        console.log(`Waiting ${wait / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  console.error('All retry attempts exhausted. Exiting.');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack}` : String(reason);
  console.error(`[CRASH] Unhandled rejection: ${msg}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[CRASH] Uncaught exception: ${err.name}: ${err.message}\n${err.stack}`);
});

startBot().catch((err) => console.error(`[CRASH] startBot threw: ${err.message}`));
try {
  startHttpServer();
} catch (err) {
  console.error(`[CRASH] startHttpServer threw: ${err.message}`);
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
