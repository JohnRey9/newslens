
# NewsLens Service

Модули: Aggregator → Evaluator → LLM Enricher → Recommender → Posts → Tg-bot.
Фичи: LLM-признаки, лайки/дизлайки, промпт интересов

## Логи
- Формат: JSON (по умолчанию) или human-readable (`LOG_FORMAT=pretty`)
- Уровень: `LOG_LEVEL=error|warn|info|debug` (по умолчанию `info`)
- Файл: укажи `LOG_FILE=/path/to/file` чтобы писать ещё и в файл
- События:
  - `ingest.cycle.*` и `feed.*` — сбор RSS по источникам
  - `eval.*` — расчёт метрик I/H/P/N/Q
  - `llm.*` — обогащение признаками LLM (start/ok/error)
  - `sched.*` — запуск/завершение cron-джоб
  - `bot.*` и `cmd.*` — старт бота и команды пользователей

## Запуск
```bash
npm i
cp .env.example .env
npm run migrate
npm run ingest
npm run eval
npm start
```
Потом в Telegram: `/start`, `/feed`, `/prompt ...`, жми 👍/👎.

Смотри логи в stdout (или в файле, если включил `LOG_FILE`).
