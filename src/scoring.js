
import { clamp01, to100, tokenize } from './utils.js';

export function scoreArticle({ title, summary, sourceWeight=0.8, publishedTs, nowTs }) {
  const hours = Math.max(0, (nowTs - publishedTs)/3600);
  const recency = Math.exp(-hours/12);

  const uniqTerms = new Set([...tokenize(title), ...tokenize(summary)]).size;
  const novelty = Math.min(1, 0.02 * uniqTerms);

  const importance = Math.min(1, 0.6*sourceWeight + 0.3*Math.min(1, title.length/120) + 0.1*recency);
  const hype = recency;
  const caps = (title.match(/\b[A-ZА-Я][A-Za-zА-Яа-я0-9-]+\b/g) || []).length;
  const prominence = Math.min(1, 0.7*sourceWeight + 0.3*Math.min(1, caps/6));
  const quality = clamp01(sourceWeight);

  return {
    importance: to100(importance),
    hype: to100(hype),
    prominence: to100(prominence),
    novelty: to100(novelty),
    quality: to100(quality),
  };
}
