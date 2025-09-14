
import { getArticlesMissingLLM, upsertLLMFeatures } from './db.js';
import { extractLLMFeatures } from './llm_features.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'llm_enricher' });

export async function enrichWithLLM(limitOverride=null) {
  if (!process.env.OPENAI_API_KEY) { log.info('llm.skip.no_key', {}); return 0; }
  const limit = Number(limitOverride ?? process.env.LLM_BATCH_LIMIT ?? 150);
  const conc = Math.max(1, Number(process.env.LLM_CONCURRENCY ?? 12));
  const windowHours = Number(process.env.LLM_WINDOW_HOURS ?? 48);

  const rows = await getArticlesMissingLLM(limit, windowHours);
  log.info('llm.missing', { count: rows.length, conc, windowHours });
  if (!rows.length) return 0;

  let ok = 0, fail = 0, idx = 0;
  async function worker(workerId) {
    while (true) {
      const i = idx++; if (i >= rows.length) break;
      const a = rows[i];
      try {
        const f = await extractLLMFeatures({ title: a.title, summary: a.summary, articleId: a.id });
        await upsertLLMFeatures(a.id, f, 2);
        log.debug('llm.enrich.ok', { articleId: a.id, workerId });
        ok++;
      } catch (e) {
        fail++; log.warn('llm.enrich.fail', { articleId: a.id, workerId, err: e?.message });
      }
    }
  }
  const workers = Array.from({length: conc}, (_,k)=>worker(k+1));
  await Promise.all(workers);
  log.info('llm.enrich.done', { ok, fail, total: rows.length });
  return ok;
}
