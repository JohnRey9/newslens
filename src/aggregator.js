
import Parser from 'rss-parser';
import { loadSources } from './config.js';
import { upsertArticle, upsertCluster, getRecentTitles } from './db.js';
import { jaccardShingles, ruCharShare } from './utils.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'aggregator' });

const parser = new Parser({
  requestOptions: {
    headers: { 'User-Agent': 'NewsLens/1.0', 'Accept-Language': 'ru' },
    timeout: 15000
  }
});
function norm(s='') { return (s || '').replace(/\s+/g, ' ').trim(); }

function clusterIdFor(title, existingTitles) {
  const titleN = norm(title).toLowerCase();
  let bestSim = 0;
  let bestTitle = '';
  for (const et of existingTitles) {
    const sim = jaccardShingles(titleN, (et||'').toLowerCase(), 3);
    if (sim > bestSim) { bestSim = sim; bestTitle = et; }
  }
  const base = (bestSim >= 0.8 ? bestTitle : titleN);
  const cid = Buffer.from(base).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0,16);
  return { clusterId: cid, storyTitle: bestTitle || title };
}

export async function ingestOnce() {
  const t = log.time('ingest.cycle');
  const feeds = loadSources();
  const existingTitles = await getRecentTitles(72);
  const nowTs = Math.floor(Date.now()/1000);
  let totalSeen = 0, totalInserted = 0, totalSkippedRU = 0, feedsOk = 0, feedsFail = 0;

  for (const feed of feeds) {
    const weight = Number(feed.weight ?? 0.8);
    const ft = log.time('feed.fetch', { name: feed.name, url: feed.url, weight });
    let inserted = 0, skippedRU = 0, seen = 0;
    try {
      const parsed = await parser.parseURL(feed.url);
      const entries = parsed.items?.slice(0, 50) || [];
      seen = entries.length;
      log.info('feed.parse', { name: feed.name, entries: seen });
      for (const e of entries) {
        const url = e.link;
        const title = e.title;
        const summary = e.contentSnippet || e.content || e.summary || '';
        if (!url || !title) { log.debug('feed.item.skip.missing', { name: feed.name }); continue; }
        if (ruCharShare(title + ' ' + summary) < 0.2) { skippedRU++; continue; }
        let publishedTs = nowTs;
        const cand = e.isoDate || e.pubDate || e.lastBuildDate || null;
        if (cand) { const t = new Date(cand).getTime(); if (!Number.isNaN(t)) publishedTs = Math.floor(t/1000); }
        const { clusterId, storyTitle } = clusterIdFor(title, existingTitles);
        const article = { url, source: feed.name, source_weight: weight, title, summary,
                          published_ts: publishedTs, cluster_id: clusterId,
                          importance: null, hype: null, prominence: null, novelty: null, quality: null };
        const res = await upsertArticle(article);
        if (res.inserted) inserted++;
        await upsertCluster(clusterId, storyTitle, publishedTs, 1);
        existingTitles.push(title);
      }
      ft.end({ name: feed.name, entries: seen, inserted, skippedRU });
      feedsOk++;
    } catch (e) {
      feedsFail++;
      ft.end({ name: feed.name, error: e?.message || String(e) });
      log.warn('feed.error', { name: feed.name, url: feed.url, err: e?.message });
    }
    totalSeen += seen; totalInserted += inserted; totalSkippedRU += skippedRU;
  }
  t.end({ feeds: feeds.length, feedsOk, feedsFail, totalSeen, totalInserted, totalSkippedRU });
  return { feeds: feeds.length, feedsOk, feedsFail, itemsSeen: totalSeen, inserted: totalInserted, skippedNonRU: totalSkippedRU };
}
