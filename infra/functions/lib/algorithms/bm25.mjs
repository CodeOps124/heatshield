/**
 * Okapi BM25 ranking (Robertson & Zaragoza, "The Probabilistic Relevance Framework: BM25 and
 * Beyond", 2009). Used by the Health Advisor to retrieve only the vetted facts relevant to one
 * person's situation, instead of pasting the whole library into every prompt.
 *
 *   score(D,Q) = Σ_q IDF(q) · f(q,D)·(k1+1) / ( f(q,D) + k1·(1 − b + b·|D|/avgdl) )
 *   IDF(q)     = ln( (N − n(q) + 0.5)/(n(q) + 0.5) + 1 )
 */

const STOP = new Set('a an and are as at be by for from has have if in is it its of on or that the this to was were will with your you who when than then them they their not no do does can may'.split(' '));

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ing|ies|es|s)$/u, (m) => (m === 'ies' ? 'y' : '')));
}

export function createBm25Index(docs, { k1 = 1.2, b = 0.75, field = (d) => d.text } = {}) {
  const toks = docs.map((d) => tokenize(field(d)));
  const avgdl = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length);
  const df = new Map();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const idf = (term) => {
    const n = df.get(term) ?? 0;
    return Math.log((N - n + 0.5) / (n + 0.5) + 1);
  };

  return {
    search(query, k = 5) {
      const q = tokenize(query);
      const scored = docs.map((doc, i) => {
        const tf = new Map();
        for (const term of toks[i]) tf.set(term, (tf.get(term) ?? 0) + 1);
        let score = 0;
        for (const term of q) {
          const f = tf.get(term) ?? 0;
          if (!f) continue;
          score += idf(term) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avgdl)));
        }
        return { doc, score };
      });
      return scored.filter((s) => s.score > 0).sort((a, z) => z.score - a.score).slice(0, k);
    },
  };
}
