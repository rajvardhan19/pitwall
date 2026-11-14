// Read-only helpers that describe the race the way the pit wall talks about it.
// Shared by the conversation layer, the in-browser model's fact sheet and the UI.
import { order, playerCar, lapPace, lapsLeftOn, wetness } from './sim.ts';
import type { Car, Race } from './sim.ts';
import { ROSTER } from './scenarios.ts';

export const DRIVER = { 1: 'LAU', 2: 'REY' } as const;
export type DriverKey = (typeof DRIVER)[1 | 2];

export function carNumber(car: Car): 1 | 2 | 0 {
  return car.id === 1 ? 1 : car.id === 4 ? 2 : 0;
}

export function firstName(car: Car) {
  return car.name.split(' ')[0];
}

export function surname(car: Car) {
  return car.name.split(' ').slice(1).join(' ');
}

/** Our drivers by first name, everyone else by surname — how an engineer says it. */
export function callName(car: Car) {
  return car.player ? firstName(car) : surname(car);
}

export function positionOf(r: Race, car: Car) {
  return order(r).findIndex(c => c.id === car.id) + 1;
}

export function totalLaps(r: Race) {
  return r.config.totalLaps;
}

export function currentLap(r: Race) {
  return Math.min(r.config.totalLaps, Math.floor(order(r)[0].distance) + 1);
}

export function lapsRemaining(car: Car, r: Race) {
  return Math.max(0, Math.ceil(r.config.totalLaps - car.distance));
}

/** Live gap in seconds to the car directly ahead on the road, or null when leading. */
export function gapAhead(r: Race, car: Car): { car: Car; seconds: number } | null {
  const sorted = order(r);
  const ahead = sorted[sorted.findIndex(c => c.id === car.id) - 1];
  if (!ahead) return null;
  return { car: ahead, seconds: Math.max(0, (ahead.distance - car.distance) * lapPace(car, r)) };
}

export function gapBehind(r: Race, car: Car): { car: Car; seconds: number } | null {
  const sorted = order(r);
  const behind = sorted[sorted.findIndex(c => c.id === car.id) + 1];
  if (!behind) return null;
  return { car: behind, seconds: Math.max(0, (car.distance - behind.distance) * lapPace(behind, r)) };
}

export function tyreLife(car: Car) {
  return Math.max(0, Math.round((1 - car.wear) * 100));
}

/** Laps before this set reaches the point where it falls away, at the current pace mode. */
export function lapsOfLife(car: Car, r: Race) {
  return lapsLeftOn(r, car);
}

export function tyresReachFinish(car: Car, r: Race) {
  return lapsOfLife(car, r) >= r.config.totalLaps - car.distance;
}

export function seconds(n: number) {
  return n.toFixed(1);
}

export function teammate(r: Race, number: 1 | 2) {
  return playerCar(r, number === 1 ? 2 : 1)!;
}

// ───────────── objectives ─────────────

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function objectiveOf(r: Race, n: 1 | 2) {
  return r.config.objectives[n];
}

/** Is this driver meeting the race objective right now? */
export function onTarget(r: Race, n: 1 | 2, pos = positionOf(r, playerCar(r, n)!)) {
  const ob = objectiveOf(r, n);
  if (ob.kind === 'position') return pos <= ob.max;
  return pos < positionOf(r, r.cars.find(c => c.id === ob.rival)!);
}

/** Places to gain to meet the objective (0 when on target). */
export function placesOff(r: Race, n: 1 | 2, pos = positionOf(r, playerCar(r, n)!)) {
  const ob = objectiveOf(r, n);
  if (ob.kind === 'position') return Math.max(0, pos - ob.max);
  // Getting ahead of a rival two places up the road means gaining two places.
  return Math.max(0, pos - positionOf(r, r.cars.find(c => c.id === ob.rival)!));
}

/** The position that meets the objective, for the result question and the quick replies. */
export function targetPosition(r: Race, n: 1 | 2) {
  const ob = objectiveOf(r, n);
  return ob.kind === 'position' ? ob.max : positionOf(r, r.cars.find(c => c.id === ob.rival)!) - 1;
}

/** How the team talks about the objective: “the podium”, “on the podium”, “Off the podium.” */
export function targetPhrase(r: Race, n: 1 | 2) {
  const ob = objectiveOf(r, n);
  if (ob.kind === 'beat') {
    const rival = ROSTER[ob.rival].name.split(' ')[1];
    return { goal: `to finish ahead of ${rival}`, need: `to get ahead of ${rival}`, name: `ahead of ${rival}`, in: `ahead of ${rival}`, out: `Behind ${rival} now.` };
  }
  if (ob.max === 1) return { goal: 'the win', need: 'for the win', name: 'the win', in: 'in the lead', out: 'No longer leading.' };
  if (ob.max === 3) return { goal: 'the podium', need: 'for the podium', name: 'the podium', in: 'on the podium', out: 'Off the podium.' };
  const top = `top ${WORDS[ob.max] ?? ob.max}`;
  return { goal: `the ${top}`, need: `for the ${top}`, name: `the ${top}`, in: `in the ${top}`, out: `Out of the ${top}.` };
}

/** Track state, as the team and the conditions panel describe it. */
export function trackState(r: Race) {
  const w = wetness(r);
  return w < 0.05 ? 'DRY' : w < 0.3 ? 'DAMP' : w < 0.6 ? 'WET' : 'VERY WET';
}
