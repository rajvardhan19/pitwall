// The 2026 season: every round of the calendar as a full race, with drivers' and constructors'
// standings saved in the browser. Rounds can be raced, or simulated with the default engineer.
import { CALENDAR_2026, ROSTER, TEAMS } from './scenarios.ts';
import type { Distance, RaceSetup, Round } from './scenarios.ts';
import { createRace, step, order } from './sim.ts';
import type { Compound, Race } from './sim.ts';
import { engineerStep } from './analysis.ts';

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const SEASON_KEY = 'pitwall.season.2026';
export interface SeasonResult { round: number; order: number[]; simulated: boolean }
export interface Season { version: 1; distance: Distance; seed: number; start: { 1: Compound; 2: Compound }; results: SeasonResult[] }
export interface DriverStanding { id: number; points: number; wins: number; podiums: number }
export interface TeamStanding { team: string; color: string; points: number }

export function newSeason(distance: Distance, seed: number, start: { 1: Compound; 2: Compound } = { 1: 'medium', 2: 'medium' }): Season {
  return { version: 1, distance, seed, start, results: [] };
}

export function nextRound(s: Season): Round | null {
  return CALENDAR_2026[s.results.length] ?? null;
}

export function seasonOver(s: Season) {
  return s.results.length >= CALENDAR_2026.length;
}

/** Each round has its own seed, derived from the season seed, so a season is reproducible. */
export function roundSeed(s: Season, round: number) {
  let x = (s.seed ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  return (x % 900000) + 100000;
}

export function standings(s: Season): { drivers: DriverStanding[]; teams: TeamStanding[] } {
  const drivers = new Map<number, DriverStanding>(ROSTER.map(d => [d.id, { id: d.id, points: 0, wins: 0, podiums: 0 }]));
  for (const result of s.results) result.order.forEach((id, i) => {
    const d = drivers.get(id)!;
    d.points += POINTS[i] ?? 0;
    if (i === 0) d.wins++;
    if (i < 3) d.podiums++;
  });
  const sorted = [...drivers.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || a.id - b.id);
  const teams = TEAMS.map(t => ({ team: t.name, color: t.color, points: ROSTER.filter(d => d.team === t.name).reduce((sum, d) => sum + drivers.get(d.id)!.points, 0) }))
    .sort((a, b) => b.points - a.points);
  return { drivers: sorted, teams };
}

const surname = (id: number) => ROSTER[id].name.split(' ').slice(1).join(' ');
const ordinal = (n: number) => `P${n}`;

/** What James says at lights out: the round, and where our drivers stand. */
export function briefFor(s: Season, round: Round) {
  const total = CALENDAR_2026.length;
  const opener = round.round === 1 ? `Round one, ${round.gp}. The 2026 season starts now.` : round.round === total ? `Final round, ${round.gp}. Everything comes down to this.` : `Round ${round.round}, ${round.gp}.`;
  if (!s.results.length) return `${opener} Lights out!`;
  const table = standings(s).drivers, pos = (id: number) => table.findIndex(d => d.id === id) + 1;
  const theo = pos(1), leader = table[0];
  const gap = theo === 1 ? `Theo leads the championship by ${leader.points - table[1].points}` : `Theo is ${ordinal(theo)} in the championship, ${leader.points - table[theo - 1].points} behind ${leader.id === 4 ? 'Nico' : surname(leader.id)}`;
  return `${opener} ${gap}. Nico is ${ordinal(pos(4))}. Lights out!`;
}

export function seasonSetup(s: Season, round = nextRound(s)): RaceSetup | null {
  if (!round) return null;
  return { scenario: round.circuit, mode: 'season', circuit: round.circuit, round: round.round, distance: s.distance, seed: roundSeed(s, round.round), start: s.start, brief: briefFor(s, round) };
}

/** Record a finished race as the next round. Ignored if it is not this season's next round. */
export function recordRace(s: Season, r: Race, simulated = false): Season {
  const round = nextRound(s);
  if (!round || r.status !== 'finished' || r.config.setup.mode !== 'season' || r.config.setup.round !== round.round) return s;
  return { ...s, results: [...s.results, { round: round.round, order: order(r).map(c => c.id), simulated }] };
}

/** Run the next round with the default engineer making the calls, and record it. */
export function simulateRound(s: Season): { season: Season; race: Race | null } {
  const setup = seasonSetup(s);
  if (!setup) return { season: s, race: null };
  const r = createRace(setup);
  r.status = 'running';
  while (r.status === 'running' && r.tick < 40000) { engineerStep(r); step(r); }
  return { season: recordRace(s, r, true), race: r };
}

export function loadSeason(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Season | null {
  try {
    const saved = JSON.parse(storage?.getItem(SEASON_KEY) ?? 'null');
    return saved && saved.version === 1 && Array.isArray(saved.results) ? saved : null;
  } catch { return null; }
}

export function saveSeason(s: Season | null, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage) {
  try { if (s) storage?.setItem(SEASON_KEY, JSON.stringify(s)); else storage?.removeItem(SEASON_KEY); } catch { /* private mode */ }
}
