import OpenAI from 'openai';
import { db } from './db.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'topic_norm' });

const EMB_MODEL = process.env.TOPIC_EMB_MODEL || 'text-embedding-3-small';
const SIM_THRESHOLD = Number(process.env.TOPIC_SIM_THRESHOLD || 0.82);
const USE_LLM = (process.env.TOPIC_LLM_DISAMBIG || '1') !== '0';
const CANON_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CANONICAL = Number(process.env.TOPIC_ALIAS_MAX || 5000);

const memAlias = new Map();
let canonListCache = null;
let canonListLoadedAt = 0;

function now() { return Date.now(); }
function normSurface(s = '') {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[#.,!?:;"'()\[\]{}]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function cosine(a = [], b = []) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function ensureTables() {
  const d = await db();
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
}

async function loadCanonList() {
  if (canonListCache && (now() - canonListLoadedAt) < CANON_CACHE_TTL_MS) return canonListCache;
  const d = await db();
  const rows = await d.all(`SELECT canonical, parent_canonical, embedding_json FROM topic_vocab`);
  canonListCache = rows.map(r => ({
    canonical: r.canonical,
    parent: r.parent_canonical || null,
    emb: r.embedding_json ? JSON.parse(r.embedding_json) : []
  }));
  canonListLoadedAt = now();
  return canonListCache;
}

async function lookupAliasDB(alias) {
  const d = await db();
  const row = await d.get(`SELECT canonical, confidence FROM topic_map WHERE alias=?`, alias);
  if (!row) return null;
  const parentRow = await d.get(`SELECT parent_canonical FROM topic_vocab WHERE canonical=?`, row.canonical);
  return { canonical: row.canonical, parent: parentRow?.parent_canonical || null, confidence: row.confidence || 0.9 };
}

async function upsertCanonicalDB({ canonical, parent = null, embedding = null, aliases = [] }) {
  const d = await db();
  const row = await d.get(`SELECT canonical FROM topic_vocab WHERE canonical=?`, canonical);
  if (!row) {
    await d.run(`INSERT INTO topic_vocab (canonical, parent_canonical, aliases_json, embedding_json, updated_ts)
                 VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      canonical, parent, JSON.stringify(aliases || []), embedding ? JSON.stringify(embedding) : null);
  } else {
    await d.run(`UPDATE topic_vocab SET parent_canonical=?, aliases_json=?, embedding_json=?, updated_ts=strftime('%s','now') WHERE canonical=?`,
      parent, JSON.stringify(aliases || []), embedding ? JSON.stringify(embedding) : null, canonical);
  }
  canonListCache = null; canonListLoadedAt = 0;
}
async function upsertAliasDB(alias, canonical, confidence = 0.9) {
  const d = await db();
  await d.run(`INSERT OR REPLACE INTO topic_map (alias, canonical, confidence, created_ts)
               VALUES (?, ?, ?, strftime('%s','now'))`, alias, canonical, confidence);
}

async function embedText(text) {
  if (!process.env.OPENAI_API_KEY) return null;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.embeddings.create({ model: EMB_MODEL, input: text });
  return res.data?.[0]?.embedding || null;
}

async function nearestCanonicalByEmb(alias) {
  const emb = await embedText(alias);
  if (!emb) return null;
  const candidates = await loadCanonList();
  let best = null, bestSim = 0;
  for (const c of candidates) {
    if (!c.emb?.length) continue;
    const sim = cosine(emb, c.emb);
    if (sim > bestSim) { bestSim = sim; best = c; }
  }
  if (best && bestSim >= SIM_THRESHOLD) return { canonical: best.canonical, parent: best.parent, confidence: bestSim, emb };
  return { canonical: null, parent: null, confidence: bestSim, emb };
}

async function llmCanonicalize(alias) {
  if (!USE_LLM || !process.env.OPENAI_API_KEY) return { canonical: alias, parent: null, synonyms: [] };
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const SYS = `Ты нормализуешь русские тематические теги для рекомендательной системы новостей.
Верни краткий канонический тег и, если уместно, его родительскую широкую категорию (family).
Если нет родительской категории — верни parent как пустую строку "".
Всегда возвращай ключи canonical, parent, synonyms (даже если пустые).`;
  const SCHEMA = {
    name: "TopicCanonical",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        canonical: { type: "string", minLength: 2, maxLength: 40 },
        parent:    { type: "string", minLength: 0, maxLength: 40 },
        synonyms:  { type: "array", maxItems: 8, items: { type: "string" } }
      },
      required: ["canonical","parent","synonyms"]
    }
  };
  const res = await openai.chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: `Нормализуй тег: ${alias}\nВерни JSON.` }
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA }
  });
  const raw = (res.choices?.[0]?.message?.content || '{}').trim();
  try {
    const out = JSON.parse(raw);
    if (!out.parent || !out.parent.trim()) out.parent = null;
    if (!Array.isArray(out.synonyms)) out.synonyms = [];
    return out;
  } catch {
    return { canonical: alias, parent: null, synonyms: [] };
  }
}

async function countCanonicals() {
  const d = await db();
  const r = await d.get(`SELECT COUNT(*) AS n FROM topic_vocab`);
  return r?.n || 0;
}

export async function canonicalizeTag(inputTag) {
  await ensureTables();
  const surface = normSurface(inputTag);
  if (!surface) return { canonical: '', parent: null, confidence: 0 };
  if (memAlias.has(surface)) return memAlias.get(surface);
  const hit = await lookupAliasDB(surface);
  if (hit) { memAlias.set(surface, hit); return hit; }

  try {
    const byEmb = await nearestCanonicalByEmb(surface);
    if (byEmb?.canonical) {
      const mapped = { canonical: byEmb.canonical, parent: byEmb.parent, confidence: byEmb.confidence };
      await upsertAliasDB(surface, mapped.canonical, mapped.confidence);
      memAlias.set(surface, mapped);
      return mapped;
    }
  } catch (e) {
    log.warn('topic.emb.fail', { err: e?.message });
  }

  try {
    const tooMany = (await countCanonicals()) > MAX_CANONICAL;
    const useLLM = USE_LLM && !tooMany;
    let canonical = surface, parent = null, synonyms = [];
    if (useLLM) {
      const out = await llmCanonicalize(surface);
      canonical = normSurface(out.canonical || surface);
      parent = out.parent ? normSurface(out.parent) : null;
      synonyms = Array.isArray(out.synonyms) ? out.synonyms.map(normSurface).filter(Boolean) : [];
    }
    const emb = await embedText(canonical);
    await upsertCanonicalDB({ canonical, parent, embedding: emb, aliases: [surface, ...synonyms] });
    await upsertAliasDB(surface, canonical, 0.7);
    for (const al of synonyms) await upsertAliasDB(al, canonical, 0.6);
    const res = { canonical, parent, confidence: 0.7 };
    memAlias.set(surface, res);
    return res;
  } catch (e) {
    log.warn('topic.llm.fail', { tag: surface, err: e?.message });
    const fallback = { canonical: surface, parent: null, confidence: 0.3 };
    memAlias.set(surface, fallback);
    return fallback;
  }
}

export async function canonicalizeTopics(items = [], { preserveWeight = true } = {}) {
  const uniq = new Map();
  items.forEach((it, idx) => {
    const raw = (it?.tag ?? it?.name ?? '').toString();
    const s = normSurface(raw);
    if (!s) return;
    if (!uniq.has(s)) uniq.set(s, []);
    uniq.get(s).push(idx);
  });

  const resolved = new Map();
  for (const s of uniq.keys()) {
    const r = await canonicalizeTag(s);
    resolved.set(s, r);
  }

  const out = [];
  for (const it of items) {
    const raw = (it?.tag ?? it?.name ?? '').toString();
    const s = normSurface(raw);
    if (!s || !resolved.has(s)) continue;
    const { canonical, parent } = resolved.get(s);
    const o = { ...it, tag: canonical };
    o.family = parent || canonical;
    out.push(o);
  }
  return out;
}
