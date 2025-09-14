
import { ingestOnce } from './aggregator.js';
import { evaluatePending } from './evaluator.js';
import { materializeForUser } from './posts.js';
import { ensureUser } from './db.js';
import { enrichWithLLM } from './llm_enricher.js';

export async function runIngestOnce() { return ingestOnce(); }
export async function runEvaluateOnce() { return evaluatePending(800); }
export async function runMaterializeOnce(userId=null) {
  if (userId) {
    await ensureUser(userId);
    return materializeForUser(userId, Number(process.env.FEED_LIMIT||8));
  }
}
export async function runLLMOnce(limit=150) { return enrichWithLLM(limit); }
