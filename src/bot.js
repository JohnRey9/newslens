
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { db, migrate } from './db.js';
import { setupHandlers } from './handlers.js';
import { setupScheduler } from './scheduler.js';
import { ingestOnce } from './aggregator.js';
import { evaluatePending } from './evaluator.js';
import { enrichWithLLM } from './llm_enricher.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'bot' });

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { log.error('bot.error.no_token', {}); process.exit(1); }
  await db();
  await migrate();
  log.info('bot.init', { tz: process.env.TZ, logLevel: process.env.LOG_LEVEL||'info', format: process.env.LOG_FORMAT||'json' });
  // try { const agg = await ingestOnce(); log.info('bot.ingest.ready', agg); } catch (e) { log.warn('bot.ingest.fail', { err: e?.message }); }
  // try { const n = await evaluatePending(800); log.info('bot.eval.ready', { updated: n }); } catch (e) { log.warn('bot.eval.fail', { err: e?.message }); }
  // try { const k = await enrichWithLLM(Number(process.env.LLM_BATCH_LIMIT||150)); log.info('bot.llm.ready', { enriched: k }); } catch (e) { log.warn('bot.llm.fail', { err: e?.message }); }

  // Без handlerTimeout:0 — /refresh уже фоновый, поэтому таймаут Telegraf нас не ограничивает
  const bot = new Telegraf(token);
  setupHandlers(bot);
  setupScheduler(bot);
  await bot.launch();
  log.info('bot.started', {});
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
main().catch(err => { log.error('bot.fatal', { err: err?.message }); process.exit(1); });
