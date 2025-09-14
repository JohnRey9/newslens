
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { logger } from './logger.js';

const log = logger.child({ mod: 'audio' });

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function buildItemsText(items) {
  return items.map((it, i) => `${i+1}. ${it.source} — ${it.title}.`).join('\n');
}

function buildScriptPrompt(newsListText) {
  return [
    { role: 'system', content:
`Ты — профессиональный русскоязычный радиоведущий. Твоя задача — сделать короткий аудио-дайджест новостей.
Правила:
- Стиль живой, дружелюбный, без канцелярита. Можно 1–2 лёгкие уместные шутки.
- Без оскорблений и токсичности, соблюдай корректность.
- Сделай структурированное повествование: интро (1–2 фразы) → 4–8 коротких пунктов → аутро (1 фраза).
- 60–120 секунд аудио. Язык: русский.` },
    { role: 'user', content:
`Вот список свежих новостей (краткий тезис в одну строку на новость):
${newsListText}

Собери по ним аудио-скрипт, как для радио.` }
  ];
}

export async function buildAudioNewsForItems(userId, items, outDir = process.env.AUDIO_DIR || '/app/media/audio') {
  if (!process.env.OPENAI_API_KEY) {
    log.warn('audio.no_key', {});
    return { script: null, audioPath: null };
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  ensureDir(outDir);

  const listText = buildItemsText(items);

  const t1 = log.time('audio.script');
  let script = '';
  try {
    const res = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      messages: buildScriptPrompt(listText),
      response_format: { type: 'text' }
    });
    script = (res.choices?.[0]?.message?.content || '').trim();
    t1.end({ ok: true, len: script.length });
  } catch (e) {
    t1.end({ ok: false, err: e?.message });
    log.warn('audio.script.fail', { err: e?.message });
    return { script: null, audioPath: null };
  }

  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';
  const voice = process.env.OPENAI_TTS_VOICE || 'alloy';
  const filename = `news_${userId}_${Date.now()}.mp3`;
  const audioPath = path.join(outDir, filename);

  const t2 = log.time('audio.tts', { model, voice });
  try {
    const speech = await openai.audio.speech.create({
      model,
      voice,
      input: script,
      format: 'mp3'
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(audioPath, buffer);
    t2.end({ ok: true, bytes: buffer.length, path: audioPath });
    return { script, audioPath };
  } catch (e) {
    t2.end({ ok: false, err: e?.message });
    log.warn('audio.tts.fail', { err: e?.message });
    return { script, audioPath: null };
  }
}
