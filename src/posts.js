
import { insertPost } from './db.js';
import { rankForUser } from './recommender.js';
import { buildAudioNewsForItems } from './audio_news.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'posts' });

export async function materializeForUser(userId, limit=8) {
  const items = await rankForUser(userId, { limit, windowHours: 48, requireLLM: true });
  const compact = items.map(it => ({
    article_id: it.id, title: it.title, url: it.url, source: it.source,
    score: Math.round(it.score*100)/100
  }));

  let audioPath = null;
  try {
    const { audioPath: p } = await buildAudioNewsForItems(userId, compact);
    audioPath = p || null;
  } catch (e) {
    log.warn('audio.build.fail', { userId, err: e?.message });
  }

  const postId = await insertPost(userId, compact, { audio: audioPath || null });
  log.info('posts.materialized', { userId, limit, count: compact.length, postId, requireLLM: true, audio: !!audioPath });
  return { postId, audioPath };
}
