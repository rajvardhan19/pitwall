import { buildConfig, buildGrid, DEFAULT_SETUP, driverPace, ROSTER } from './scenarios.ts';
import type { RaceConfig, RaceSetup } from './scenarios.ts';
export type { RaceConfig, RaceSetup } from './scenarios.ts';

export type Compound = 'soft' | 'medium' | 'hard' | 'inter';
export type Mode = 'push' | 'balanced' | 'conserve';
// 'swap' is a team order: the addressed car lets its teammate through.
export type Command = { car: number; action: 'pit'; compound: Compound } | { car: number; action: 'stay' | Mode | 'swap' };
export type CommandOutcome = 'ok' | 'no-car' | 'not-running' | 'finished' | 'committed' | 'bad-compound' | 'no-swap' | 'unknown';
export interface Car {
  id: number; name: string; code: string; team: string; color: string; player: boolean;
  distance: number; pace: number; compound: Compound; age: number; wear: number; mode: Mode;
  pitOrder: Compound | null; pitRemaining: number; stops: number; lastLap: number; lapStarted: number;
  lapTimes: number[]; trust: number; finishedAt: number | null; sector: number; shownDistance: number;
  yieldTo: number | null; yieldUntil: number;
}
// Structured facts for the conversation layer. The simulation never writes radio prose.
export type RaceEvent =
  | { at: number; type: 'safety' | 'safety-ending' | 'green' }
  | { at: number; type: 'pit'; car: number; compound: Compound; slow: number; queued: number }
  | { at: number; type: 'pit-exit'; car: number }
  | { at: number; type: 'finish'; car: number; position: number };
export interface Race {
  seed: number; random: number; elapsed: number; tick: number; status: 'ready' | 'running' | 'paused' | 'finished';
  flag: 'green' | 'safety'; cars: Car[]; events: RaceEvent[]; decisions: { at: number; command: Command }[];
  safetyTriggered: boolean; safetyEnded: boolean;
  /** Circuit, distance, events and objectives for this race. */
  config: RaceConfig;
}
// The original Barcelona scenario, kept as named defaults.
export const TOTAL_LAPS = 36;
export const START_LAP = 18;
export const SCENARIO_SEED = 2049;
export const TYRES: Record<Compound, { life: number; pace: number; color: string }> = {
  soft: { life: 14, pace: -0.9, color: '#ed6d73' }, medium: { life: 23, pace: 0, color: '#e9ce64' }, hard: { life: 34, pace: 0.85, color: '#d9dfdf' },
  // Intermediates: their speed depends on how wet the track is (see weatherPenalty).
  inter: { life: 30, pace: 0, color: '#5fb878' },
};
export const SLICKS: Compound[] = ['soft', 'medium', 'hard'];
// Counter-based draws: a changed pit call never reshuffles another car's luck.
export function raceRandom(seed:number,car:number,event:number,channel:number) {
  let x=(seed^Math.imul(car+1,0x9e3779b1)^Math.imul(event+1,0x85ebca6b)^Math.imul(channel+1,0xc2b2ae35))>>>0;
  x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);
  return ((x^(x>>>16))>>>0)/4294967296;
}
function setupOf(input: RaceSetup | number | undefined): RaceSetup {
  if (input === undefined) return DEFAULT_SETUP;
  return typeof input === 'number' ? { ...DEFAULT_SETUP, seed: input } : input;
}
export function createRace(input?: RaceSetup | number): Race {
  const setup = setupOf(input), config = buildConfig(setup), grid = buildGrid(setup, config);
  // Full races start from a grid just behind the line, so nobody completes a phantom lap at the start.
  const offset = config.startLap === 0 ? Math.max(...grid.map(g => g.gap)) / config.lapTime : 0;
  const cars: Car[] = grid.map((entry): Car => {
    const d = ROSTER[entry.id], distance = config.startLap + offset - entry.gap / config.lapTime;
    return {
      id:d.id,name:d.name,code:d.code,team:d.team,color:d.color,player:d.id===1||d.id===4,distance,
      pace: config.basePace + driverPace(setup, d.id) + (entry.pace ?? 0),
      compound:entry.compound,age:entry.age,wear:entry.age/(TYRES[entry.compound].life/config.wear),mode:'balanced',pitOrder:null,pitRemaining:0,stops:0,
      lastLap:config.lapTime + 1.2 + d.id*0.16,lapStarted:config.startLap===0?0:-entry.gap,lapTimes:[],trust:78,finishedAt:null,sector:Math.floor(distance*3),shownDistance:distance,
      yieldTo:null,yieldUntil:0,
    };
  }).sort((a,b)=>a.id-b.id);
  return {seed:setup.seed,random:setup.seed>>>0,elapsed:0,tick:0,status:'ready',flag:'green',cars,events:[],decisions:[],safetyTriggered:false,safetyEnded:false,config};
}
export function order(r: Race) { return [...r.cars].sort((a,b) => (a.finishedAt ?? Infinity)-(b.finishedAt ?? Infinity) || b.distance-a.distance || a.id-b.id); }
export function playerCar(r: Race, number: number) { return r.cars.find(c => c.player && c.id === (number===1 ? 1 : number===2 ? 4 : -1)); }
/** Applies a player call. Returns 'ok' or the reason it could not be carried out; never writes radio text. */
export function applyCommand(r: Race, command: Command, record = true): CommandOutcome {
  const car = playerCar(r,command.car);
  if (!car) return 'no-car';
  if (r.status !== 'running' && r.status !== 'paused') return 'not-running';
  if (car.finishedAt !== null) return 'finished';
  if (car.pitRemaining > 0 && (command.action==='pit' || command.action==='stay' || command.action==='swap')) return 'committed';
  if (command.action==='pit') {
    if (!Object.hasOwn(TYRES,command.compound)) return 'bad-compound';
    car.pitOrder = command.compound;
  } else if (command.action==='stay') car.pitOrder = null;
  else if (command.action==='push' || command.action==='balanced' || command.action==='conserve') car.mode = command.action;
  else if (command.action==='swap') {
    const mate = playerCar(r, command.car===1 ? 2 : 1)!;
    const sorted = order(r), index = sorted.indexOf(car);
    if (sorted[index+1] !== mate || mate.pitRemaining>0 || mate.finishedAt!==null || car.distance-mate.distance>0.035) return 'no-swap';
    car.yieldTo = mate.id; car.yieldUntil = r.elapsed + 90;
  } else return 'unknown';
  if (record) r.decisions.push({at:r.elapsed,command:{...command}});
  return 'ok';
}
/** How wet the track is, 0 (dry) to 1 (standing water), at this moment. */
export function wetness(r: Race, at = r.elapsed) {
  const w = r.config.weather;
  if (!w || !w.length) return 0;
  if (at <= w[0].at) return w[0].wet;
  for (let i = 1; i < w.length; i++) if (at <= w[i].at) {
    const a = w[i-1], b = w[i];
    return a.wet + (b.wet - a.wet) * (at - a.at) / Math.max(1, b.at - a.at);
  }
  return w[w.length-1].wet;
}
/** Lap-time cost of a compound on a track this wet. Slicks fall away fast; inters peak on a damp-to-wet track. */
export function weatherPenalty(compound: Compound, wet: number) {
  if (compound === 'inter') return 2.5 + 8 * (wet - 0.55) ** 2;
  return wet <= 0 ? 0 : 20 * wet ** 1.3;
}
export function tyreLife(r: Race, compound: Compound) { return TYRES[compound].life / r.config.wear; }
export function lapPace(car: Car, r: Race) {
  const cliff = Math.max(0,car.wear-0.78);
  const tyrePenalty = car.wear * 1.15 + cliff*cliff*48;
  // On a cold track a new set is slow until it has done about a lap.
  const warmup = r.config.warmup * Math.max(0, 1 - car.age);
  return car.pace + TYRES[car.compound].pace + tyrePenalty + warmup + weatherPenalty(car.compound, wetness(r)) - (car.distance-r.config.startLap)*0.035 + (car.mode==='push' ? -0.8 : car.mode==='conserve' ? 1.0 : 0);
}
/** The slick that reaches the flag from here: mediums when they can, hards otherwise. */
export function slickFor(r: Race, lapsLeft: number): Compound {
  return lapsLeft <= tyreLife(r, 'medium') * 0.9 ? 'medium' : 'hard';
}
/** Laps before this set falls away at the car's current pace mode. */
export function lapsLeftOn(r: Race, car: Car) {
  const rate = car.mode==='push' ? 1.3 : car.mode==='conserve' ? 0.73 : 1;
  return Math.max(0, (0.95-car.wear)*tyreLife(r,car.compound)/rate);
}
/** Rival teams' pit wall: wear-based stops, a cheap stop under the safety car, and the weather crossover. */
function rivalCall(r: Race, car: Car): Compound | null {
  const left = r.config.totalLaps - car.distance;
  if (left <= 3) return null;
  const wet = wetness(r);
  if (r.config.weather) {
    // Each rival reads the crossover a little differently, so the field does not switch as one.
    const hesitation = raceRandom(r.seed, car.id, 0, 5) * 0.12;
    if (car.compound !== 'inter' && wet > 0.3 + hesitation) return 'inter';
    if (car.compound === 'inter') return wet < 0.2 - hesitation ? slickFor(r, left) : car.wear > 0.89 ? 'inter' : null;
  }
  // Where passing is nearly impossible, track position is worth more than a cheap stop:
  // rivals only take the safety-car stop if their tyres will not make the flag.
  if (r.flag==='safety' && r.config.overtake >= 1.5) return car.wear > 0.89 || lapsLeftOn(r, car) < left ? slickFor(r, left) : null;
  return car.wear > (r.flag==='safety' ? 0.5 : 0.89) ? slickFor(r, left) : null;
}
// One simulation second per tick. Rendering speed never changes the RNG sequence.
export function step(r: Race) {
  if (r.status !== 'running') return;
  r.elapsed++; r.tick++;
  const cfg = r.config;
  for (const sc of cfg.safety) {
    if (r.elapsed===sc.start) { r.flag='safety'; r.safetyTriggered=true; r.events.push({at:r.elapsed,type:'safety'}); }
    if (r.elapsed===sc.ending) r.events.push({at:r.elapsed,type:'safety-ending'});
    if (r.elapsed===sc.end) { r.flag='green'; r.safetyEnded=true; r.events.push({at:r.elapsed,type:'green'}); }
  }
  const wet = wetness(r);
  const sorted = order(r);
  const leaderSector = Math.floor(sorted[0].distance * 3);
  const finishing: Car[] = [];
  for (let i=0;i<sorted.length;i++) {
    const car = sorted[i];
    if (car.finishedAt !== null) continue;
    if (car.pitRemaining>0) { car.pitRemaining--; if(car.pitRemaining===0) r.events.push({at:r.elapsed,type:'pit-exit',car:car.id}); continue; }
    const previous = car.distance;
    const noise = (raceRandom(r.seed,car.id,r.tick,0)-0.5)*0.4;
    let advance = 1 / (lapPace(car,r)+noise) * (r.flag==='safety' ? (i>0 && sorted[i-1].distance-car.distance>0.025 ? 0.74 : 0.58) : 1);
    // Standing start: everyone accelerates off the grid together.
    if (cfg.startLap === 0 && r.elapsed <= 8) advance *= 0.4 + r.elapsed * 0.075;
    if (car.yieldTo !== null) {
      const mate = r.cars.find(c=>c.id===car.yieldTo)!;
      // Team order: lift until the teammate is through, or abandon it if they drop back or stop.
      if (mate.distance>car.distance || r.elapsed>car.yieldUntil || mate.pitRemaining>0 || mate.finishedAt!==null || car.distance-mate.distance>0.04) car.yieldTo=null;
      else advance *= 0.93;
    }
    const ahead=sorted[i-1];
    if (ahead && ahead.pitRemaining===0 && ahead.finishedAt===null && ahead.yieldTo!==car.id) {
      const gap=ahead.distance-car.distance;
      if(r.flag==='safety') advance=Math.max(0,Math.min(advance,gap-0.009));
      else if(gap>0 && gap<0.016 && lapPace(car,r)>lapPace(ahead,r)-cfg.overtake) advance=Math.max(0,Math.min(advance,gap-0.006));
    }
    car.distance+=advance;
    // Inters overheat and wear fast on a drying line.
    const heat = car.compound==='inter' ? 1 + 3*Math.max(0, 0.3-wet) : 1;
    const ageDelta = advance * (car.mode==='push' ? 1.3 : car.mode==='conserve' ? 0.73 : 1) * (r.flag==='safety' ? 0.55 : 1) * heat;
    car.age+=advance; car.wear=Math.min(1.65,car.wear+ageDelta/tyreLife(r,car.compound));
    if (Math.floor(car.distance*3)>car.sector) { car.sector=Math.floor(car.distance*3); }
    if (car.distance>=cfg.totalLaps) {
      car.finishedAt=r.elapsed-1+(cfg.totalLaps-previous)/Math.max(advance,0.000001); car.distance=cfg.totalLaps;car.yieldTo=null;
      finishing.push(car);
      continue;
    }
    if(Math.floor(car.distance)>Math.floor(previous)) {
      const lapTime=r.elapsed-car.lapStarted;
      if(car.lapStarted>=0) {car.lastLap=lapTime;car.lapTimes.push(lapTime);}
      car.lapStarted=r.elapsed;
      if(!car.player && !car.pitOrder) car.pitOrder=rivalCall(r,car);
      if(car.pitOrder) {
        const slow=raceRandom(r.seed,car.id,car.stops,1)<0.09 ? 3+raceRandom(r.seed,car.id,car.stops,2)*3 : 0;
        car.pitRemaining=Math.ceil(cfg.pitLoss+slow); car.compound=car.pitOrder; car.pitOrder=null; car.age=0;car.wear=0;car.stops++;car.yieldTo=null;
        // A second team car arriving before the first leaves queues behind it.
        const teammate=r.cars.find(c=>c.id!==car.id && c.team===car.team && c.pitRemaining>0);
        const queued=teammate?Math.max(0,teammate.pitRemaining-(cfg.pitLoss-4)):0;
        car.pitRemaining+=queued;
        r.events.push({at:r.elapsed,type:'pit',car:car.id,compound:car.compound,slow,queued});
      }
    }
  }
  // Snapshot the entire field together so stale leader and fresh follower positions cannot produce false zero gaps.
  if (Math.floor(order(r)[0].distance * 3) !== leaderSector) {
    for (const car of r.cars) car.shownDistance = car.distance;
  }
  if (finishing.length) {
    const classified = order(r);
    for (const car of finishing) r.events.push({at:r.elapsed,type:'finish',car:car.id,position:classified.indexOf(car)+1});
  }
  if(r.cars.every(c=>c.finishedAt!==null)) {
    r.status='finished';
    const classified = order(r);
    for(const c of r.cars.filter(c=>c.player)) {
      const pos=classified.indexOf(c)+1, objective=cfg.objectives[c.id===1?1:2];
      // A “beat this rival” goal targets the rival's own position.
      const target=objective.kind==='position'?objective.max:classified.findIndex(x=>x.id===objective.rival)+1;
      c.trust=Math.max(30,Math.min(100,78+(target-pos)*3));
    }
  }
}
export function replay(input: RaceSetup | number, decisions: Race['decisions']) {
  const r=createRace(input);r.status='running';let next=0;
  while(r.status==='running' && r.tick<40000) {
    while(next<decisions.length && decisions[next].at<=r.elapsed) applyCommand(r,decisions[next++].command);
    step(r);
  }
  return r;
}
export function formatTime(n: number) { return `${Math.floor(n/60)}:${(n%60).toFixed(1).padStart(4,'0')}`; }

export function pitLoss(r: Race) { return r.flag==='safety' ? r.config.pitLoss*0.58 : r.config.pitLoss; }
export function pitForecast(r:Race,car:Car) {
  const loss=pitLoss(r);
  const projected=car.distance-loss/lapPace(car,r);
  const traffic=r.cars.filter(c=>c.id!==car.id&&c.finishedAt===null).sort((a,b)=>b.distance-a.distance);
  const position=1+traffic.filter(c=>c.distance>projected).length;
  const ahead=traffic.filter(c=>c.distance>projected).at(-1);
  return {loss,position,ahead:ahead?.code??'clear air',aheadCar:ahead??null,gap:ahead?Math.max(0,(ahead.distance-projected)*lapPace(car,r)):0};
}
