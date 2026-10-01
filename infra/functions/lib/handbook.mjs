/**
 * The team handbook: what HeatShield is and how it works, for questions about HeatShield itself
 * ("what do you store about me?", "who are the agents?"). Kept short and true; every statement here is
 * also in the README, so an answer built from it can be checked against the repository.
 */
import { createBm25Index } from './algorithms/bm25.mjs';

export const HANDBOOK = [
  { id: 'what', text: 'HeatShield is a free heat early-warning service. It turns the live forecast into the US National Weather Service heat index and risk tier, hour by hour, and into a short action plan for your body, your job and your language, before the hottest hours arrive.', tags: 'what is heatshield purpose about service free' },
  { id: 'profiles', text: 'Older adults, pregnant people, young children and people with chronic conditions are warned from the Caution tier, one tier earlier than outdoor workers and the general public, who are warned from Extreme Caution.', tags: 'profile threshold older elderly pregnant child chronic worker warned tier caution' },
  { id: 'languages', text: 'Plans are written in 13 languages: English, Spanish, French, Portuguese, Arabic, Urdu, Hindi, Bengali, Chinese, Vietnamese, Indonesian, Tagalog and Swahili. Plans can be read aloud (Amazon Polly) in English, Spanish, French, Portuguese, Arabic, Hindi and Chinese.', tags: 'language languages translate listen audio read aloud polly voice' },
  { id: 'alerts', text: 'You can register a place and a profile for email alerts. HeatShield re-checks everyone every hour and emails you when your risk reaches your level: at most one alert per level per day, and never between 21:00 and 06:00 your time. SMS is not offered.', tags: 'alert alerts email warning notify register sign up sms text' },
  { id: 'groups', text: 'A foreman, teacher or clinic worker can create a group and share one invite link. The leader sees everyone\'s live risk on a private dashboard, worst first, and Kai plans who to check on first and, for outdoor workers, the safest shift.', tags: 'group leader dashboard crew team invite community check on' },
  { id: 'privacy', text: 'Coordinates are rounded to about 1 km. Email addresses are never stored in HeatShield\'s database; they live only in the Amazon SNS subscription. One click on your personal page deletes your registration, alert history and subscription. What you type into Ask the team is not stored.', tags: 'privacy data store stored delete email location personal information gdpr' },
  { id: 'agents', text: 'Eight AI agents run HeatShield: Sol watches for heatwaves, Quinn audits the forecast, Mira writes plans, Lexi checks their language, Vera checks their safety, Kai coordinates check-ins and questions, Iris teaches the team from its corrections, and Otto keeps the site up. An algorithm does the exact part of each job, a model the judgment, and code makes the final call.', tags: 'agents team who sol quinn mira lexi vera kai iris otto ai' },
  { id: 'models', text: 'The models run on Amazon Bedrock: Amazon Nova 2 Lite writes plans and runs Sol, Quinn, Kai and Otto; Amazon Nova Pro reviews plans and gives Iris its second opinion; and Kimi K2.5 coordinates the answers in Ask the team, with Nova Pro as its fallback.', tags: 'model models llm bedrock nova kimi claude ai which' },
  { id: 'science', text: 'The heat index uses the NWS Rothfusz regression. Sol compares the coming days with each place\'s own 1991-2020 climate (the Excess Heat Factor) and reads 51 ensemble forecasts from ECMWF for the chance of Danger. Quinn scores the last 14 days of forecasts.', tags: 'science heat index formula how calculated ensemble climate accuracy forecast data source' },
  { id: 'data', text: 'Weather data comes from Open-Meteo: the forecast, 51-member ECMWF ensembles, previous forecast runs and ERA5 climate history.', tags: 'data source weather open-meteo forecast where from' },
  { id: 'aws', text: 'HeatShield is serverless on AWS: CloudFront and S3 for the site, API Gateway and Lambda for the API and agents, DynamoDB for data, EventBridge Scheduler for the schedules, SNS for email, Polly for audio, Cognito for the operator console, and CloudWatch alarms that email the operator.', tags: 'aws architecture serverless lambda how built cloud infrastructure' },
  { id: 'limits', text: 'The heat index is a shade value: direct sun can make it feel up to about 8 degrees C hotter. HeatShield gives safety information, not medical care. Pre-written fallback advice exists in English, Spanish and French.', tags: 'limitations shade sun medical accuracy fallback' },
  { id: 'cost', text: 'HeatShield is free to use. A new plan costs the project less than one US cent in AI, and a daily budget stops new AI work if it is ever reached; alerts never stop.', tags: 'cost free price pay money budget' },
];

const index = createBm25Index(HANDBOOK, { field: (h) => `${h.text} ${h.tags}` });

/** The handbook entries most relevant to a topic (always at least the overview). */
export function handbookFor(topic, k = 3) {
  const hits = index.search(String(topic ?? ''), k).filter((r) => r.score > 0).map((r) => r.doc);
  return (hits.length ? hits : [HANDBOOK[0]]).map(({ id, text }) => ({ id, text }));
}
