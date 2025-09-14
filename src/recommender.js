
import { getTopArticlesByWindow, getUserProfile, getUserInterestProfile, getFeedbackTopics, getUserFeedbackProfile } from './db.js';
import { clamp01 } from './utils.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'recommender' });

function llmComposite(a) {
  if (a.evidence_strength == null && a.uncertainty == null) return 0;
  const pos = [a.evidence_strength, a.fact_density, a.actionability, a.time_criticality, a.harm_severity, a.geo_scope_score]
    .filter(v => typeof v === 'number');
  const neg = [a.uncertainty, a.sensationalism, a.bias_risk, a.polarization_risk]
    .filter(v => typeof v === 'number');
  const avg = arr => arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0;
  const raw = avg(pos) - 0.7*avg(neg);
  return clamp01(0.5 + raw/2);
}

function profileTopicsRelevance(articleTopics=[], profileTopics=[]) {
  if (!profileTopics.length || !articleTopics.length) return 0;
  const aTag = new Map();      // canonical tag -> score
  const aFam = new Map();      // family       -> score
  for (const t of articleTopics) {
    const tag = String(t.tag||'').toLowerCase().trim();
    const fam = String(t.family||tag).toLowerCase().trim();
    const sc = Math.max(0, Math.min(1, Number(t.score)||0));
    if (tag) aTag.set(tag, Math.max(aTag.get(tag)||0, sc));
    if (fam) aFam.set(fam, Math.max(aFam.get(fam)||0, sc));
  }
  let intersect = 0, sumW = 0;
  for (const pt of profileTopics) {
    const tag = String(pt.tag||'').toLowerCase().trim();
    const w = Math.max(0, Math.min(1, Number(pt.weight)||0.5));
    if (!tag) continue;
    const direct = aTag.get(tag) || 0;
    const family = aFam.get(tag) || 0; // если тег профиля — семейство для статьи
    const at = Math.max(direct, 0.9*family);
    intersect += Math.min(w, at);
    sumW += w;
  }
  if (!sumW) return 0;
  return Math.min(1, intersect / sumW);
}

async function buildFeedbackTopicVector(userId) {
  const rows = await getFeedbackTopics(userId);
  const map = new Map();
  let denom = 0;
  for (const r of rows) {
    let topics = [];
    try { topics = JSON.parse(r.topics_json || '[]'); } catch { topics = []; }
    for (const t of topics) {
      const tag = String(t.tag||'').toLowerCase().trim();
      const fam = String(t.family||tag).toLowerCase().trim();
      const key = fam || tag;
      const sc = Math.max(0, Math.min(1, Number(t.score)||0));
      if (!key || sc <= 0) continue;
      const delta = (r.vote > 0 ? +1 : r.vote < 0 ? -1 : 0) * sc;
      if (!delta) continue;
      map.set(key, (map.get(key)||0) + delta);
      denom += Math.abs(delta);
    }
  }
  if (!map.size || denom === 0) return map;
  let maxAbs = 0;
  for (const v of map.values()) maxAbs = Math.max(maxAbs, Math.abs(v));
  if (maxAbs > 0) for (const [k,v] of map.entries()) map.set(k, v / maxAbs);
  return map;
}

function feedbackTopicRel(articleTopics, fbMap) {
  if (!articleTopics?.length || !fbMap || !fbMap.size) return 0;
  let num = 0, denom = 0;
  for (const t of articleTopics) {
    const tag = String(t.tag||'').toLowerCase().trim();
    const fam = String(t.family||tag).toLowerCase().trim();
    const key = fam || tag;
    const sc = Math.max(0, Math.min(1, Number(t.score)||0));
    if (!key || sc <= 0) continue;
    const pref = fbMap.get(key) || 0; // [-1..1]
    num += sc * pref;
    denom += sc;
  }
  if (!denom) return 0;
  return Math.max(-1, Math.min(1, num / denom));
}

/** ---------- Диверсификация ---------- **/
function leadingProfileTopic(articleTopics, profileTopics) {
  if (!articleTopics?.length || !profileTopics?.length) return { topic: null, score: 0 };
  let bestTopic = null, best = 0;
  for (const pt of profileTopics) {
    const ptTag = String(pt.tag||'').toLowerCase().trim();
    const pw = Math.max(0, Math.min(1, Number(pt.weight)||0.5));
    let match = 0;
    for (const at of articleTopics) {
      const aTag = String(at.tag||'').toLowerCase().trim();
      const aFam = String(at.family||aTag).toLowerCase().trim();
      const as = Math.max(0, Math.min(1, Number(at.score)||0));
      if (!aTag || !ptTag) continue;
      if (aTag === ptTag || aFam === ptTag) match = Math.max(match, as * pw);
      else if (aTag.includes(ptTag) || ptTag.includes(aTag)) match = Math.max(match, 0.6 * as * pw);
    }
    if (match > best) { best = match; bestTopic = ptTag; }
  }
  return { topic: bestTopic, score: best };
}

function groupByTopic(scored, profile, { topK=Number(process.env.DIVERSITY_TOP_K||4), minAssignScore=0.05 }={}) {
  const pTopics = (profile?.topics || [])
    .map(t => ({ tag: String(t.tag||'').toLowerCase().trim(), weight: Math.max(0, Math.min(1, Number(t.weight)||0.5)) }))
    .filter(t => t.tag)
    .sort((a,b)=>b.weight-a.weight)
    .slice(0, topK);

  const buckets = new Map();
  for (const t of pTopics) buckets.set(t.tag, []);
  buckets.set('misc', []);

  for (const it of scored) {
    let topics = [];
    try { topics = JSON.parse(it.topics_json || '[]'); } catch { topics = []; }
    const { topic, score } = leadingProfileTopic(topics, pTopics);
    const key = (topic && score >= minAssignScore) ? topic : 'misc';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  for (const [k,arr] of buckets.entries()) arr.sort((x,y)=>y.score-x.score || y.published_ts-x.published_ts);
  return { pTopics, buckets };
}

function computeQuotas(pTopics, buckets, limit, { minPerTopic=Number(process.env.DIVERSITY_MIN_PER_TOPIC||1), maxShare=Number(process.env.DIVERSITY_MAX_SHARE||0.5) }={}) {
  const quotas = new Map();
  const active = pTopics.filter(t => (buckets.get(t.tag)?.length || 0) > 0);
  if (!active.length) return quotas;

  const sumW = active.reduce((s,t)=>s+t.weight, 0) || active.length;
  const maxCap = Math.max(1, Math.floor(limit * maxShare));

  let total = 0;
  for (const t of active) {
    const avail = buckets.get(t.tag).length;
    let q = Math.round((t.weight / sumW) * limit);
    q = Math.max(Math.min(avail, maxCap), Math.min(minPerTopic, avail));
    quotas.set(t.tag, q);
    total += q;
  }
  const sum = () => Array.from(quotas.values()).reduce((s,x)=>s+x,0);
  while (sum() > limit) {
    const key = Array.from(quotas.entries()).sort((a,b)=>b[1]-a[1]).find(([k,v])=>v>0)?.[0];
    if (!key) break;
    quotas.set(key, quotas.get(key)-1);
  }
  while (sum() < limit) {
    const cand = active
      .filter(t => {
        const q = quotas.get(t.tag) || 0;
        const avail = buckets.get(t.tag).length;
        return q < Math.min(avail, maxCap);
      })
      .sort((a,b)=> ( (b.weight/( (quotas.get(b.tag)||0)+1 )) - (a.weight/( (quotas.get(a.tag)||0)+1 )) ));
    if (!cand.length) break;
    const k = cand[0].tag;
    quotas.set(k, (quotas.get(k)||0)+1);
  }
  return quotas;
}

function pickDiversified(buckets, quotas, limit) {
  const picked = [];
  const order = Array.from(quotas.keys());
  const idx = new Map(order.map(k => [k, 0]));
  const used = new Set();
  while (picked.length < limit && quotas.size) {
    let progressed = false;
    for (const k of order) {
      const need = (quotas.get(k) || 0);
      if (need <= 0) continue;
      const arr = buckets.get(k) || [];
      let i = idx.get(k) || 0;
      while (i < arr.length && used.has(arr[i].id)) i++;
      if (i < arr.length) {
        picked.push(arr[i]); used.add(arr[i].id); quotas.set(k, need-1); idx.set(k, i+1); progressed = true;
        if (picked.length >= limit) break;
      }
    }
    if (!progressed) break;
  }
  if (picked.length < limit) {
    const rest = [];
    for (const arr of buckets.values()) for (const it of arr) if (!used.has(it.id)) rest.push(it);
    rest.sort((x,y)=>y.score-x.score || y.published_ts-x.published_ts);
    for (const it of rest) {
      picked.push(it); used.add(it.id);
      if (picked.length >= limit) break;
    }
  }
  return picked.slice(0, limit);
}

export async function rankForUser(userId, {windowHours=24, limit=10, requireLLM=false}={}) {
  const user = await getUserProfile(userId);
  const interest = await getUserInterestProfile(userId);
  const fbVec = await buildFeedbackTopicVector(userId);
  const fbLatent = await getUserFeedbackProfile(userId);

  const pWeight   = Number(process.env.PROFILE_WEIGHT || 0.8);
  const lWeight   = Number(process.env.LLM_WEIGHT     || 0.6);
  const fWeight   = Number(process.env.FEEDBACK_WEIGHT|| 0.2);
  const baseWeight= Number(process.env.BASE_WEIGHT    || 0.05);

  const since = Math.floor(Date.now()/1000) - windowHours*3600;
  let articles = await getTopArticlesByWindow(since, 800);
  if (requireLLM) {
    articles = articles.filter(a => a.evidence_strength != null || a.genre != null || a.summary_2sents != null);
  }

  const scored = articles.map(a => {
    const base = ( (a.importance??0) + (a.hype??0) + (a.prominence??0) + (a.novelty??0) + (a.quality??0) ) / (5*100.0);
    let topics = [];
    try { topics = JSON.parse(a.topics_json || '[]'); } catch { topics = []; }

    const profRel = interest ? profileTopicsRelevance(topics, interest.topics || []) : 0;
    const llm = llmComposite(a);

    const fbTopic = feedbackTopicRel(topics, fbVec); // [-1..1]
    const fbLLM = (fbLatent?.L || 0) * (llm - 0.5);
    const fbAdj = 0.6*fbTopic + 0.4*fbLLM;

    const baseScale = (a.evidence_strength == null && a.genre == null) ? 1.0 : 0.2;
    const baseTerm = base * baseScale;

    const score = (pWeight * profRel) + (lWeight * llm) + (fWeight * fbAdj) + (baseWeight * baseTerm);
    return { ...a, profRel, llm, fbTopic, fbLLM, fbAdj, base, baseTerm, score };
  });

  scored.sort((x,y) => y.score - x.score || y.published_ts - x.published_ts);

  const diversityOn = (process.env.DIVERSITY_ENABLED ?? '1') !== '0';
  if (diversityOn && (interest?.topics?.length || 0) > 0 && limit > 1) {
    const { pTopics, buckets } = groupByTopic(scored, interest, {});
    const quotas = computeQuotas(pTopics, buckets, limit, {});
    const mixed = pickDiversified(buckets, quotas, limit);
    log.debug('rank.diversified', {
      userId, limit,
      buckets: Object.fromEntries(Array.from(buckets.entries()).map(([k,v])=>[k, v.length])),
      quotas : Object.fromEntries(Array.from(quotas.entries())),
      picked : mixed.length
    });
    return mixed;
  }
  return scored.slice(0, limit);
}
