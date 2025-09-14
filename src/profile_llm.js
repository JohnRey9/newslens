
import OpenAI from 'openai';
import { logger } from './logger.js';
import { canonicalizeTopics } from './topic_normalizer.js';

const log = logger.child({ mod: 'profile_llm' });

const SYS = `Ты — ассистент, который превращает свободный текст интересов пользователя в структурный профиль для рекомендательной системы новостей.
Правила:
- Пиши ТОЛЬКО валидный JSON (без комментариев).
- Все веса в диапазоне 0..1.
- Теги — короткие русские, без хэштегов.
- Если интерес общий, расширь до нескольких релевантных тегов и сущностей.
- Если полей нет — верни пустые структуры, но все ключи объекта должны присутствовать.`;

function clamp01(x) { return Math.max(0, Math.min(1, Number(x)||0)); }
function dedup(arr, key='tag', max=12) {
  const seen = new Set(); const out = [];
  for (const v of (arr||[])) {
    const k = String((v && typeof v === 'object') ? (v[key] ?? v.name ?? v.term ?? v.keyword) : v).toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
function normalizeTopicItem(t) {
  if (typeof t === 'string') return { tag: t.toLowerCase().trim(), weight: 0.6, synonyms: [] };
  const tag = String(t.tag ?? t.name ?? t.term ?? t.keyword ?? '').toLowerCase().trim();
  const weight = clamp01(t.weight ?? t.score ?? 0.6);
  const synonyms = dedup(t.synonyms ?? t.aliases ?? [], 'tag', 8).map(s => String(s).toLowerCase().trim());
  return tag ? { tag, weight, synonyms } : null;
}
function normalizeEntityItem(e) {
  if (typeof e === 'string') return { name: e.toLowerCase().trim(), weight: 0.5, synonyms: [] };
  const name = String(e.name ?? e.tag ?? e.term ?? e.keyword ?? '').toLowerCase().trim();
  const weight = clamp01(e.weight ?? e.score ?? 0.5);
  const synonyms = dedup(e.synonyms ?? e.aliases ?? [], 'name', 8).map(s => String(s).toLowerCase().trim());
  return name ? { name, weight, synonyms } : null;
}
function normalizeProfileShape(obj) {
  const out = {};
  out.version = 1;
  out.languages = ['ru'];
  let topicsSrc = obj.topics ?? obj.tags ?? obj.interests ?? [];
  if (!Array.isArray(topicsSrc)) topicsSrc = [];
  out.topics = dedup(topicsSrc, 'tag', 24).map(normalizeTopicItem).filter(Boolean);
  out.entities = {};
  const buckets = { games: [], companies: [], teams: [], people: [] };
  const inEntities = obj.entities || {};
  for (const k of Object.keys(buckets)) {
    let src = inEntities[k] ?? [];
    if (!Array.isArray(src)) src = [];
    out.entities[k] = dedup(src, 'name', 32).map(normalizeEntityItem).filter(Boolean);
  }
  if (obj.genre_weights && typeof obj.genre_weights === 'object') {
    const allowed = ["hard_news","live_update","analysis","opinion","interview","press_release","feature","other"];
    const gw = {};
    for (const k of allowed) if (obj.genre_weights[k] != null) gw[k] = clamp01(obj.genre_weights[k]);
    out.genre_weights = gw;
  } else {
    out.genre_weights = {};
  }
  if (obj.quality_bias && typeof obj.quality_bias === 'object') {
    out.quality_bias = {
      prefer_low_sensationalism: clamp01(obj.quality_bias.prefer_low_sensationalism ?? 0.5),
      prefer_low_uncertainty: clamp01(obj.quality_bias.prefer_low_uncertainty ?? 0.5),
    };
  } else {
    out.quality_bias = { prefer_low_sensationalism: 0.5, prefer_low_uncertainty: 0.5 };
  }
  return out;
}

export const PROFILE_SCHEMA = {
  name: "UserInterestProfile",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      topics: { type: "array", maxItems: 24, items: {
        type: "object", additionalProperties: false,
        properties: {
          tag: { type: "string", minLength: 2, maxLength: 40 },
          weight: { type: "number", minimum: 0, maximum: 1 },
          synonyms: { type: "array", items: { type: "string" }, maxItems: 8 }
        },
        required: ["tag","weight","synonyms"]
      }},
      entities: { type: "object", additionalProperties: false, properties: {
        games: { type: "array", maxItems: 32, items: {
          type: "object", additionalProperties: false,
          properties: { name: { type: "string" }, weight: { type: "number", minimum:0, maximum:1 }, synonyms: { type:"array", items:{type:"string"}, maxItems:8 } },
          required: ["name","weight","synonyms"]
        }},
        companies: { type: "array", maxItems: 32, items: {
          type: "object", additionalProperties: false,
          properties: { name: { type: "string" }, weight: { type: "number", minimum:0, maximum:1 }, synonyms: { type:"array", items:{type:"string"}, maxItems:8 } },
          required: ["name","weight","synonyms"]
        }},
        teams: { type: "array", maxItems: 32, items: {
          type: "object", additionalProperties: false,
          properties: { name: { type: "string" }, weight: { type: "number", minimum:0, maximum:1 }, synonyms: { type:"array", items:{type:"string"}, maxItems:8 } },
          required: ["name","weight","synonyms"]
        }},
        people: { type: "array", maxItems: 32, items: {
          type: "object", additionalProperties: false,
          properties: { name: { type: "string" }, weight: { type: "number", minimum:0, maximum:1 }, synonyms: { type:"array", items:{type:"string"}, maxItems:8 } },
          required: ["name","weight","synonyms"]
        }}
      },
      required: ["games","companies","teams","people"]
      },
      genre_weights: { type: "object", additionalProperties: false, properties: {
        hard_news: { type:"number", minimum:0, maximum:1 },
        live_update: { type:"number", minimum:0, maximum:1 },
        analysis: { type:"number", minimum:0, maximum:1 },
        opinion: { type:"number", minimum:0, maximum:1 },
        interview: { type:"number", minimum:0, maximum:1 },
        press_release: { type:"number", minimum:0, maximum:1 },
        feature: { type:"number", minimum:0, maximum:1 },
        other: { type:"number", minimum:0, maximum:1 }
      }},
      quality_bias: { type:"object", additionalProperties: false, properties: {
        prefer_low_sensationalism: { type:"number", minimum:0, maximum:1 },
        prefer_low_uncertainty: { type:"number", minimum:0, maximum:1 }
      },
      required: ["prefer_low_sensationalism","prefer_low_uncertainty"]
      }
    },
    required: ["topics","entities","genre_weights","quality_bias"]
  }
};

function heuristicTopicsFromPrompt(text='') {
  const s = String(text||'').toLowerCase();
  const res = [];
  const push = (tag, w=0.6) => { if (!res.some(x=>x.tag===tag)) res.push({ tag, weight: w }); };
  if (s.includes('киберспорт') || s.includes('esports') || s.includes('e-sports')) push('киберспорт', 0.7);
  if (s.includes('игр') || s.includes('видеоигр') || s.includes('гейминг')) push('игры', 0.7);
  if (s.includes('путин') || s.includes('кремл')) { push('владимир путин', 0.7); push('политика', 0.6); }
  if (s.includes('спорт')) push('спорт', 0.6);
  if (s.includes('тех') || s.includes('айти') || s.includes('it')) push('технологии', 0.6);
  if (s.includes('эконом')) push('экономика', 0.6);
  if (s.includes('финанс')) push('финансы', 0.6);
  if (s.includes('кино') || s.includes('фильм') || s.includes('сериал')) push('кино', 0.55);
  if (s.includes('музык')) push('музыка', 0.55);
  if (s.includes('наук') || s.includes('космос')) push('наука', 0.55);
  return res.slice(0, 8);
}

export async function extractInterestProfile(promptText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const openai = new OpenAI({ apiKey });

  const t = log.time('profile.request', { len: (promptText||'').length });
  let raw = '{}', usedSchema = true;
  try {
    const res = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `Преобразуй интересы:

${JSON.stringify(promptText)}` }
      ],
      response_format: { type: 'json_schema', json_schema: PROFILE_SCHEMA }
    });
    raw = (res.choices?.[0]?.message?.content || '{}').trim();
  } catch (e) {
    usedSchema = false;
    const res2 = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `Преобразуй интересы:

${JSON.stringify(promptText)}` }
      ],
      response_format: { type: 'json_object' }
    });
    raw = (res2.choices?.[0]?.message?.content || '{}').trim();
  }
  let obj = {};
  try { obj = JSON.parse(raw); } catch { obj = {}; }
  let norm = normalizeProfileShape(obj);

  // Канонизация
  try {
    const canon = await canonicalizeTopics((norm.topics || []).map(t => ({ tag: t.tag, weight: t.weight })));
    norm.topics = canon.map(it => ({ tag: it.tag, weight: it.weight ?? 0.6, family: it.family }));
  } catch (e) {
    log.warn('profile.canon.fail', { err: e?.message });
  }

  // Если по какой-то причине тем нет — эвристический фоллбек из промпта
  if (!Array.isArray(norm.topics) || norm.topics.length === 0) {
    try {
      const heur = heuristicTopicsFromPrompt(promptText);
      if (heur.length) {
        const canon2 = await canonicalizeTopics(heur);
        norm.topics = canon2.map(it => ({ tag: it.tag, weight: it.weight ?? 0.6, family: it.family }));
      }
    } catch (e) {
      log.warn('profile.heuristic.fail', { err: e?.message });
    }
  }

  t.end({ ok: true, topics: norm.topics?.length || 0, schema: usedSchema });
  return norm;
}
