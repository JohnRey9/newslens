
export function clamp01(x) { return Math.max(0, Math.min(1, x)); }
export function to100(x) { return Math.round(clamp01(x) * 100); }
export function nowSec() { return Math.floor(Date.now() / 1000); }

export function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-zа-яё0-9]+/gi)?.map(s=>s.trim()).filter(Boolean) || [];
}
export function shingles(tokens, k=2) {
  const res = new Set();
  for (let i=0; i<=Math.max(0, tokens.length-k); i++) {
    res.add(tokens.slice(i, i+k).join(' '));
  }
  return res;
}
export function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const v of aSet) if (bSet.has(v)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter/union : 0;
}
export function jaccardShingles(aText, bText, k=3) {
  const a = shingles(tokenize(aText), k);
  const b = shingles(tokenize(bText), k);
  return jaccard(a, b);
}
export function ruCharShare(text='') {
  const m = (text.match(/[А-Яа-яЁё]/g)||[]).length;
  const total = (text.match(/[A-Za-zА-Яа-яЁё0-9]/g)||[]).length || 1;
  return m/total;
}
