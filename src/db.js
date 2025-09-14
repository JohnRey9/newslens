
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { logger } from './logger.js';

let dbInstance = null;
export async function db() {
  if (dbInstance) return dbInstance;
  dbInstance = await open({ filename: 'news.db', driver: sqlite3.Database });
  await dbInstance.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      source TEXT,
      source_weight REAL DEFAULT 0.8,
      title TEXT,
      summary TEXT,
      published_ts INTEGER,
      cluster_id TEXT,
      importance REAL,
      hype REAL,
      prominence REAL,
      novelty REAL,
      quality REAL,
      created_ts INTEGER DEFAULT (strftime('%s','now')),
      updated_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_ts);

    CREATE TABLE IF NOT EXISTS clusters (
      cluster_id TEXT PRIMARY KEY,
      story_title TEXT,
      first_seen_ts INTEGER,
      last_seen_ts INTEGER,
      size INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      tz TEXT DEFAULT 'Europe/Moscow',
      schedule TEXT DEFAULT '09:30',
      weights_json TEXT DEFAULT '{"I":0.35,"H":0.2,"P":0.2,"N":0.15,"Q":0.1}',
      prompt_text TEXT DEFAULT '',
      interest_profile_json TEXT,
      relevance_weight REAL DEFAULT 0.15,
      paused INTEGER DEFAULT 0,
      created_ts INTEGER DEFAULT (strftime('%s','now')),
      updated_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      generated_ts INTEGER,
      items_json TEXT,
      audio_asset TEXT,
      video_asset TEXT,
      status TEXT DEFAULT 'ready',
      sent_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      user_id INTEGER,
      article_id INTEGER,
      sent_ts INTEGER,
      PRIMARY KEY(user_id, article_id)
    );

    CREATE TABLE IF NOT EXISTS llm_features (
      article_id INTEGER PRIMARY KEY,
      version INTEGER DEFAULT 1,
      evidence_strength REAL,
      uncertainty REAL,
      sensationalism REAL,
      actionability REAL,
      geo_scope_score REAL,
      harm_severity REAL,
      polarization_risk REAL,
      bias_risk REAL,
      fact_density REAL,
      time_criticality REAL,
      followup_potential REAL,
      genre TEXT,
      evidence_types TEXT,
      key_entities TEXT,
      geo_targets TEXT,
      topics_json TEXT,
      summary_2sents TEXT,
      raw_json TEXT,
      created_ts INTEGER DEFAULT (strftime('%s','now')),
      updated_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS feedback (
      user_id INTEGER,
      article_id INTEGER,
      vote INTEGER, -- 1 like, -1 dislike
      created_ts INTEGER DEFAULT (strftime('%s','now')),
      updated_ts INTEGER,
      PRIMARY KEY (user_id, article_id),
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_article ON feedback(article_id);

    -- Topic normalization self-learning vocabulary
    CREATE TABLE IF NOT EXISTS topic_vocab (
      canonical TEXT PRIMARY KEY,
      parent_canonical TEXT,
      lang TEXT DEFAULT 'ru',
      aliases_json TEXT,
      embedding_json TEXT,
      created_ts INTEGER DEFAULT (strftime('%s','now')),
      updated_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS topic_map (
      alias TEXT PRIMARY KEY,
      canonical TEXT,
      confidence REAL,
      created_ts INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_topic_map_canon ON topic_map(canonical);
  `);
  logger.info('db.ready', {});
  return dbInstance;
}

export async function migrate() {
  const d = await db();
  const colsU = await d.all(`PRAGMA table_info(users)`);
  if (!colsU.some(c => c.name === 'interest_profile_json')) {
    await d.exec(`ALTER TABLE users ADD COLUMN interest_profile_json TEXT;`);
    logger.info('db.migrate.add_column', { table: 'users', column: 'interest_profile_json' });
  }
  const colsL = await d.all(`PRAGMA table_info(llm_features)`);
  if (!colsL.some(c => c.name === 'topics_json')) {
    await d.exec(`ALTER TABLE llm_features ADD COLUMN topics_json TEXT;`);
    logger.info('db.migrate.add_column', { table: 'llm_features', column: 'topics_json' });
  }
  await d.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_article ON feedback(article_id);`);
  // ensure topic tables
  await d.exec(`
    CREATE TABLE IF NOT EXISTS topic_vocab (
      canonical TEXT PRIMARY KEY,
      parent_canonical TEXT,
      lang TEXT DEFAULT 'ru',
      aliases_json TEXT,
      embedding_json TEXT,
      created_ts INTEGER DEFAULT (strftime('%s','now')),
      updated_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS topic_map (
      alias TEXT PRIMARY KEY,
      canonical TEXT,
      confidence REAL,
      created_ts INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_topic_map_canon ON topic_map(canonical);
  `);
  logger.info('db.migrate.done', {});
}

export async function ensureUser(userId) {
  const d = await db();
  await d.run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, userId);
}

export async function setUserWeights(userId, weights) {
  const d = await db();
  await d.run(`UPDATE users SET weights_json=?, updated_ts=strftime('%s','now') WHERE user_id=?`,
    JSON.stringify(weights), userId);
}
export async function setUserPrompt(userId, prompt) {
  const d = await db();
  await d.run(`UPDATE users SET prompt_text=?, updated_ts=strftime('%s','now') WHERE user_id=?`,
    prompt, userId);
}
export async function setUserInterestProfile(userId, profile) {
  const d = await db();
  await d.run(`UPDATE users SET interest_profile_json=?, updated_ts=strftime('%s','now') WHERE user_id=?`,
    JSON.stringify(profile), userId);
}
export async function clearUserInterestProfile(userId) {
  const d = await db();
  await d.run(`UPDATE users SET interest_profile_json=NULL, updated_ts=strftime('%s','now') WHERE user_id=?`, userId);
}
export async function getUserInterestProfile(userId) {
  const d = await db();
  const row = await d.get(`SELECT interest_profile_json FROM users WHERE user_id=?`, userId);
  return row?.interest_profile_json ? JSON.parse(row.interest_profile_json) : null;
}
export async function setUserPause(userId, paused) {
  const d = await db();
  await d.run(`UPDATE users SET paused=?, updated_ts=strftime('%s','now') WHERE user_id=?`,
    paused ? 1 : 0, userId);
}
export async function isUserPaused(userId) {
  const d = await db();
  const row = await d.get(`SELECT paused FROM users WHERE user_id=?`, userId);
  return !!(row && row.paused);
}

export async function getAllUserIds() {
  const d = await db();
  const rows = await d.all(`SELECT user_id FROM users`);
  return rows.map(r => r.user_id);
}
export async function getUserProfile(userId) {
  const d = await db();
  const row = await d.get(`SELECT * FROM users WHERE user_id=?`, userId);
  return row;
}

export async function getRecentTitles(hours=72) {
  const d = await db();
  const since = Math.floor(Date.now()/1000) - hours*3600;
  const rows = await d.all(`SELECT title FROM articles WHERE published_ts >= ?`, since);
  return rows.map(r => r.title);
}

export async function upsertCluster(clusterId, storyTitle, ts, sizeDelta=1) {
  const d = await db();
  await d.run(`
    INSERT INTO clusters (cluster_id, story_title, first_seen_ts, last_seen_ts, size)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cluster_id) DO UPDATE SET
      last_seen_ts=excluded.last_seen_ts,
      size=clusters.size + ?
  `, clusterId, storyTitle, ts, ts, 1, sizeDelta);
}

export async function upsertArticle(article) {
  const d = await db();
  const res = await d.run(`
    INSERT OR IGNORE INTO articles
    (url, source, source_weight, title, summary, published_ts, cluster_id, importance, hype, prominence, novelty, quality)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, article.url, article.source, article.source_weight ?? 0.8, article.title, article.summary || '',
     article.published_ts, article.cluster_id, article.importance, article.hype,
     article.prominence, article.novelty, article.quality);
  const row = await d.get(`SELECT id FROM articles WHERE url=?`, article.url);
  return { id: row?.id, inserted: (res?.changes || 0) > 0 };
}

export async function getUnscoredArticleIds(limit=100) {
  const d = await db();
  const rows = await d.all(`
    SELECT id FROM articles WHERE importance IS NULL OR hype IS NULL OR prominence IS NULL OR novelty IS NULL OR quality IS NULL
    ORDER BY published_ts DESC LIMIT ?
  `, limit);
  return rows.map(r => r.id);
}
export async function getArticlesByIds(ids=[]) {
  if (!ids.length) return [];
  const d = await db();
  const qs = ids.map(()=>'?').join(',');
  const rows = await d.all(`SELECT * FROM articles WHERE id IN (${qs})`, ...ids);
  return rows;
}
export async function updateArticleScores(id, scores) {
  const d = await db();
  await d.run(`
    UPDATE articles SET importance=?, hype=?, prominence=?, novelty=?, quality=?, updated_ts=strftime('%s','now') WHERE id=?
  `, scores.importance, scores.hype, scores.prominence, scores.novelty, scores.quality, id);
}

export async function getTopArticlesByWindow(sinceTs, limit=200) {
  const d = await db();
  const rows = await d.all(`
    SELECT a.*, lf.evidence_strength, lf.uncertainty, lf.sensationalism, lf.actionability,
           lf.geo_scope_score, lf.harm_severity, lf.polarization_risk, lf.bias_risk,
           lf.fact_density, lf.time_criticality, lf.followup_potential,
           lf.genre, lf.summary_2sents, lf.key_entities, lf.topics_json
    FROM articles a
    LEFT JOIN llm_features lf ON lf.article_id = a.id
    WHERE a.published_ts >= ?
    ORDER BY a.published_ts DESC
    LIMIT ?
  `, sinceTs, limit);
  return rows;
}

export async function insertPost(userId, items, assets=null) {
  const d = await db();
  const row = await d.run(`
    INSERT INTO posts (user_id, generated_ts, items_json, audio_asset, video_asset, status)
    VALUES (?, strftime('%s','now'), ?, ?, ?, 'ready')
  `, userId, JSON.stringify(items), assets?.audio || null, assets?.video || null);
  return row.lastID;
}
export async function getTodayPost(userId) {
  const d = await db();
  const since = Math.floor(Date.now()/1000) - 24*3600;
  const row = await d.get(`SELECT * FROM posts WHERE user_id=? AND generated_ts>=? ORDER BY generated_ts DESC LIMIT 1`, userId, since);
  return row;
}

export async function getArticlesMissingLLM(limit=20, windowHours=48) {
  const d = await db();
  const since = Math.floor(Date.now()/1000) - windowHours*3600;
  const rows = await d.all(`
    SELECT a.id, a.title, a.summary
    FROM articles a
    LEFT JOIN llm_features lf ON lf.article_id = a.id
    WHERE a.published_ts >= ? AND lf.article_id IS NULL
    ORDER BY a.published_ts DESC
    LIMIT ?`, since, limit);
  return rows;
}

export async function upsertLLMFeatures(articleId, f, version=2) {
  const d = await db();
  const vals = {
    $article_id: articleId,
    $version: version,
    $evidence_strength: f.evidence_strength,
    $uncertainty: f.uncertainty,
    $sensationalism: f.sensationalism,
    $actionability: f.actionability,
    $geo_scope_score: f.geo_scope_score,
    $harm_severity: f.harm_severity,
    $polarization_risk: f.polarization_risk,
    $bias_risk: f.bias_risk,
    $fact_density: f.fact_density,
    $time_criticality: f.time_criticality,
    $followup_potential: f.followup_potential,
    $genre: f.genre || null,
    $evidence_types: JSON.stringify(f.evidence_types || []),
    $key_entities:   JSON.stringify(f.key_entities   || []),
    $geo_targets:    JSON.stringify(f.geo_targets    || []),
    $topics_json:    JSON.stringify(f.topics         || []),
    $summary_2sents: f.summary_2sents || '',
    $raw_json:       JSON.stringify(f)
  };
  await d.run(`
    INSERT INTO llm_features (
      article_id, version,
      evidence_strength, uncertainty, sensationalism, actionability,
      geo_scope_score, harm_severity, polarization_risk, bias_risk, fact_density,
      time_criticality, followup_potential, genre, evidence_types, key_entities, geo_targets,
      topics_json, summary_2sents, raw_json, created_ts, updated_ts
    ) VALUES (
      $article_id, $version,
      $evidence_strength, $uncertainty, $sensationalism, $actionability,
      $geo_scope_score, $harm_severity, $polarization_risk, $bias_risk, $fact_density,
      $time_criticality, $followup_potential, $genre, $evidence_types, $key_entities, $geo_targets,
      $topics_json, $summary_2sents, $raw_json, strftime('%s','now'), strftime('%s','now')
    )
    ON CONFLICT(article_id) DO UPDATE SET
      version=excluded.version,
      evidence_strength=excluded.evidence_strength,
      uncertainty=excluded.uncertainty,
      sensationalism=excluded.sensationalism,
      actionability=excluded.actionability,
      geo_scope_score=excluded.geo_scope_score,
      harm_severity=excluded.harm_severity,
      polarization_risk=excluded.polarization_risk,
      bias_risk=excluded.bias_risk,
      fact_density=excluded.fact_density,
      time_criticality=excluded.time_criticality,
      followup_potential=excluded.followup_potential,
      genre=excluded.genre,
      evidence_types=excluded.evidence_types,
      key_entities=excluded.key_entities,
      geo_targets=excluded.geo_targets,
      topics_json=excluded.topics_json,
      summary_2sents=excluded.summary_2sents,
      raw_json=excluded.raw_json,
      updated_ts=strftime('%s','now')
  `, vals);
}

export async function upsertFeedback(userId, articleId, vote) {
  const d = await db();
  await d.run(`
    INSERT INTO feedback (user_id, article_id, vote, updated_ts)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, article_id) DO UPDATE SET vote=excluded.vote, updated_ts=strftime('%s','now')
  `, userId, articleId, vote);
}
export async function getFeedbackVote(userId, articleId) {
  const d = await db();
  const row = await d.get(`SELECT vote FROM feedback WHERE user_id=? AND article_id=?`, userId, articleId);
  return row ? row.vote : 0;
}

export async function getUserFeedbackProfile(userId) {
  const d = await db();
  const liked = await d.all(`
    SELECT a.importance, a.hype, a.prominence, a.novelty, a.quality,
           lf.evidence_strength, lf.uncertainty, lf.sensationalism, lf.bias_risk, lf.polarization_risk,
           lf.fact_density, lf.time_criticality, lf.actionability, lf.harm_severity, lf.geo_scope_score
    FROM feedback f
    JOIN articles a ON a.id = f.article_id
    LEFT JOIN llm_features lf ON lf.article_id = a.id
    WHERE f.user_id=? AND f.vote=1
  `, userId);
  const disliked = await d.all(`
    SELECT a.importance, a.hype, a.prominence, a.novelty, a.quality,
           lf.evidence_strength, lf.uncertainty, lf.sensationalism, lf.bias_risk, lf.polarization_risk,
           lf.fact_density, lf.time_criticality, lf.actionability, lf.harm_severity, lf.geo_scope_score
    FROM feedback f
    JOIN articles a ON a.id = f.article_id
    LEFT JOIN llm_features lf ON lf.article_id = a.id
    WHERE f.user_id=? AND f.vote=-1
  `, userId);

  const avg = (rows, key, scale=100) => {
    if (!rows.length) return 0;
    let s = 0, n=0;
    for (const r of rows) if (r[key] != null) { s += (scale==100 ? r[key]/100.0 : r[key]); n++; }
    return n ? s/n : 0;
  };
  const pos = {
    I: avg(liked,'importance'), H: avg(liked,'hype'), P: avg(liked,'prominence'),
    N: avg(liked,'novelty'), Q: avg(liked,'quality'),
    L: (avg(liked,'evidence_strength',1) + avg(liked,'fact_density',1) + avg(liked,'actionability',1) +
        avg(liked,'time_criticality',1) + avg(liked,'harm_severity',1) + avg(liked,'geo_scope_score',1)) / 6
  };
  const neg = {
    I: avg(disliked,'importance'), H: avg(disliked,'hype'), P: avg(disliked,'prominence'),
    N: avg(disliked,'novelty'), Q: avg(disliked,'quality'),
    L: (avg(disliked,'evidence_strength',1) + avg(disliked,'fact_density',1) + avg(disliked,'actionability',1) +
        avg(disliked,'time_criticality',1) + avg(disliked,'harm_severity',1) + avg(disliked,'geo_scope_score',1)) / 6
  };
  return { I: pos.I - neg.I, H: pos.H - neg.H, P: pos.P - neg.P, N: pos.N - neg.N, Q: pos.Q - neg.Q, L: pos.L - neg.L };
}

export async function getFeedbackTopics(userId) {
  const d = await db();
  const rows = await d.all(`
    SELECT f.vote, lf.topics_json
    FROM feedback f
    JOIN llm_features lf ON lf.article_id = f.article_id
    WHERE f.user_id=?
  `, userId);
  return rows;
}
