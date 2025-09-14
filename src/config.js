
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function loadSources(p='sources.yaml') {
  const resolved = path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
  const raw = fs.readFileSync(resolved, 'utf8');
  const data = yaml.load(raw) || {};
  logger.debug('config.sources.loaded', { count: (data.feeds||[]).length, path: resolved });
  return (data.feeds || []).map(f => ({...f, weight: Number(f.weight ?? 0.8)}));
}
