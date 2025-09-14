
import fs from 'fs';
import cron from 'node-cron';
import { ingestOnce } from './aggregator.js';
import { evaluatePending } from './evaluator.js';
import { getAllUserIds } from './db.js';
import { materializeForUser } from './posts.js';
import { enrichWithLLM } from './llm_enricher.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'scheduler' });

export function setupScheduler(bot) {
  const tz = process.env.TZ || 'Europe/Moscow';
  cron.schedule('*/15 * * * *', async () => {
    log.info('sched.cycle.start', {});
    try {
      const agg = await ingestOnce();
      const upd = await evaluatePending(800);
      const llm = await enrichWithLLM(Number(process.env.LLM_BATCH_LIMIT||150));
      log.info('sched.cycle.done', { feedsOk: agg.feedsOk, feeds: agg.feeds, parsed: agg.itemsSeen, inserted: agg.inserted, llm });
    } catch (e) {
      log.error('sched.cycle.error', { err: e?.message });
    }
  }, { timezone: tz });

  const hour = Number(process.env.PUSH_HOUR || 9);
  const minute = Number(process.env.PUSH_MINUTE || 30);
  cron.schedule(`${minute} ${hour} * * *`, async () => {
    log.info('sched.daily.start', { hour, minute });
    try {
      const uids = await getAllUserIds();
      for (const uid of uids) {
        const { audioPath } = await materializeForUser(uid, Number(process.env.FEED_LIMIT||8));
        if (audioPath && fs.existsSync(audioPath)) {
          try {
            await bot.telegram.sendAudio(uid, { source: fs.createReadStream(audioPath) }, { title: 'Аудио-дайджест', performer: 'NewsLens' });
          } catch (e) {
            log.warn('sched.daily.audio_send_fail', { uid, err: e?.message });
          }
        }
      }
      log.info('sched.daily.done', { users: uids.length });
    } catch (e) {
      log.error('sched.daily.error', { err: e?.message });
    }
  }, { timezone: tz });
}
