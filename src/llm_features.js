
import OpenAI from 'openai';
import { logger } from './logger.js';
import { canonicalizeTopics } from './topic_normalizer.js';

const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const log = logger.child({ mod: 'llm' });

export const LLM_SCHEMA = {
  name: "NewsLLMFeatures",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      evidence_strength:   { type: "number", minimum: 0, maximum: 1 },
      fact_density:        { type: "number", minimum: 0, maximum: 1 },
      uncertainty:         { type: "number", minimum: 0, maximum: 1 },
      bias_risk:           { type: "number", minimum: 0, maximum: 1 },
      sensationalism:      { type: "number", minimum: 0, maximum: 1 },
      geo_scope_score:     { type: "number", minimum: 0, maximum: 1 },
      harm_severity:       { type: "number", minimum: 0, maximum: 1 },
      polarization_risk:   { type: "number", minimum: 0, maximum: 1 },
      time_criticality:    { type: "number", minimum: 0, maximum: 1 },
      actionability:       { type: "number", minimum: 0, maximum: 1 },
      followup_potential:  { type: "number", minimum: 0, maximum: 1 },
      genre: { type: "string", enum: ["hard_news","live_update","analysis","opinion","interview","press_release","feature","other"] },
      evidence_types: { type: "array", maxItems: 6,
        items: { type: "string", enum: ["official","company","court","academic","dataset","eyewitness","leak","media","unknown"] } },
      key_entities: { type: "array", maxItems: 8, items: { type: "string" } },
      geo_targets: { type: "array", maxItems: 5, items: { type: "string" } },
      topics: { type: "array", maxItems: 8, items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tag:   { type: "string", minLength: 2, maxLength: 40 },
          score: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["tag","score"]
      }},
      summary_2sents: { type: "string", maxLength: 400 }
    },
    required: [
      "evidence_strength","fact_density","uncertainty","bias_risk","sensationalism",
      "geo_scope_score","harm_severity","polarization_risk","time_criticality",
      "actionability","followup_potential","genre","evidence_types","key_entities","geo_targets",
      "topics","summary_2sents"
    ]
  }
};

function buildPrompt({ title, summary }) {
  return [
    { role: "system", content:
`Ты — аналитик новостей. Выделяй абстрактные признаки для ранжирования и тематические теги.
Правила:
- Оценивай только по заголовку и краткому описанию.
- Численные поля строго в диапазоне 0..1.
- Поле topics — до 8 тегов: лаконичные русские теги, без хэштегов и повторов; score 0..1 отражает силу соответствия.
- Отвечай ТОЛЬКО JSON, без комментариев.` },
    { role: "user", content:
`Новость (RU):
Заголовок: ${title}
Описание: ${summary || ""}

Верни JSON по заданной схеме.` }
  ];
}

function clamp01(x) { return Math.max(0, Math.min(1, Number(x)||0)); }
function dedupTags(arr, max) {
  const seen = new Set(); const out = [];
  for (const t of (arr||[])) {
    const tag = String(t?.tag||'').toLowerCase().trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, score: clamp01(t?.score) });
    if (out.length >= max) break;
  }
  return out;
}

const ALLOWED_EVIDENCE = new Set(["official","company","court","academic","dataset","eyewitness","leak","media","unknown"]);

function sanitize(out) {
  const numKeys = ["evidence_strength","fact_density","uncertainty","bias_risk","sensationalism",
                   "geo_scope_score","harm_severity","polarization_risk","time_criticality",
                   "actionability","followup_potential"];
  for (const k of numKeys) if (k in out) out[k] = clamp01(out[k]);
  out.evidence_types = (out.evidence_types||[]).filter(x=>ALLOWED_EVIDENCE.has(String(x)));
  out.key_entities   = Array.isArray(out.key_entities) ? out.key_entities.slice(0,8) : [];
  out.geo_targets    = Array.isArray(out.geo_targets) ? out.geo_targets.slice(0,5) : [];
  out.topics         = dedupTags(out.topics || [], 8);
  if (typeof out.summary_2sents === 'string' && out.summary_2sents.length > 400) {
    out.summary_2sents = out.summary_2sents.slice(0, 400);
  }
  return out;
}

export async function extractLLMFeatures({ title, summary, articleId=null }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const openai = new OpenAI({ apiKey });

  const t = log.time('llm.request', { articleId, title_len: (title||'').length, summary_len: (summary||'').length });
  try {
    const res = await openai.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0,
      messages: buildPrompt({ title, summary }),
      response_format: { type: "json_schema", json_schema: LLM_SCHEMA }
    });
    const content = (res.choices?.[0]?.message?.content || "{}").trim();
    try {
      const outRaw = sanitize(JSON.parse(content));
      // 🔧 Канонизируем темы + добавляем family
      outRaw.topics = await canonicalizeTopics(outRaw.topics || []);
      const out = outRaw;
      t.end({ ok: true });
      return out;
    } catch {
      const res2 = await openai.chat.completions.create({
        model: LLM_MODEL,
        temperature: 0,
        messages: buildPrompt({ title, summary }),
        response_format: { type: "json_object" }
      });
      const c2 = (res2.choices?.[0]?.message?.content || "{}").trim();
      const outRaw = sanitize(JSON.parse(c2));
      outRaw.topics = await canonicalizeTopics(outRaw.topics || []);
      const out = outRaw;
      t.end({ ok: true, fallback: true });
      return out;
    }
  } catch (e) {
    t.end({ ok: false, err: e?.message });
    log.warn('llm.error', { articleId, err: e?.message });
    throw e;
  }
}
