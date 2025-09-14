
import fs from 'fs';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const levelName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVEL = LEVELS[levelName] ?? LEVELS.info;
const FORMAT = (process.env.LOG_FORMAT || 'json').toLowerCase(); // json|pretty
const LOG_FILE = process.env.LOG_FILE;

function ts() { return new Date().toISOString(); }
function fmtLine(obj) {
  if (FORMAT === 'pretty') {
    const { level, event, ...rest } = obj;
    return `[${obj.ts}] ${level.toUpperCase()} ${event || ''} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`;
  }
  return JSON.stringify(obj);
}
function write(obj) {
  const line = fmtLine(obj);
  if (obj.level === 'error') console.error(line); else console.log(line);
  if (LOG_FILE) { try { fs.appendFile(LOG_FILE, line + '\n', ()=>{}); } catch {} }
}
function sanitize(ctx={}) {
  const out = {};
  for (const [k,v] of Object.entries(ctx)) {
    if (typeof v === 'string' && v.length > 400) out[k] = v.slice(0,400) + '…';
    else out[k] = v;
  }
  return out;
}
function baseLogger(bind={}) {
  const b = sanitize(bind);
  const log = (lvl, event, ctx) => {
    if (LEVELS[lvl] <= LEVEL) write({ ts: ts(), level: lvl, event, ...b, ...(ctx ? sanitize(ctx) : {}) });
  };
  return {
    child(extra={}) { return baseLogger({ ...b, ...sanitize(extra) }); },
    error(event, ctx) { log('error', event, ctx); },
    warn(event, ctx)  { log('warn',  event, ctx); },
    info(event, ctx)  { log('info',  event, ctx); },
    debug(event, ctx) { log('debug', event, ctx); },
    time(event, ctx) {
      const start = Date.now();
      log('debug', event + '.start', ctx);
      return { end(extra) { log('debug', event + '.end', { ms: Date.now()-start, ...(extra||{}) }); } };
    }
  };
}
export const logger = baseLogger({ app: 'newslens' });
