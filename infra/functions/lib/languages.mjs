/**
 * Supported guidance languages. The model receives the English language NAME (not a locale
 * code) — more reliable, per the bedrock-multilingual-guidance skill.
 *
 * `script` is a Unicode script regex used to sanity-check that the model actually answered in
 * the requested language (a cheap guard against silently getting English back). Latin-script
 * languages cannot be told apart this way, so they have no check.
 */
export const LANGUAGES = Object.freeze({
  en: { name: 'English', native: 'English', dir: 'ltr' },
  es: { name: 'Spanish', native: 'Español', dir: 'ltr' },
  fr: { name: 'French', native: 'Français', dir: 'ltr' },
  pt: { name: 'Portuguese', native: 'Português', dir: 'ltr' },
  ar: { name: 'Arabic', native: 'العربية', dir: 'rtl', script: /\p{Script=Arabic}/u },
  ur: { name: 'Urdu', native: 'اردو', dir: 'rtl', script: /\p{Script=Arabic}/u },
  hi: { name: 'Hindi', native: 'हिन्दी', dir: 'ltr', script: /\p{Script=Devanagari}/u },
  bn: { name: 'Bengali', native: 'বাংলা', dir: 'ltr', script: /\p{Script=Bengali}/u },
  zh: { name: 'Simplified Chinese', native: '简体中文', dir: 'ltr', script: /\p{Script=Han}/u },
  vi: { name: 'Vietnamese', native: 'Tiếng Việt', dir: 'ltr' },
  id: { name: 'Indonesian', native: 'Bahasa Indonesia', dir: 'ltr' },
  tl: { name: 'Tagalog (Filipino)', native: 'Tagalog', dir: 'ltr' },
  sw: { name: 'Swahili', native: 'Kiswahili', dir: 'ltr' },
});

export const isLanguage = (code) => Object.hasOwn(LANGUAGES, code);

/** True when every field of the guidance is plausibly written in the requested script. */
export function matchesScript(guidance, code) {
  const re = LANGUAGES[code]?.script;
  if (!re) return true;
  const parts = [guidance.headline, ...guidance.actions, guidance.seekHelp];
  return parts.every((p) => re.test(p));
}
