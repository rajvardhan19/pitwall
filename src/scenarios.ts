// Circuits, the 2026 calendar, curated late-race scenarios, and full-race / season setups.
// Pure data plus the functions that turn a player's choice into the RaceConfig the simulation runs on.
import type { Compound } from './sim.ts';
import { ROSTER, teamOf } from './roster.ts';
export { ROSTER, TEAMS } from './roster.ts';

export type RaceMode = 'scenario' | 'full' | 'season';
export type Distance = 'sprint' | 'half' | 'full';
export interface RaceSetup {
  scenario: string; mode: RaceMode; distance: Distance; seed: number;
  /** Full races and season rounds: the circuit. Scenarios carry their own circuit. */
  circuit?: string;
  /** Season rounds: the round number, 1-based. */
  round?: number;
  /** Season rounds: the strategist's championship briefing, spoken at lights out. */
  brief?: string;
  /** Full races and season rounds: the compound each of our cars starts on. */
  start?: { 1: Compound; 2: Compound };
}
export type Objective = { kind: 'position'; max: number } | { kind: 'beat'; rival: number };
export interface SafetyWindow { start: number; ending: number; end: number }
export interface WeatherPoint { at: number; wet: number }

/** Everything the simulation needs about this race. Plain data: cloned into workers and replays. */
export interface RaceConfig {
  setup: RaceSetup;
  circuit: string;
  totalLaps: number;
  startLap: number;
  /** Representative lap time, used to turn distance gaps into seconds. */
  lapTime: number;
  basePace: number;
  pitLoss: number;
  /** How much quicker per lap a car must be to get past on track. */
  overtake: number;
  /** Tyre degradation multiplier: higher wears tyres faster. */
  wear: number;
  /** Seconds lost on the first lap of a new set while it warms up (cold tracks). */
  warmup: number;
  safety: SafetyWindow[];
  weather: WeatherPoint[] | null;
  objectives: Record<1 | 2, Objective>;
}

export interface Circuit {
  id: string; name: string; city: string; country: string; km: number; turns: number; laps: number;
  lapTime: number; pitLoss: number; overtake: number; wear: number;
  trackTemp: number; airTemp: number;
  safetyChance: number;
  rainChance: number;
  warmup?: number;
  /** Hand-drawn schematic outline; circuits without one get a generated outline. */
  path?: string;
}

// Real circuit facts (length, corners, race laps); strategy figures (pit loss, overtaking, wear,
// safety-car and rain chances) are game tuning, not measured data.
const C = (id: string, name: string, city: string, country: string, km: number, turns: number, laps: number, lapTime: number,
  pitLoss: number, overtake: number, wear: number, trackTemp: number, airTemp: number, safetyChance: number, rainChance: number,
  extra: Partial<Circuit> = {}): Circuit =>
  ({ id, name, city, country, km, turns, laps, lapTime, pitLoss, overtake, wear, trackTemp, airTemp, safetyChance, rainChance, ...extra });

export const CIRCUITS: Record<string, Circuit> = Object.fromEntries([
  C('melbourne', 'Albert Park Circuit', 'Melbourne', 'Australia', 5.278, 14, 58, 81, 19, 0.6, 0.9, 32, 22, 0.6, 0.1),
  C('shanghai', 'Shanghai International Circuit', 'Shanghai', 'China', 5.451, 16, 56, 96, 22, 0.5, 1.1, 30, 20, 0.35, 0.15),
  C('suzuka', 'Suzuka Circuit', 'Suzuka', 'Japan', 5.807, 18, 53, 92, 22, 0.8, 1.2, 28, 20, 0.35, 0.2),
  C('miami', 'Miami International Autodrome', 'Miami', 'United States', 5.412, 19, 57, 91, 20, 0.6, 1, 48, 30, 0.5, 0.15),
  C('montreal', 'Circuit Gilles Villeneuve', 'Montreal', 'Canada', 4.361, 14, 70, 75, 18, 0.5, 0.9, 34, 21, 0.6, 0.2),
  C('monaco', 'Circuit de Monaco', 'Monaco', 'Monaco', 3.337, 19, 78, 74.5, 19, 1.8, 0.65, 46, 23, 0.75, 0, {
    path: 'M 90 200 L 230 200 Q 250 200 258 186 L 270 160 Q 276 148 290 148 L 330 150 Q 346 150 350 136 L 356 106 Q 360 90 378 92 L 410 98 Q 428 102 424 82 Q 420 64 402 66 L 360 70 Q 344 72 338 58 Q 332 44 316 46 L 240 56 Q 226 58 222 72 L 218 96 Q 214 112 198 112 L 150 110 Q 132 110 126 124 L 108 160 Q 100 176 88 180 Q 70 188 90 200 Z' }),
  C('barcelona', 'Circuit de Barcelona', 'Barcelona', 'Spain', 4.657, 14, 66, 86, 21, 0.65, 1, 38, 24, 0.45, 0, {
    path: 'M 88 162 L 195 79 Q 220 59 244 67 L 305 90 Q 320 95 328 78 L 347 41 Q 355 29 369 39 L 407 74 Q 422 88 408 104 L 382 134 Q 367 152 387 164 L 432 193 Q 448 205 431 218 L 390 248 Q 377 257 366 244 L 338 210 Q 331 200 317 208 L 289 225 Q 273 236 260 223 L 224 188 Q 215 179 203 192 L 167 232 Q 151 250 137 236 L 86 190 Q 72 177 88 162 Z' }),
  C('spielberg', 'Spielberg Ring', 'Spielberg', 'Austria', 4.318, 10, 71, 68, 20, 0.45, 1, 40, 26, 0.3, 0.2),
  C('silverstone', 'Silverstone Circuit', 'Silverstone', 'Great Britain', 5.891, 18, 52, 89, 21, 0.6, 1.1, 24, 17, 0.5, 0.55, {
    path: 'M 100 150 L 150 92 Q 160 80 176 84 L 230 100 Q 246 104 256 90 L 284 52 Q 296 36 314 44 L 380 76 Q 398 84 404 102 L 420 160 Q 426 180 410 192 L 360 228 Q 344 240 326 230 L 280 206 Q 266 198 254 208 L 214 240 Q 198 252 182 240 L 116 190 Q 98 176 100 150 Z' }),
  C('spa', 'Circuit de Spa-Francorchamps', 'Spa', 'Belgium', 7.004, 19, 44, 107, 20, 0.4, 0.95, 22, 16, 0.45, 0.5),
  C('hungaroring', 'Hungaroring', 'Budapest', 'Hungary', 4.381, 14, 70, 80, 20, 1.2, 1.05, 50, 31, 0.3, 0.1),
  C('zandvoort', 'Circuit Zandvoort', 'Zandvoort', 'Netherlands', 4.259, 14, 72, 73, 21, 1.3, 0.95, 30, 20, 0.45, 0.25),
  C('monza', 'Autodromo di Monza', 'Monza', 'Italy', 5.793, 11, 53, 81.5, 24, 0.35, 0.8, 41, 27, 0.35, 0, {
    path: 'M 120 230 L 400 230 Q 430 230 432 210 L 428 196 Q 424 186 434 180 L 450 160 Q 462 140 452 118 L 430 80 Q 420 62 400 60 L 330 56 Q 312 55 306 66 L 300 74 Q 294 82 282 78 L 240 60 Q 224 52 210 62 L 170 92 Q 150 108 150 128 L 152 160 Q 154 176 140 180 L 100 188 Q 80 194 86 214 Q 92 230 120 230 Z' }),
  C('madrid', 'Madring', 'Madrid', 'Spain', 5.474, 22, 57, 91, 21, 0.8, 1, 35, 24, 0.5, 0.05),
  C('baku', 'Baku City Circuit', 'Baku', 'Azerbaijan', 6.003, 20, 51, 105, 20, 0.4, 0.8, 36, 23, 0.7, 0.05),
  C('sepang', 'Sepang International Circuit', 'Sepang', 'Malaysia', 5.543, 15, 56, 97, 22, 0.55, 1.35, 52, 33, 0.35, 0.45),
  C('singapore', 'Marina Bay Street Circuit', 'Singapore', 'Singapore', 4.94, 19, 62, 96, 26, 1.5, 0.9, 34, 30, 0.8, 0.25),
  C('austin', 'Circuit of the Americas', 'Austin', 'United States', 5.513, 20, 56, 97, 21, 0.6, 1.15, 38, 26, 0.35, 0.1),
  C('mexico', 'Autódromo Hermanos Rodríguez', 'Mexico City', 'Mexico', 4.304, 17, 71, 80, 22, 0.7, 0.85, 42, 22, 0.4, 0.1),
  C('interlagos', 'Interlagos', 'São Paulo', 'Brazil', 4.309, 15, 71, 72, 21, 0.5, 1, 40, 24, 0.5, 0.45),
  C('lasvegas', 'Las Vegas Strip Circuit', 'Las Vegas', 'United States', 6.201, 17, 50, 95, 20, 0.4, 0.75, 15, 12, 0.5, 0, { warmup: 3 }),
  C('lusail', 'Lusail International Circuit', 'Lusail', 'Qatar', 5.419, 16, 57, 84, 25, 0.7, 1.3, 30, 26, 0.3, 0),
  C('yasmarina', 'Yas Marina Circuit', 'Abu Dhabi', 'Abu Dhabi', 5.281, 16, 58, 85, 22, 0.7, 0.9, 30, 26, 0.4, 0, {
    path: 'M 80 230 L 300 230 Q 320 230 326 214 L 334 190 Q 340 176 356 178 L 420 186 Q 444 188 446 166 Q 448 146 426 144 L 360 138 Q 340 136 336 118 L 330 70 Q 326 50 306 50 L 190 54 Q 170 56 172 76 L 176 110 Q 178 128 160 132 L 110 140 Q 90 144 88 164 L 80 210 Q 78 230 80 230 Z' }),
].map(c => [c.id, c]));

// The 2026 calendar as reported in November 2026 (crash.net, cross-checked with espn.com):
// 23 rounds after the Sakhir (Bahrain) and Jeddah (Saudi Arabia) races were cancelled. Round 16 is
// reported as the Bahrain Grand Prix held at Sepang; only one source confirms it.
export interface Round { round: number; gp: string; circuit: string; date: string; note?: string }
export const CALENDAR_2026: Round[] = [
  { round: 1, gp: 'Australian Grand Prix', circuit: 'melbourne', date: '8 Mar' },
  { round: 2, gp: 'Chinese Grand Prix', circuit: 'shanghai', date: '15 Mar' },
  { round: 3, gp: 'Japanese Grand Prix', circuit: 'suzuka', date: '29 Mar' },
  { round: 4, gp: 'Miami Grand Prix', circuit: 'miami', date: '3 May' },
  { round: 5, gp: 'Canadian Grand Prix', circuit: 'montreal', date: '24 May' },
  { round: 6, gp: 'Monaco Grand Prix', circuit: 'monaco', date: '7 Jun' },
  { round: 7, gp: 'Spanish Grand Prix', circuit: 'barcelona', date: '14 Jun' },
  { round: 8, gp: 'Austrian Grand Prix', circuit: 'spielberg', date: '28 Jun' },
  { round: 9, gp: 'British Grand Prix', circuit: 'silverstone', date: '5 Jul' },
  { round: 10, gp: 'Belgian Grand Prix', circuit: 'spa', date: '19 Jul' },
  { round: 11, gp: 'Hungarian Grand Prix', circuit: 'hungaroring', date: '26 Jul' },
  { round: 12, gp: 'Dutch Grand Prix', circuit: 'zandvoort', date: '23 Aug' },
  { round: 13, gp: 'Italian Grand Prix', circuit: 'monza', date: '6 Sep' },
  { round: 14, gp: 'Madrid Grand Prix', circuit: 'madrid', date: '13 Sep' },
  { round: 15, gp: 'Azerbaijan Grand Prix', circuit: 'baku', date: '26 Sep' },
  { round: 16, gp: 'Bahrain Grand Prix', circuit: 'sepang', date: '4 Oct', note: 'Held at Sepang after the Sakhir race was cancelled' },
  { round: 17, gp: 'Singapore Grand Prix', circuit: 'singapore', date: '11 Oct' },
  { round: 18, gp: 'United States Grand Prix', circuit: 'austin', date: '25 Oct' },
  { round: 19, gp: 'Mexico City Grand Prix', circuit: 'mexico', date: '1 Nov' },
  { round: 20, gp: 'São Paulo Grand Prix', circuit: 'interlagos', date: '8 Nov' },
  { round: 21, gp: 'Las Vegas Grand Prix', circuit: 'lasvegas', date: '21 Nov' },
  { round: 22, gp: 'Qatar Grand Prix', circuit: 'lusail', date: '29 Nov' },
  { round: 23, gp: 'Abu Dhabi Grand Prix', circuit: 'yasmarina', date: '6 Dec' },
];

function hashString(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A smooth closed schematic outline, the same for a circuit every time, with the start on a straight. */
export function schematicPath(id: string) {
  let h = hashString(id);
  const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return (h % 10000) / 10000; };
  const n = 9 + Math.floor(rnd() * 5), cx = 260, cy = 142, rx = 178, ry = 102;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 - Math.PI / n + (i / n) * Math.PI * 2 + (i > 1 ? (rnd() - 0.5) * 0.4 : 0);
    const k = i < 2 ? 0.95 : 0.55 + rnd() * 0.45;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  // The first two corners frame the start/finish straight along the bottom.
  pts[0][1] = pts[1][1] = cy + ry * 0.9;
  const clamp = ([x, y]: [number, number]): [number, number] => [Math.max(58, Math.min(462, x)), Math.max(20, Math.min(262, y))];
  const p = pts.map(clamp), mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2].map(v => Math.round(v));
  let d = `M ${mid(p[0], p[1]).join(' ')}`;
  for (let i = 1; i <= n; i++) d += ` Q ${p[i % n].map(Math.round).join(' ')} ${mid(p[i % n], p[(i + 1) % n]).join(' ')}`;
  return d + ' Z';
}

export function pathOf(circuit: Circuit) {
  return circuit.path ?? schematicPath(circuit.id);
}

/** One car in a scenario: seconds behind the leader, tyre, tyre age, and optional pace tweak (s/lap, negative is faster). */
export interface GridEntry { id: number; gap: number; compound: Compound; age: number; pace?: number }
export interface Scenario {
  id: string; number: string; title: string; circuit: string;
  headline: string; stakes: string; summary: string;
  theo: string; nico: string; intro: string;
  /** James sets the scene on the radio once the race is underway. */
  opening: string;
  startLap: number; totalLaps: number; seed: number;
  grid: GridEntry[];
  objectives: Record<1 | 2, Objective>;
  safety: SafetyWindow[];
  weather: WeatherPoint[] | null;
  forecast: { rainChance: number; text: string; confidence: string };
}

const g = (id: number, gap: number, compound: Compound, age: number, pace?: number): GridEntry => ({ id, gap, compound, age, ...(pace !== undefined ? { pace } : {}) });
const dry = (rainChance: number, text: string, confidence: string) => ({ rainChance, text, confidence });

const MORE_SCENARIOS: Scenario[] = [
  {
    id: 'melbourne', number: '06', title: 'Season opener', circuit: 'melbourne',
    headline: 'SEASON OPENER', stakes: 'Both cars nose to tail. One pit box.',
    summary: 'Fourteen laps left in Melbourne. Theo P2 and Nico P3, a second apart, both on tyres that will not last. A safety car is likely, and only one car can be serviced at a time.',
    intro: 'Melbourne. Fourteen laps left in the first race of the year. Both cars nose to tail, one pit box.',
    theo: 'P2 on worn mediums, a second ahead of his teammate.',
    nico: 'P3, right behind Theo. If both stop together, he waits in the queue.',
    opening: 'Fourteen to go. Theo P2, Nico P3, a second apart. If we stop both together, Nico waits behind Theo.',
    startLap: 44, totalLaps: 58, seed: 7106,
    grid: [g(0, 0, 'medium', 14), g(1, 2.0, 'medium', 15), g(4, 3.0, 'medium', 13), g(2, 6.0, 'hard', 8), g(3, 8.8, 'medium', 11),
      g(10, 11.5, 'hard', 9), g(14, 14.2, 'medium', 12), g(6, 17.0, 'hard', 10), g(5, 20.5, 'hard', 15), g(7, 24.0, 'medium', 9)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 3 } },
    safety: [{ start: 300, ending: 430, end: 445 }], weather: null,
    forecast: dry(10, 'Dry, breezy', '85% confidence'),
  },
  {
    id: 'suzuka', number: '07', title: 'Two-stop gamble', circuit: 'suzuka',
    headline: 'TWO-STOP GAMBLE', stakes: 'High wear, fast corners. Is one more stop worth it?',
    summary: 'Twenty-three laps left at Suzuka. Tyres fall away fast here. Theo P3 on mediums that will not last; one more stop, or nurse them home?',
    intro: 'Suzuka. Twenty-three laps left. The esses are eating the tyres.',
    theo: 'P3 on 13-lap-old mediums that will not reach the flag.',
    nico: 'P5 on mediums. Fast, but the tyres are fading.',
    opening: 'Twenty-three to go. Wear is high today. Theo, those mediums will not reach the flag. We need a plan.',
    startLap: 30, totalLaps: 53, seed: 7107,
    grid: [g(2, 0, 'hard', 16), g(0, 3.5, 'hard', 15), g(1, 6.0, 'medium', 13), g(3, 8.5, 'hard', 14), g(4, 11.0, 'medium', 11),
      g(14, 14.0, 'hard', 12), g(10, 17.0, 'hard', 18), g(6, 21.0, 'medium', 9), g(12, 25.0, 'hard', 10), g(5, 29.0, 'hard', 20)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 3 } },
    safety: [], weather: null,
    forecast: dry(20, 'Dry, overcast', '75% confidence'),
  },
  {
    id: 'sepang', number: '08', title: 'Tropical heat', circuit: 'sepang',
    headline: 'TROPICAL HEAT', stakes: 'Tyres melting. Whoever stops first wins the undercut.',
    summary: 'Twenty laps left at Sepang, standing in for Bahrain. Fifty-degree track, tyres melting, and four cars on the same strategy. The first stop wins the undercut.',
    intro: 'Sepang. Twenty laps left in the heat. Everyone needs a stop; the order of the stops decides the race.',
    theo: 'P2 on hot mediums, 1.5 seconds behind Keller.',
    nico: 'P4, also on worn mediums. Vega is right ahead of him.',
    opening: 'Twenty to go and the tyres are melting. Everyone needs a stop. The first good stop wins the undercut.',
    startLap: 36, totalLaps: 56, seed: 7108,
    grid: [g(3, 0, 'medium', 12), g(1, 1.5, 'medium', 13), g(2, 3.2, 'medium', 12), g(4, 5.0, 'medium', 14), g(0, 7.5, 'hard', 15),
      g(14, 10.0, 'medium', 11), g(13, 13.0, 'hard', 14), g(10, 16.0, 'medium', 10), g(6, 19.0, 'hard', 18), g(11, 23.0, 'medium', 12)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 4 } },
    safety: [], weather: null,
    forecast: dry(30, 'Hot, storms later', '60% confidence'),
  },
  {
    id: 'baku', number: '09', title: 'Two safety cars', circuit: 'baku',
    headline: 'TWO SAFETY CARS', stakes: 'Walls, chaos, and two chances to stop cheaply. Pick one.',
    summary: 'Seventeen laps left in Baku. One safety car now, another later. Stop early and be exposed, or wait and risk it never coming.',
    intro: 'Baku. Seventeen laps left. On this street circuit, safety cars come in pairs.',
    theo: 'P2 on 20-lap-old hards, 2.4 behind Voss.',
    nico: 'P4 on mediums. Quick down the long straight.',
    opening: 'Seventeen to go in Baku. Theo P2, Nico P4. Keep your heads; the walls will bring a safety car.',
    startLap: 34, totalLaps: 51, seed: 7109,
    grid: [g(0, 0, 'hard', 18), g(1, 2.4, 'hard', 20), g(10, 4.5, 'medium', 12), g(4, 6.0, 'medium', 15), g(2, 9.0, 'hard', 16),
      g(3, 12.0, 'medium', 10), g(14, 15.0, 'hard', 22), g(6, 18.0, 'medium', 14), g(21, 22.0, 'hard', 12), g(5, 26.0, 'hard', 19)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 3 } },
    safety: [{ start: 150, ending: 285, end: 300 }, { start: 1000, ending: 1135, end: 1150 }], weather: null,
    forecast: dry(5, 'Dry and windy', '90% confidence'),
  },
  {
    id: 'spa', number: '10', title: 'Ardennes rain', circuit: 'spa',
    headline: 'ARDENNES RAIN', stakes: 'Rain is coming, and this time it stays.',
    summary: 'Fourteen laps left at Spa. A heavy shower is minutes away and will not stop. The first good call to inters takes the race.',
    intro: 'Spa. Fourteen laps left. Heavy rain is minutes away, and it is here to stay.',
    theo: 'P3 on old hards. Brilliant in the wet if the call is right.',
    nico: 'P4 on mediums. He wants inters the second it rains.',
    opening: 'Fourteen to go. Heavy rain on the radar, and it stays to the end. The crossover is our race.',
    startLap: 30, totalLaps: 44, seed: 7110,
    grid: [g(0, 0, 'medium', 10), g(14, 2.8, 'medium', 12), g(1, 4.0, 'hard', 16), g(4, 7.5, 'medium', 11), g(2, 9.0, 'hard', 14),
      g(3, 12.0, 'medium', 13), g(10, 15.0, 'hard', 15), g(13, 18.0, 'medium', 9), g(6, 21.0, 'hard', 17), g(7, 25.0, 'medium', 10)],
    objectives: { 1: { kind: 'position', max: 3 }, 2: { kind: 'position', max: 4 } },
    safety: [], weather: [{ at: 0, wet: 0 }, { at: 200, wet: 0 }, { at: 380, wet: 0.6 }, { at: 520, wet: 0.75 }, { at: 3000, wet: 0.75 }],
    forecast: { rainChance: 95, text: 'Heavy rain arriving, staying', confidence: '90% confidence' },
  },
  {
    id: 'hungaroring', number: '11', title: 'Team orders', circuit: 'hungaroring',
    headline: 'TEAM ORDERS', stakes: 'Nico can win this. Theo is in the way. Your call.',
    summary: 'Eighteen laps left in Hungary, where passing is hard. Nico is quicker on fresher tyres but stuck behind Theo. A one-two with Nico winning is on, if the team plays it right.',
    intro: 'Budapest. Eighteen laps left on a track where nobody gets past. Nico is quicker, and he is stuck behind Theo.',
    theo: 'P2 on old hards that will not reach the flag. Target: hold P2.',
    nico: 'P3 on fresher mediums, faster than Theo but unable to pass. Target: the win.',
    opening: 'Eighteen to go. Theo P2, Nico P3 and quicker. Nobody passes here. If we want the win, we may need team orders.',
    startLap: 52, totalLaps: 70, seed: 7111,
    grid: [g(0, 0, 'hard', 24), g(1, 1.8, 'hard', 18), g(4, 2.6, 'medium', 12), g(3, 4.5, 'medium', 8), g(2, 7.0, 'hard', 20),
      g(14, 10.0, 'medium', 14), g(6, 13.0, 'hard', 16), g(10, 16.0, 'medium', 10), g(5, 19.0, 'hard', 22), g(13, 23.0, 'medium', 12)],
    objectives: { 1: { kind: 'position', max: 2 }, 2: { kind: 'position', max: 1 } },
    safety: [], weather: null,
    forecast: dry(10, 'Hot and dry', '90% confidence'),
  },
  {
    id: 'zandvoort', number: '12', title: 'Hold the line', circuit: 'zandvoort',
    headline: 'HOLD THE LINE', stakes: 'Leading on old tyres. Nobody passes here, if the tyres survive.',
    summary: 'Fifteen laps left at Zandvoort. Theo leads on old hards; Vega is faster on paper but cannot pass here. Make the tyres last.',
    intro: 'Zandvoort. Fifteen laps left. Narrow, banked, impossible to pass. Theo leads; the tyres decide it.',
    theo: 'Leads on 22-lap-old hards. They will not last at full pace.',
    nico: 'P4 on mediums, with Keller ahead of him.',
    opening: 'Fifteen to go. Theo leads, but those hards will not last at this pace. Nobody passes here if we look after them.',
    startLap: 57, totalLaps: 72, seed: 7112,
    grid: [g(1, 0, 'hard', 22), g(2, 1.6, 'hard', 20), g(3, 5.0, 'medium', 12), g(4, 8.0, 'medium', 14), g(0, 11.0, 'hard', 18),
      g(14, 14.0, 'medium', 10), g(10, 18.0, 'hard', 16), g(6, 22.0, 'medium', 12), g(13, 25.0, 'hard', 20), g(5, 28.0, 'medium', 9)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 5 } },
    safety: [], weather: null,
    forecast: dry(20, 'Dry, sea breeze', '80% confidence'),
  },
  {
    id: 'singapore', number: '13', title: 'Under the lights', circuit: 'singapore',
    headline: 'UNDER THE LIGHTS', stakes: 'Hot, humid, no way past. Stop now, or wait for the safety car?',
    summary: 'Fifteen laps left in Singapore. Theo P4 on old hards behind cars he cannot pass. A stop costs 26 seconds: take it now and run them down, or gamble on a safety car halving it.',
    intro: 'Singapore. Fifteen laps left under the lights. A green-flag stop costs 26 seconds. A safety car halves it.',
    theo: 'P4 on old hards, quicker than the cars ahead but stuck.',
    nico: 'P5 on mediums, a long way back. Target: hold the top five.',
    opening: 'Fifteen to go. A stop costs twenty-six seconds here. The cars ahead are on dying tyres. We stop now, or we wait for a safety car.',
    startLap: 47, totalLaps: 62, seed: 7113,
    grid: [g(0, 0, 'hard', 30), g(2, 2.0, 'hard', 28), g(3, 3.5, 'medium', 18), g(1, 5.0, 'hard', 25), g(4, 9.0, 'medium', 14),
      g(14, 12.0, 'hard', 22), g(10, 15.0, 'medium', 12), g(6, 19.0, 'hard', 26), g(13, 23.0, 'medium', 10), g(5, 27.0, 'hard', 20)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 5 } },
    safety: [{ start: 780, ending: 915, end: 930 }], weather: null,
    forecast: dry(25, 'Humid, storms nearby', '65% confidence'),
  },
  {
    id: 'interlagos', number: '14', title: 'Late storm', circuit: 'interlagos',
    headline: 'LATE STORM', stakes: 'Five laps of rain at the end. Gamble or hold?',
    summary: 'Fifteen laps left at Interlagos. A storm will hit with about five laps to go. Box for inters early, late, or not at all?',
    intro: 'São Paulo. Fifteen laps left, and a storm is coming for the final laps.',
    theo: 'P2 on hards, 2.5 seconds behind Voss. Target: hold P2 at least.',
    nico: 'P4 on hards. Target: stay in the top four.',
    opening: 'Fifteen to go. A storm hits for the last five laps. This race will be decided by one call.',
    startLap: 56, totalLaps: 71, seed: 7114,
    grid: [g(0, 0, 'medium', 12), g(1, 2.5, 'hard', 14), g(2, 4.5, 'hard', 16), g(4, 6.0, 'hard', 12), g(3, 9.0, 'medium', 10),
      g(14, 12.0, 'hard', 14), g(10, 15.0, 'medium', 12), g(6, 18.0, 'hard', 18), g(13, 22.0, 'medium', 11), g(5, 25.0, 'hard', 20)],
    objectives: { 1: { kind: 'position', max: 2 }, 2: { kind: 'position', max: 4 } },
    safety: [], weather: [{ at: 0, wet: 0 }, { at: 700, wet: 0 }, { at: 820, wet: 0.6 }, { at: 3000, wet: 0.65 }],
    forecast: { rainChance: 90, text: 'Storm late in the race', confidence: '80% confidence' },
  },
  {
    id: 'lasvegas', number: '15', title: 'Cold night', circuit: 'lasvegas',
    headline: 'COLD NIGHT', stakes: 'New tyres take a lap to work. Who should stop, and who should go long?',
    summary: 'Sixteen laps left in Las Vegas at 12°C. New tyres are slow for a lap on a cold track. Theo can go long against Voss; Nico’s old hards will not hold the podium.',
    intro: 'Las Vegas. Sixteen laps left on a freezing track. New tyres are slow for a lap.',
    theo: 'P2, 1.8 behind Voss on mediums. Voss has to stop before the end; does Theo?',
    nico: 'P3 on 28-lap-old hards that are fading. Target: the podium.',
    opening: 'Sixteen to go and it is freezing. New tyres take a lap to switch on. Think hard before every stop tonight.',
    startLap: 34, totalLaps: 50, seed: 7115,
    grid: [g(0, 0, 'medium', 17), g(1, 1.8, 'medium', 16), g(4, 5.0, 'hard', 28), g(2, 7.0, 'medium', 18), g(3, 9.0, 'hard', 12),
      g(14, 12.0, 'medium', 15), g(10, 15.0, 'hard', 20), g(6, 18.0, 'medium', 13), g(13, 21.0, 'hard', 17), g(5, 25.0, 'medium', 11)],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 3 } },
    safety: [], weather: null,
    forecast: dry(0, 'Cold and clear', '95% confidence'),
  },
];

export const SCENARIOS: Scenario[] = [
  {
    id: 'barcelona', number: '01', title: 'The long game', circuit: 'barcelona',
    headline: 'THE LONG GAME', stakes: 'A podium to protect. A second car ready to attack.',
    summary: 'Eighteen laps left. Theo P2 on ageing mediums, Nico P5 on softs at the cliff. A safety car may change everything.',
    intro: 'Barcelona. Eighteen laps left. Two drivers relying on your next call.',
    theo: 'P2 on ageing mediums. A measured veteran with a podium to protect.',
    nico: 'P5 on softs approaching the cliff. Quick, impatient, and ready to attack.',
    opening: 'Eighteen to go. Theo P2, Nico P5. Nico’s softs are close to the cliff.',
    startLap: 18, totalLaps: 36, seed: 2049,
    grid: [
      { id: 0, gap: 0, compound: 'medium', age: 14 }, { id: 1, gap: 3.8, compound: 'medium', age: 16 },
      { id: 2, gap: 7.2, compound: 'hard', age: 9 }, { id: 3, gap: 10.6, compound: 'medium', age: 13 },
      { id: 4, gap: 13.1, compound: 'soft', age: 10 }, { id: 5, gap: 17.4, compound: 'hard', age: 12 },
      { id: 6, gap: 23.2, compound: 'medium', age: 12 }, { id: 7, gap: 28.6, compound: 'hard', age: 8 },
      { id: 8, gap: 34.4, compound: 'medium', age: 14 }, { id: 9, gap: 40.1, compound: 'hard', age: 10 },
    ],
    objectives: { 1: { kind: 'position', max: 3 }, 2: { kind: 'position', max: 5 } },
    safety: [{ start: 270, ending: 405, end: 420 }], weather: null,
    forecast: { rainChance: 10, text: 'Dry to finish', confidence: '80% confidence' },
  },
  {
    id: 'monza', number: '02', title: 'Slipstream', circuit: 'monza',
    headline: 'SLIPSTREAM', stakes: 'Lead on dying hards. Everyone behind can pass.',
    summary: 'Fourteen laps left at Monza. Theo leads on hards that will not last; Vega sits in the tow. Nico P5 needs a podium. Passing is easy here, so fresh tyres are worth a lot.',
    intro: 'Monza. Fourteen laps left. Low downforce, long straights, and every car in the tow can pass.',
    theo: 'Leads on 28-lap-old hards that will not reach the flag. Defend, or stop and come back through?',
    nico: 'P5 on mediums that will not quite last. A podium needs a bold call. A stop costs 24 seconds here.',
    opening: 'Fourteen to go. Theo leads Vega by one point two, but Theo’s hards will not make the flag. Nico, P5, we need a podium.',
    startLap: 39, totalLaps: 53, seed: 3102,
    grid: [
      { id: 1, gap: 0, compound: 'hard', age: 28 }, { id: 2, gap: 1.2, compound: 'medium', age: 14, pace: 0.1 },
      { id: 3, gap: 5.5, compound: 'soft', age: 6 }, { id: 0, gap: 8.5, compound: 'hard', age: 26 },
      { id: 4, gap: 10.4, compound: 'medium', age: 17 }, { id: 5, gap: 15.0, compound: 'hard', age: 18 },
      { id: 7, gap: 19.3, compound: 'medium', age: 11 }, { id: 6, gap: 23.0, compound: 'hard', age: 20 },
      { id: 9, gap: 27.8, compound: 'medium', age: 9 }, { id: 8, gap: 31.5, compound: 'hard', age: 16 },
    ],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 3 } },
    safety: [], weather: null,
    forecast: { rainChance: 5, text: 'Dry and hot', confidence: '90% confidence' },
  },
  {
    id: 'monaco', number: '03', title: 'Track position', circuit: 'monaco',
    headline: 'TRACK POSITION', stakes: 'No way past on track. The pit wall has to find the win.',
    summary: 'Twenty-two laps left in Monaco. Theo P3 behind Vega’s dying mediums and Voss’s hards; overtaking is nearly impossible. A win needs a perfectly timed stop. Nico P7 waits for a break.',
    intro: 'Monaco. Twenty-two laps left. You cannot pass here. You can only out-think them.',
    theo: 'P3 on old hards, faster than the cars ahead but with nowhere to go. The win has to come from the pit wall.',
    nico: 'P7 on young hards. Patient laps now; a safety car could open the door to the top five.',
    opening: 'Twenty-two to go. Theo is stuck behind Vega. There is no passing here, so this one is won in the pit lane.',
    startLap: 56, totalLaps: 78, seed: 4103,
    grid: [
      { id: 0, gap: 0, compound: 'hard', age: 24 }, { id: 2, gap: 2.6, compound: 'medium', age: 30, pace: 0.3 },
      { id: 1, gap: 3.4, compound: 'hard', age: 25 }, { id: 3, gap: 6.1, compound: 'hard', age: 22 },
      { id: 6, gap: 9.8, compound: 'medium', age: 18 }, { id: 5, gap: 13.0, compound: 'hard', age: 26 },
      { id: 4, gap: 16.2, compound: 'hard', age: 8 }, { id: 8, gap: 19.9, compound: 'medium', age: 12 },
      { id: 7, gap: 24.5, compound: 'hard', age: 30 }, { id: 9, gap: 29.0, compound: 'hard', age: 21 },
    ],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 5 } },
    safety: [{ start: 900, ending: 1030, end: 1045 }], weather: null,
    forecast: { rainChance: 5, text: 'Dry, high track temperature', confidence: '85% confidence' },
  },
  {
    id: 'silverstone', number: '04', title: 'Changing skies', circuit: 'silverstone',
    headline: 'CHANGING SKIES', stakes: 'Rain on the radar. An Apex one-two if the calls are right.',
    summary: 'Sixteen laps left at Silverstone with rain on the radar. Call the switch to inters, and the switch back, before the field does. Get it right and a one-two is on.',
    intro: 'Silverstone. Sixteen laps left. The radar shows rain arriving in a few minutes, and it will not last.',
    theo: 'P2 on mediums. Calm in the wet; trusts the call when it comes. Needs the win.',
    nico: 'P4 on hards. Wants inters the moment it spits. P2 makes it a one-two.',
    opening: 'Sixteen to go. Theo P2, Nico P4. Rain on the radar in about four minutes. We decide the crossover together.',
    startLap: 36, totalLaps: 52, seed: 5104,
    grid: [
      { id: 3, gap: 0, compound: 'medium', age: 10 }, { id: 1, gap: 2.2, compound: 'medium', age: 12 },
      { id: 0, gap: 5.9, compound: 'hard', age: 18 }, { id: 4, gap: 8.1, compound: 'hard', age: 20 },
      { id: 2, gap: 11.6, compound: 'medium', age: 9 }, { id: 5, gap: 15.2, compound: 'hard', age: 22 },
      { id: 7, gap: 19.0, compound: 'medium', age: 14 }, { id: 6, gap: 23.4, compound: 'hard', age: 17 },
      { id: 8, gap: 27.7, compound: 'medium', age: 11 }, { id: 9, gap: 33.1, compound: 'hard', age: 19 },
    ],
    objectives: { 1: { kind: 'position', max: 1 }, 2: { kind: 'position', max: 2 } },
    safety: [],
    weather: [{ at: 0, wet: 0 }, { at: 240, wet: 0 }, { at: 420, wet: 0.55 }, { at: 720, wet: 0.62 }, { at: 1000, wet: 0.2 }, { at: 1150, wet: 0 }],
    forecast: { rainChance: 85, text: 'Showers arriving, then drying', confidence: '70% confidence' },
  },
  {
    id: 'yasmarina', number: '05', title: 'Title decider', circuit: 'yasmarina',
    headline: 'TITLE DECIDER', stakes: 'Finish ahead of Voss and the title is Theo’s.',
    summary: 'Sixteen laps left in Abu Dhabi. Theo must finish ahead of Voss to win the championship. Nico can help. A late safety car is likely.',
    intro: 'Abu Dhabi. Sixteen laps left in the season. Theo has to finish ahead of Voss. Nothing else matters.',
    theo: 'P2, 1.6 behind Voss, on 20-lap-old hards. Beat Voss and he is champion.',
    nico: 'P3 on hards. His job today: keep Costa back and help Theo however he can.',
    opening: 'Sixteen laps for the title. Theo, you need to finish ahead of Voss. Nico, protect Theo’s back.',
    startLap: 42, totalLaps: 58, seed: 6105,
    grid: [
      { id: 0, gap: 0, compound: 'medium', age: 8, pace: -0.15 }, { id: 1, gap: 1.6, compound: 'hard', age: 20 },
      { id: 4, gap: 6.5, compound: 'hard', age: 20 }, { id: 6, gap: 8.0, compound: 'medium', age: 9 },
      { id: 2, gap: 12.4, compound: 'hard', age: 21 }, { id: 3, gap: 16.0, compound: 'medium', age: 15 },
      { id: 5, gap: 20.8, compound: 'hard', age: 24 }, { id: 7, gap: 25.1, compound: 'medium', age: 13 },
      { id: 8, gap: 30.6, compound: 'hard', age: 19 }, { id: 9, gap: 35.2, compound: 'hard', age: 22 },
    ],
    objectives: { 1: { kind: 'beat', rival: 0 }, 2: { kind: 'position', max: 4 } },
    safety: [{ start: 640, ending: 775, end: 790 }], weather: null,
    forecast: { rainChance: 0, text: 'Dry, cooling at dusk', confidence: '95% confidence' },
  },
  ...MORE_SCENARIOS,
];

export const DEFAULT_SETUP: RaceSetup = { scenario: 'barcelona', mode: 'scenario', distance: 'half', seed: 2049 };

export function scenarioById(id: string) {
  return SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
}

export function circuitOf(setup: RaceSetup) {
  if (setup.mode === 'scenario') return CIRCUITS[scenarioById(setup.scenario).circuit];
  return CIRCUITS[setup.circuit ?? setup.scenario] ?? CIRCUITS[scenarioById(setup.scenario).circuit];
}

export function roundOf(setup: RaceSetup) {
  return setup.mode === 'season' ? CALENDAR_2026.find(r => r.round === setup.round) ?? null : null;
}

export function fullRaceLaps(circuit: Circuit, distance: Distance) {
  return distance === 'full' ? circuit.laps : Math.max(8, Math.round(circuit.laps / (distance === 'half' ? 2 : 3)));
}

// Counter-based draw (same hash as the simulation) so random race events depend only on the seed.
function draw(seed: number, channel: number) {
  let x = (seed ^ Math.imul(channel + 1, 0x9e3779b1) ^ 0x51ed270b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Car and driver pace for this race, in seconds per lap relative to the circuit's base pace. */
export function driverPace(setup: RaceSetup, id: number) {
  const d = ROSTER[id];
  // The original scenario field keeps the pace spread its scenarios were tuned with.
  if (setup.mode === 'scenario' && id < 10) return (id % 4) * 0.24;
  const team = teamOf(d);
  if (setup.mode === 'scenario') return team.pace + d.skill;
  // Each circuit suits each car a little differently.
  const bias = (draw(hashString(circuitOf(setup).id), 20 + team.pace * 100) - 0.5) * 0.24;
  return team.pace + d.skill + bias;
}

export function buildConfig(setup: RaceSetup): RaceConfig {
  const circuit = circuitOf(setup);
  const common = {
    setup, circuit: circuit.id, lapTime: circuit.lapTime, basePace: circuit.lapTime - 0.5,
    pitLoss: circuit.pitLoss, overtake: circuit.overtake, wear: circuit.wear, warmup: circuit.warmup ?? 0,
  };
  if (setup.mode === 'scenario') {
    const scenario = scenarioById(setup.scenario);
    return { ...common, totalLaps: scenario.totalLaps, startLap: scenario.startLap, safety: scenario.safety, weather: scenario.weather, objectives: scenario.objectives };
  }
  const laps = fullRaceLaps(circuit, setup.distance);
  const raceSeconds = laps * circuit.lapTime;
  // Seeded race events: the same seed always brings the same safety car and the same shower.
  const safety: SafetyWindow[] = [];
  if (draw(setup.seed, 1) < circuit.safetyChance) {
    const start = Math.round(raceSeconds * (0.12 + draw(setup.seed, 2) * 0.68));
    const length = Math.round(circuit.lapTime / 0.6 * (1.6 + draw(setup.seed, 3)));
    safety.push({ start, ending: start + length - 15, end: start + length });
  }
  let weather: WeatherPoint[] | null = null;
  if (draw(setup.seed, 4) < circuit.rainChance) {
    const begin = Math.round(raceSeconds * (0.25 + draw(setup.seed, 5) * 0.35));
    const peak = 0.45 + draw(setup.seed, 6) * 0.2;
    const hold = Math.round(300 + draw(setup.seed, 7) * 300);
    weather = [{ at: 0, wet: 0 }, { at: begin, wet: 0 }, { at: begin + 180, wet: peak }, { at: begin + 180 + hold, wet: peak }, { at: begin + 480 + hold, wet: 0.15 }, { at: begin + 600 + hold, wet: 0 }];
  }
  return {
    ...common, totalLaps: laps, startLap: 0, safety, weather,
    objectives: { 1: { kind: 'position', max: 5 }, 2: { kind: 'position', max: 6 } },
  };
}

/** Qualifying order for full races and season rounds: car and driver pace plus a little seeded luck. */
export function qualifying(setup: RaceSetup) {
  return ROSTER.map(d => ({ id: d.id, time: driverPace(setup, d.id) + (draw(setup.seed, 100 + d.id) - 0.5) * 0.6 }))
    .sort((a, b) => a.time - b.time).map(x => x.id);
}

/** Starting order and tyres for this race, as grid entries. */
export function buildGrid(setup: RaceSetup, config: RaceConfig): GridEntry[] {
  if (setup.mode === 'scenario') return scenarioById(setup.scenario).grid;
  return qualifying(setup).map((id, position) => ({
    id,
    gap: position * 0.25,
    compound: id === 1 ? setup.start?.[1] ?? 'medium' : id === 4 ? setup.start?.[2] ?? 'medium' : position < 8 ? 'medium' : position < 15 ? 'soft' : 'hard',
    age: 0,
  }));
}

export function objectiveLabel(objective: Objective) {
  if (objective.kind === 'beat') return `AHEAD OF ${ROSTER[objective.rival].name.split(' ')[1].toUpperCase()}`;
  return objective.max === 1 ? 'WIN' : `TOP ${objective.max}`;
}

export function raceTitle(setup: RaceSetup) {
  const circuit = circuitOf(setup);
  if (setup.mode === 'scenario') { const scenario = scenarioById(setup.scenario); return { kicker: `SCENARIO ${scenario.number}`, title: scenario.title, headline: scenario.headline }; }
  const distance = setup.distance === 'full' ? 'Full distance' : setup.distance === 'half' ? 'Half distance' : 'Sprint distance';
  const round = roundOf(setup);
  if (round) return { kicker: `SEASON 2026 · ROUND ${round.round}`, title: round.gp, headline: 'LIGHTS OUT' };
  return { kicker: `FULL RACE · ${distance.toUpperCase()}`, title: `${circuit.city} Grand Prix`, headline: 'LIGHTS OUT' };
}
