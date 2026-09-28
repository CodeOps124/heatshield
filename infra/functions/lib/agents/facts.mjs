/**
 * The Health Advisor's vetted fact library. The model may only give advice consistent with these.
 * Each fact was read from its source on 2026-09-28 (see docs/BUILD_LOG.md). `tags` are the
 * keywords BM25 matches against; `pinned` facts are always included (life-safety).
 */
export const FACTS = [
  {
    id: 'shade-sun',
    text: 'Heat index values assume shade. In direct sun it can feel up to about 8 °C (15 °F) hotter.',
    source: 'US National Weather Service',
    tags: 'sun outdoor work shade exposure midday worker',
  },
  {
    id: 'worker-water',
    text: 'For moderate work in the heat: about one cup (240 ml) of water every 15 to 20 minutes.',
    source: 'CDC/NIOSH',
    tags: 'worker outdoor work water drink hydration labour construction farm delivery',
  },
  {
    id: 'worker-max-water',
    text: 'Do not drink more than about 1.5 litres (6 cups) of fluid per hour.',
    source: 'CDC/NIOSH',
    tags: 'worker water drink hydration limit',
  },
  {
    id: 'electrolytes',
    text: 'If sweating for several hours, drinks with electrolytes help.',
    source: 'CDC/NIOSH',
    tags: 'worker sweat hours electrolyte drink long shift',
  },
  {
    id: 'rest-breaks',
    text: 'Take rest breaks in shade whenever feeling heat discomfort; as heat, humidity and sun increase, work shorter periods and rest longer.',
    source: 'CDC/NIOSH',
    tags: 'worker rest break shade work schedule danger extreme',
  },
  {
    id: 'acclimatize',
    text: 'People new to working in heat, or returning after time away, need to build up gradually over about two weeks.',
    source: 'CDC/NIOSH',
    tags: 'worker new returning acclimatization first days',
  },
  {
    id: 'buddy',
    text: 'Use a buddy system so people watch each other for signs of heat illness.',
    source: 'CDC/NIOSH',
    tags: 'worker crew team buddy watch group',
  },
  {
    id: 'check-twice',
    text: 'Older adults should be checked on at least twice a day during heat.',
    source: 'CDC',
    tags: 'elderly older adult alone check visit caregiver family neighbour',
  },
  {
    id: 'check-others',
    text: 'Check on family, friends and neighbours, especially people who live alone or have chronic medical problems.',
    source: 'CDC',
    tags: 'elderly alone chronic condition neighbour family community check',
  },
  {
    id: 'fan',
    text: 'A fan should not be the main way to cool down when it is very hot.',
    source: 'CDC',
    tags: 'elderly home fan cooling indoor chronic night',
  },
  {
    id: 'cool-shower',
    text: 'Cool showers or baths help lower body temperature.',
    source: 'CDC',
    tags: 'elderly home cool shower bath night child pregnant chronic',
  },
  {
    id: 'air-con',
    text: 'Use air conditioning, or spend the hottest hours in a place that has it, such as a cooling centre.',
    source: 'CDC',
    tags: 'home indoor air conditioning cooling centre elderly chronic pregnant child hottest hours',
  },
  {
    id: 'shade',
    text: 'Stay in the shade as much as possible.',
    source: 'CDC',
    tags: 'outdoor shade sun child general worker',
  },
  {
    id: 'cool-hours',
    text: 'Do outdoor activities during the coolest parts of the day, such as early morning or evening.',
    source: 'CDC',
    tags: 'outdoor activity morning evening schedule general child pregnant exercise',
  },
  {
    id: 'water-bottle',
    text: 'Carry a water bottle and keep drinking and refilling it through the day; light-yellow or clear urine usually means enough water.',
    source: 'CDC',
    tags: 'water drink hydration bottle general pregnant child elderly chronic',
  },
  {
    id: 'risk-groups',
    text: 'Pregnancy, infants and young children, asthma, heart and other chronic conditions, and age over 65 raise heat risk.',
    source: 'CDC',
    tags: 'pregnant child infant asthma heart chronic elderly risk',
  },
  {
    id: 'medicines',
    text: 'Some medicines can make it harder for the body to handle heat; a doctor or pharmacist can say whether yours do.',
    source: 'CDC (heat and medications)',
    tags: 'chronic condition medicine medication heart diabetes kidney',
  },
  {
    id: 'parked-car',
    text: 'Never leave a child, or anyone, in a parked vehicle.',
    source: 'widely published child-safety guidance',
    tags: 'child infant car vehicle parked baby',
  },
  {
    id: 'tropical-night',
    text: 'When nights stay above 20 °C the body gets little relief overnight, so keep the sleeping area as cool as possible.',
    source: 'WMO/ETCCDI tropical-night index',
    tags: 'night warm sleep evening tropical elderly chronic child',
  },
  {
    id: 'heat-exhaustion',
    text: 'Heat exhaustion signs: headache, nausea, dizziness, weakness, heavy sweating, thirst. Stop, move somewhere cooler, sip cool water, and get medical care if it does not improve.',
    source: 'CDC/NIOSH',
    tags: 'symptom exhaustion headache nausea dizziness',
    pinned: true,
  },
  {
    id: 'heat-stroke',
    text: 'Heat stroke is an emergency: confusion, slurred speech, fainting, seizures, very high body temperature, hot skin. Call the local emergency number, move the person somewhere cool, and cool them with water and cold cloths while waiting.',
    source: 'CDC/NIOSH',
    tags: 'emergency stroke confusion fainting call',
    pinned: true,
  },
];

export const FACTS_BY_ID = new Map(FACTS.map((f) => [f.id, f]));
