/**
 * Language identification for the Language Reviewer.
 *
 * A Unicode-script check cannot tell Spanish from Portuguese or Swahili from Indonesian, so we add
 * a multinomial naive Bayes classifier whose features are the most frequent FUNCTION words of each
 * language (the classic stop-word profile approach to language ID). Emission probabilities follow a
 * Zipf distribution over each list's frequency rank; unseen tokens get a small smoothing mass.
 * Non-Latin scripts are decided by script, and Arabic vs Urdu by letters unique to each.
 *
 *   log P(lang | tokens) ∝ Σ_t log P(t | lang)      (uniform prior over candidate languages)
 */

// Most frequent function words, ordered roughly by frequency (rank matters: Zipf weighting).
const PROFILES = {
  en: 'the and to of a in you is your for it that be on with are or if as at this do not have from can',
  es: 'de la que el en y a los se las del un por con no una su para es al lo como más o si le tu te muy cuando',
  pt: 'de a o que e do da em um para é com não uma os no se na por mais as dos como mas ao das à seu sua ou você quando',
  fr: 'de la le et les des en un du une que est pour qui dans à par plus pas au sur ne se ce il vous avec votre ou si',
  id: 'yang dan di ini itu untuk dengan tidak dari dalam akan pada juga ke karena ada atau anda jika saat lebih bisa',
  tl: 'ang ng sa na mga at ay hindi ko mo ka kung para may kayo po ito nang lang din rin ninyo inyong niyo',
  sw: 'na ya wa kwa ni la za katika kama cha vya hii au pia sana kuwa yako wako lakini bila hadi baada kila',
  vi: 'và của là các có không những một được cho trong với người để này khi bạn nếu đã sẽ từ hãy nên hoặc',
};

const ZIPF = 1.0;
const STOPWORD_MASS = 0.4; // share of probability a language's text puts on its function words
const UNSEEN = 1e-6;

const MODELS = Object.fromEntries(
  Object.entries(PROFILES).map(([lang, words]) => {
    const list = words.split(' ');
    const h = list.reduce((s, _w, r) => s + 1 / (r + 1) ** ZIPF, 0);
    return [lang, new Map(list.map((w, r) => [w, (STOPWORD_MASS * (1 / (r + 1) ** ZIPF)) / h]))];
  }),
);

const SCRIPTS = [
  ['hi', /\p{Script=Devanagari}/gu],
  ['bn', /\p{Script=Bengali}/gu],
  ['zh', /\p{Script=Han}/gu],
  ['arabic-script', /\p{Script=Arabic}/gu],
];
// Letters used in Urdu but not in standard Arabic, and vice versa.
const URDU_ONLY = /[ٹڈڑںھہے]/gu; // ٹ ڈ ڑ ں ھ ہ ے
const ARABIC_ONLY = /[ةيك]/gu; // ة ي ك

const count = (text, re) => (text.match(re) ?? []).length;

export function identifyLanguage(text) {
  const letters = count(text, /\p{L}/gu) || 1;
  for (const [lang, re] of SCRIPTS) {
    const share = count(text, re) / letters;
    if (share > 0.3) {
      if (lang !== 'arabic-script') return { lang, confidence: Math.min(1, share), method: 'script' };
      const urdu = count(text, URDU_ONLY);
      const arabic = count(text, ARABIC_ONLY);
      if (urdu === arabic) return { lang: 'ar|ur', confidence: 0.5, method: 'script' };
      return { lang: urdu > arabic ? 'ur' : 'ar', confidence: Math.max(urdu, arabic) / (urdu + arabic), method: 'script+letters' };
    }
  }

  const tokens = text.toLowerCase().normalize('NFC').split(/[^\p{L}]+/u).filter(Boolean);
  if (tokens.length === 0) return { lang: 'unknown', confidence: 0, method: 'none' };
  const scores = Object.entries(MODELS).map(([lang, model]) => [
    lang,
    tokens.reduce((s, t) => s + Math.log(model.get(t) ?? UNSEEN), 0),
  ]);
  scores.sort((a, b) => b[1] - a[1]);
  // Softmax over log-likelihoods, normalised per token so long texts don't saturate to 1.0.
  const top = scores[0][1];
  const expd = scores.map(([l, s]) => [l, Math.exp((s - top) / tokens.length)]);
  const z = expd.reduce((s, [, e]) => s + e, 0);
  return {
    lang: scores[0][0],
    confidence: Math.round((expd[0][1] / z) * 100) / 100,
    method: 'naive-bayes',
    runnerUp: scores[1][0],
  };
}

/** Does `text` look like it is written in `expected`? (Only fails when the evidence is clear.) */
export function languageMatches(text, expected) {
  const id = identifyLanguage(text);
  if (id.lang === 'unknown') return { ok: true, id };
  if (id.lang === 'ar|ur') return { ok: expected === 'ar' || expected === 'ur', id };
  if (id.lang === expected) return { ok: true, id };
  // Only call it a mismatch when the classifier is reasonably sure.
  return { ok: id.method === 'naive-bayes' ? id.confidence < 0.35 : false, id };
}
