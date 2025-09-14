
import fs from 'fs';
import { Markup } from 'telegraf';
import {
  ensureUser, setUserPause, setUserPrompt, setUserWeights,
  getTodayPost, upsertFeedback, getFeedbackVote,
  setUserInterestProfile, getUserInterestProfile, clearUserInterestProfile, getUserProfile
} from './db.js';
import { rankForUser } from './recommender.js';
import { ingestOnce } from './aggregator.js';
import { evaluatePending } from './evaluator.js';
import { materializeForUser } from './posts.js';
import { enrichWithLLM } from './llm_enricher.js';
import { extractInterestProfile } from './profile_llm.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'handlers' });

function fbKeyboard(userId, articleId, vote) {
  const like = vote === 1 ? '👍✅' : '👍';
  const dislike = vote === -1 ? '👎✅' : '👎';
  return Markup.inlineKeyboard([
    [Markup.button.callback(like, `fb:like:${articleId}`),
     Markup.button.callback(dislike, `fb:dislike:${articleId}`),
     Markup.button.callback('↩︎ Отмена', `fb:undo:${articleId}`)]
  ]);
}
function escapeHtml(s='') { return s.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }

function deriveTopicsForDisplay(profileObj) {
  try {
    let p = profileObj;
    if (!p) return [];
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* noop */ } }
    // возможные пути
    let arr = Array.isArray(p.topics) ? p.topics
            : Array.isArray(p?.profile?.topics) ? p.profile.topics
            : Array.isArray(p?.data?.topics) ? p.data.topics
            : Array.isArray(p.tags) ? p.tags
            : Array.isArray(p.interests) ? p.interests
            : [];
    const out = [];
    for (const t of arr) {
      if (!t) continue;
      if (typeof t === 'string') {
        const tag = t.trim();
        if (tag) out.push({ tag, weight: 0.6 });
      } else {
        const tag = String(t.tag || t.name || t.term || t.keyword || t.family || '').trim();
        if (!tag) continue;
        const wRaw = (t.weight ?? t.score ?? 0.6);
        const w = Math.max(0, Math.min(1, Number(wRaw) || 0.6));
        out.push({ tag, weight: w });
      }
    }
    // dedup
    const seen = new Set();
    return out.filter(it => {
      const k = it.tag.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  } catch {
    return [];
  }
}

// Background refresh lock
const refreshing = new Set();

async function runRefreshPipeline(tg, chatId) {
  try {
    await tg.sendMessage(chatId, '🔄 Запускаю обновление и материализацию…');
    const agg = await ingestOnce();
    await tg.sendMessage(chatId, `✅ Источники: ${agg.feedsOk}/${agg.feeds}, новых: ${agg.inserted}`);

    const n = await evaluatePending(800);
    await tg.sendMessage(chatId, `📊 Оценено статей: ~${n}`);

    const k = await enrichWithLLM(Number(process.env.LLM_BATCH_LIMIT||150));
    await tg.sendMessage(chatId, `🧠 LLM‑обогащено: ~${k}`);

    const { postId, audioPath } = await materializeForUser(chatId, Number(process.env.FEED_LIMIT||8));
    await tg.sendMessage(chatId, `📦 Пост #${postId} готов. Жми /today`);
    if (audioPath && fs.existsSync(audioPath)) {
      await tg.sendAudio(chatId, { source: fs.createReadStream(audioPath) }, { title: 'Аудио-дайджест', performer: 'NewsLens' });
    } else {
      await tg.sendMessage(chatId, '🔈 Аудио-дайджест пока не доступен.');
    }
  } catch (e) {
    log.error('cmd.refresh.error', { userId: chatId, err: e?.message });
    try { await tg.sendMessage(chatId, '❌ Ошибка обновления: ' + (e?.message || 'неизвестно')); } catch {}
  } finally {
    refreshing.delete(chatId);
  }
}

export function setupHandlers(bot) {
  bot.start(async (ctx) => {
    await ensureUser(ctx.from.id);
    log.info('cmd.start', { userId: ctx.from.id });
    await ctx.reply('Привет! Команды:\n' +
      '/feed — свежая подборка\n' +
      '/today — последняя материализованная (только с LLM)\n' +
      '/today_audio — аудио-дайджест за сегодня\n' +
      '/prefs — выбрать пресет весов\n' +
      '/prompt <текст> — построить профиль интересов (теги/веса)\n' +
      '/profile — показать профиль; /profile_json — показать JSON; /profile_clear — очистить\n' +
      '/pause /resume — пауза/возобновить\n' +
      '/refresh — обновление в фоне + озвучка');
  });

  bot.command('feed', async (ctx) => {
    log.info('cmd.feed', { userId: ctx.from.id });
    const items = await rankForUser(ctx.from.id, { windowHours: 48, limit: Number(process.env.FEED_LIMIT||8) });
    if (!items.length) return ctx.reply('Пока нет свежих материалов.');
    for (const art of items) {
      const vote = await getFeedbackVote(ctx.from.id, art.id);
      const score = `score ${Math.round(art.score*100)/100} | LLM ${Math.round(art.llm*100)/100} | Prof ${Math.round(art.profRel*100)}%`;
      await ctx.replyWithHTML(`✨ <b>${escapeHtml(art.title)}</b>\n<i>${escapeHtml(art.source)}</i> | ${score}\n${art.url}`,
        { disable_web_page_preview: false, reply_markup: fbKeyboard(ctx.from.id, art.id, vote).reply_markup });
    }
  });

  bot.command('today', async (ctx) => {
    log.info('cmd.today', { userId: ctx.from.id });
    const post = await getTodayPost(ctx.from.id);
    if (!post) return ctx.reply('На сегодня ещё нет материализованной подборки. Жми /refresh или /feed.');
    const items = JSON.parse(post.items_json || '[]');
    if (!items.length) return ctx.reply('Подборка пуста.');
    for (const it of items) {
      const vote = await getFeedbackVote(ctx.from.id, it.article_id);
      await ctx.replyWithHTML(`📰 <b>${escapeHtml(it.title)}</b>\n<i>${escapeHtml(it.source)}</i> | score ${it.score}\n${it.url}`,
        { disable_web_page_preview: false, reply_markup: fbKeyboard(ctx.from.id, it.article_id, vote).reply_markup });
    }
  });

  bot.command('today_audio', async (ctx) => {
    log.info('cmd.today_audio', { userId: ctx.from.id });
    const post = await getTodayPost(ctx.from.id);
    if (!post || !post.audio_asset) return ctx.reply('Аудио-дайджеста за сегодня пока нет. Жми /refresh.');
    try {
      await ctx.replyWithAudio({ source: fs.createReadStream(post.audio_asset) }, { title: 'Аудио-дайджест', performer: 'NewsLens' });
    } catch (e) {
      await ctx.reply('Не удалось отправить аудио.');
    }
  });

  bot.command('prefs', async (ctx) => {
    log.info('cmd.prefs', { userId: ctx.from.id });
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('AI/Product', 'preset:ai')],
      [Markup.button.callback('Глобальные события', 'preset:global')],
      [Markup.button.callback('Тех и бизнес', 'preset:biz')],
    ]);
    await ctx.reply('Выбери пресет весов:', kb);
  });

  bot.action(/preset:.+/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    log.info('cmd.preset', { userId: ctx.from.id, choice: data });
    const presets = {
      'preset:ai': { I:0.20, H:0.20, P:0.25, N:0.15, Q:0.20 },
      'preset:global': { I:0.30, H:0.20, P:0.25, N:0.10, Q:0.15 },
      'preset:biz': { I:0.25, H:0.20, P:0.35, N:0.10, Q:0.10 },
    };
    const weights = presets[data] || { I:0.35, H:0.2, P:0.2, N:0.15, Q:0.1 };
    await setUserWeights(ctx.from.id, weights);
    await ctx.editMessageText('Ок! Применил пресет. Воспользуйся /feed чтобы проверить.');
  });

  bot.command('prompt', async (ctx) => {
    const text = (ctx.message.text || '');
    const txt = text.replace(/^\/prompt\s*/i, '').trim();
    log.info('cmd.prompt', { userId: ctx.from.id, len: txt.length });
    if (!txt) return ctx.reply('Пришли команду в формате: /prompt текст интересов (на русском)');
    await setUserPrompt(ctx.from.id, txt);
    if (process.env.OPENAI_API_KEY) {
      try {
        const profile = await extractInterestProfile(txt);
        await setUserInterestProfile(ctx.from.id, profile);
        const disp = deriveTopicsForDisplay(profile);
        const preview = disp.slice(0,8).map(t => `${t.tag} (${Math.round((t.weight||0.6)*100)}%)`).join(', ');
        await ctx.reply(`Ок! Сформировал профиль интересов.\nТеги: ${preview || '—'}`);
      } catch (e) {
        log.warn('cmd.prompt.profile_fail', { err: e?.message });
        await ctx.reply('Сохранил текст промпта. Профиль интересов не удалось сформировать автоматически.');
      }
    } else {
      await ctx.reply('Сохранил «цифровой промпт». (Нет OPENAI_API_KEY — профиль интересов не построен)');
    }
  });

  bot.command('profile', async (ctx) => {
    const p = await getUserInterestProfile(ctx.from.id);
    const u = await getUserProfile(ctx.from.id);
    const disp = deriveTopicsForDisplay(p);
    if (disp.length === 0) {
      const fallback = (u?.prompt_text || '').trim();
      if (fallback) return ctx.reply(`Теги профиля: —\n(Пока не удалось сформировать теги из промпта. Текущий промпт: “${fallback}”. Попробуй еще раз: /prompt <текст>)`);
      return ctx.reply('Теги профиля: —');
    }
    const tags = disp.slice(0,12).map(t => `${t.tag} (${Math.round((t.weight||0.6)*100)}%)`).join(', ');
    await ctx.reply(`Теги профиля: ${tags || '—'}`);
  });

  bot.command('profile_json', async (ctx) => {
    const p = await getUserInterestProfile(ctx.from.id);
    if (!p) return ctx.reply('Пусто.');
    const s = JSON.stringify(p);
    await ctx.reply('JSON профиля (сокр.):\n' + (s.length>1500 ? s.slice(0,1500)+'…' : s));
  });

  bot.command('profile_clear', async (ctx) => {
    await clearUserInterestProfile(ctx.from.id);
    await ctx.reply('Профиль очищен. Укажи интересы заново через /prompt.');
  });

  bot.command('pause', async (ctx) => { log.info('cmd.pause', { userId: ctx.from.id }); await setUserPause(ctx.from.id, true); await ctx.reply('Пауза включена.'); });
  bot.command('resume', async (ctx) => { log.info('cmd.resume', { userId: ctx.from.id }); await setUserPause(ctx.from.id, false); await ctx.reply('Готов присылать снова.'); });

  bot.command('refresh', async (ctx) => {
    const chatId = ctx.chat.id;
    if (refreshing.has(chatId)) return ctx.reply('⏳ Обновление уже идёт, подожди завершения.');
    refreshing.add(chatId);
    log.info('cmd.refresh', { userId: chatId });
    try { await ctx.reply('🚀 Запустил обновление. Пришлю результат сообщениями.'); } catch {}
    setTimeout(() => { runRefreshPipeline(ctx.telegram, chatId); }, 0);
  });

  bot.action(/fb:(like|dislike|undo):([0-9]+)/, async (ctx) => {
    const [, kind, idStr] = ctx.callbackQuery.data.match(/fb:(like|dislike|undo):([0-9]+)/);
    const articleId = Number(idStr);
    let vote = 0; if (kind === 'like') vote = 1; else if (kind === 'dislike') vote = -1;
    log.info('cmd.feedback', { userId: ctx.from.id, articleId, vote });
    await upsertFeedback(ctx.from.id, articleId, vote);
    const current = await getFeedbackVote(ctx.from.id, articleId);
    try { await ctx.editMessageReplyMarkup(fbKeyboard(ctx.from.id, articleId, current).reply_markup); } catch {}
    await ctx.answerCbQuery(vote===1?'Лайк учтён': vote===-1?'Дизлайк учтён':'Отменено', { show_alert: false });
  });
}
