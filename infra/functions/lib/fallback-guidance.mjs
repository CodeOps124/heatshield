/**
 * Static, pre-written guidance used when Bedrock is unreachable, throttled, or returns
 * something that fails validation. The app must never show an at-risk person nothing.
 *
 * Content is paraphrased from CDC / NIOSH heat guidance (see guidance.mjs for sources).
 * Hand-written in English, Spanish and French only — other languages fall back to English
 * with `languageFallback: true` so the UI can say so honestly instead of showing a bad
 * machine translation.
 */

const TEXT = {
  en: {
    headline: {
      lower: 'Heat risk is low right now.',
      caution: 'The heat can wear you down today. Pace yourself.',
      extreme_caution: 'Heat illness is possible today. Plan around the hottest hours.',
      danger: 'Dangerous heat today. Limit your time in the heat.',
      extreme_danger: 'Extreme, life-threatening heat. Stay somewhere cool and check on others.',
    },
    general: [
      'Drink water regularly through the day, even before you feel thirsty.',
      'Stay in shade or indoors somewhere cool during the hottest hours.',
    ],
    profile: {
      outdoor_worker: 'Rest in the shade often and drink about one cup (240 ml) of water every 15–20 minutes while working.',
      elderly: 'Spend the hottest hours somewhere cool, and ask someone to check on you at least twice today.',
      chronic_condition: 'Stay somewhere cool in the hottest hours, and ask a pharmacist whether your medicines change how you handle heat.',
      child: 'Keep children in the shade, offer water often, and never leave a child in a parked car.',
      pregnant: 'Rest somewhere cool during the hottest hours and sip water throughout the day.',
      general: 'Move outdoor activity to early morning or evening, and wear light, loose clothing.',
    },
    seekHelp: 'Confusion, fainting, or very hot skin are signs of heat stroke: call your local emergency number and cool the person down right away.',
  },
  es: {
    headline: {
      lower: 'El riesgo por calor es bajo en este momento.',
      caution: 'El calor puede agotarte hoy. Ve con calma.',
      extreme_caution: 'Hoy es posible sufrir enfermedades por calor. Organiza tu día evitando las horas más calurosas.',
      danger: 'Calor peligroso hoy. Limita el tiempo que pasas al calor.',
      extreme_danger: 'Calor extremo, con riesgo para la vida. Quédate en un lugar fresco y pregunta cómo están los demás.',
    },
    general: [
      'Bebe agua con regularidad durante el día, incluso antes de tener sed.',
      'Quédate a la sombra o en un lugar fresco bajo techo durante las horas de más calor.',
    ],
    profile: {
      outdoor_worker: 'Descansa a la sombra con frecuencia y bebe una taza de agua (240 ml) cada 15–20 minutos mientras trabajas.',
      elderly: 'Pasa las horas de más calor en un lugar fresco y pide a alguien que te visite al menos dos veces hoy.',
      chronic_condition: 'Quédate en un lugar fresco en las horas de más calor y pregunta en la farmacia si tus medicamentos afectan cómo toleras el calor.',
      child: 'Mantén a los niños a la sombra, ofréceles agua a menudo y nunca dejes a un niño dentro de un coche estacionado.',
      pregnant: 'Descansa en un lugar fresco durante las horas de más calor y bebe agua a sorbos a lo largo del día.',
      general: 'Deja la actividad al aire libre para primera hora de la mañana o la tarde-noche y usa ropa ligera y holgada.',
    },
    seekHelp: 'La confusión, el desmayo o la piel muy caliente son señales de golpe de calor: llama al número de emergencias local y enfría a la persona de inmediato.',
  },
  fr: {
    headline: {
      lower: 'Le risque lié à la chaleur est faible pour le moment.',
      caution: 'La chaleur peut vous épuiser aujourd’hui. Ménagez-vous.',
      extreme_caution: 'Un coup de chaleur est possible aujourd’hui. Organisez-vous pour éviter les heures les plus chaudes.',
      danger: 'Chaleur dangereuse aujourd’hui. Limitez votre temps exposé à la chaleur.',
      extreme_danger: 'Chaleur extrême, danger de mort. Restez au frais et prenez des nouvelles de vos proches.',
    },
    general: [
      'Buvez de l’eau régulièrement tout au long de la journée, même sans avoir soif.',
      'Restez à l’ombre ou dans un endroit frais pendant les heures les plus chaudes.',
    ],
    profile: {
      outdoor_worker: 'Faites souvent des pauses à l’ombre et buvez environ un verre d’eau (240 ml) toutes les 15 à 20 minutes pendant le travail.',
      elderly: 'Passez les heures les plus chaudes dans un endroit frais et demandez à quelqu’un de passer vous voir au moins deux fois aujourd’hui.',
      chronic_condition: 'Restez au frais pendant les heures les plus chaudes et demandez à votre pharmacien si vos médicaments modifient votre tolérance à la chaleur.',
      child: 'Gardez les enfants à l’ombre, proposez-leur souvent de l’eau et ne laissez jamais un enfant seul dans une voiture garée.',
      pregnant: 'Reposez-vous dans un endroit frais pendant les heures les plus chaudes et buvez de l’eau par petites gorgées toute la journée.',
      general: 'Prévoyez vos activités extérieures tôt le matin ou le soir, et portez des vêtements légers et amples.',
    },
    seekHelp: 'Confusion, malaise ou peau très chaude sont des signes de coup de chaleur : appelez le numéro d’urgence local et refroidissez la personne immédiatement.',
  },
};

export const FALLBACK_LANGUAGES = Object.freeze(Object.keys(TEXT));

export function fallbackGuidance({ tier, profileId, language }) {
  const languageFallback = !Object.hasOwn(TEXT, language);
  const t = TEXT[languageFallback ? 'en' : language];
  const profileLine = t.profile[profileId] ?? t.profile.general;
  return {
    headline: t.headline[tier] ?? t.headline.caution,
    actions: [profileLine, ...t.general],
    seekHelp: t.seekHelp,
    language: languageFallback ? 'en' : language,
    languageFallback,
  };
}
