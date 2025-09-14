
import { getUnscoredArticleIds, getArticlesByIds, updateArticleScores } from './db.js';
import { scoreArticle } from './scoring.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'evaluator' });

export async function evaluatePending(limit=200) {
  const ids = await getUnscoredArticleIds(limit);
  log.info('eval.pending', { count: ids.length });
  if (!ids.length) return 0;
  const rows = await getArticlesByIds(ids);
  const nowTs = Math.floor(Date.now()/1000);
  let ok = 0;
  for (const a of rows) {
    try {
      const scores = scoreArticle({
        title: a.title,
        summary: a.summary,
        sourceWeight: Number(a.source_weight ?? 0.8),
        publishedTs: a.published_ts,
        nowTs
      });
      await updateArticleScores(a.id, scores);
      ok++;
    } catch (e) {
      log.warn('eval.error', { id: a.id, err: e?.message });
    }
  }
  log.info('eval.done', { updated: ok });
  return ok;
}
