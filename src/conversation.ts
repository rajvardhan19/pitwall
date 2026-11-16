// The pit-wall conversation: turns simulation events into radio lines, keeps track of
// questions the team has asked the player, remembers earlier calls, and answers in
// character. It is presentation only — every race change goes through applyCommand.
import { applyCommand, lapPace, order, pitForecast, pitLoss, playerCar, raceRandom, slickFor, tyreLife as compoundLife, wetness } from './sim.ts';
import type { Car, Command, CommandOutcome, Compound, Race, RaceEvent } from './sim.ts';
import { normalize, parseAnswer, parseIntent } from './intent.ts';
import type { Topic } from './intent.ts';
import {
  callName, currentLap, firstName, gapAhead, gapBehind, lapsOfLife, lapsRemaining, onTarget, placesOff, positionOf, seconds, targetPhrase, trackState,
  tyreLife, tyresReachFinish,
} from './race-view.ts';
import type { BrainSpeaker } from './brain-prompt.ts';
import { scenarioById } from './scenarios.ts';

export type Speaker = 'LAU' | 'REY' | 'STRATEGIST' | 'TYRE SPECIALIST' | 'DATA ENGINEER' | 'RACE CONTROL' | 'PIT CREW' | 'YOU' | 'RADIO';
export type LineKind = 'info' | 'warning' | 'driver' | 'you' | 'question' | 'system';
export interface Line {
  id: number; at: number; speaker: Speaker; text: string; kind: LineKind;
  /** 0 chatter · 1 info · 2 reaction · 3 needs the player now */
  priority: number;
  /** Race seconds after which the line is no longer worth saying out loud. */
  ttl: number;
  voice: boolean;
  question?: number;
}
export type QuestionKind = 'push' | 'box' | 'safety' | 'swap' | 'result' | 'plan';
export interface QuickReply { label: string; reply: string }
export interface Question {
  id: number; kind: QuestionKind; car: 0 | 1 | 2; speaker: Speaker; asked: number; deadline: number; askedWall: number;
  prompt: string; options: QuickReply[]; commands?: Command[];
}
export interface BrainCall { speaker: BrainSpeaker; car: 1 | 2; text: string }

const DRIVER: Record<1 | 2, 'LAU' | 'REY'> = { 1: 'LAU', 2: 'REY' };
const SPEAKER_NAME: Record<Speaker, string> = {
  LAU: 'Theo', REY: 'Nico', STRATEGIST: 'James', 'TYRE SPECIALIST': 'Maya', 'DATA ENGINEER': 'Eli',
  'RACE CONTROL': 'Race control', 'PIT CREW': 'Pit crew', YOU: 'Engineer', RADIO: 'Radio',
};
/** An engineer named at the start of a call: “James, what do you think?” */
function addressee(text: string): BrainSpeaker | null {
  const t = text.trim().toLowerCase();
  return /^(hey )?james\b/.test(t) ? 'STRATEGIST' : /^(hey )?maya\b/.test(t) ? 'TYRE SPECIALIST' : /^(hey )?eli\b/.test(t) ? 'DATA ENGINEER' : null;
}
const RESULT_WAIT_MS = 12000;

function hash(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const numberOf = (car: Car): 1 | 2 => (car.id === 1 ? 1 : 2);

export class Conversation {
  lines: Line[] = [];
  questions: Question[] = [];
  recentCar: number | undefined;
  /** Compound selected on the strategy desk; used when a call does not name one. */
  compound: (car: number) => Compound = () => 'medium';
  brainAvailable: () => boolean = () => false;
  now: () => number = () => Date.now();
  /** Count of questions asked so far; lets the host slow the race when a new one opens. */
  asked = 0;
  /** Simulation speed. Unprompted chatter spreads out at high speed so it never floods the radio. */
  speed = 1;
  /** True while the radio is still speaking earlier lines; unprompted talk waits for a gap. */
  radioBusy: () => boolean = () => false;

  private clarification: {text:string;until:number;reason:'which-car'|'which-tyre'}|null=null;
  private lastTopic: Topic|null=null;
  private chatSpeaker: BrainSpeaker|null=null;
  private teamReplies: {due:number;car:1|2;kind:'tyres'|'gap'|'crew'|'opening-tyres'|'opening-gap'}[]=[];
  private followUps: { due: number; run: (r: Race) => void }[] = [];
  private lastChatter = -999;
  private chatterTurn: 1 | 2 = 2;
  private topicAt = new Map<string, number>();
  private lapSeen: Record<number, number> = { 1: 0, 2: 0 };
  private gapLog: Record<number, { lap: number; stops: number; ahead?: { id: number; s: number; stops: number }; behind?: { id: number; s: number; stops: number } }[]> = { 1: [], 2: [] };
  private closeSince: Record<number, { id: number; since: number } | null> = { 1: null, 2: null };
  private warmUp: Record<number, { at: number; stops: number; done: boolean } | null> = { 1: null, 2: null };
  private safetyAt = -1;
  private seed: number;
  private nextId = 1;
  private cursor = 0;
  private lastOrder: number[] = [];
  private counts = new Map<string, number>();
  private decks = new Map<string, { order: number[]; next: number; round: number }>();
  private done = new Set<string>();
  private started = false;
  private pitInfo = new Map<number, { slow: number; queued: number }>();
  private mem = {
    lastPushAsk: { 1: -999, 2: -999 } as Record<number, number>,
    deniedPush: { 1: -999, 2: -999 } as Record<number, number>,
    lastBoxAsk: { 1: -999, 2: -999 } as Record<number, number>,
    deniedBox: { 1: 0, 2: 0 } as Record<number, number>,
    lastPass: { 1: -999, 2: -999 } as Record<number, number>,
    lastStuck: { 1: -999, 2: -999 } as Record<number, number>,
    lastRivalPit: -999,
    rivalPitLines: 0,
    swapAsked: -999,
    swap: null as null | { yielder: 1 | 2; beneficiary: 1 | 2 },
    ignoredPlans: 0,
    lastCommandAt: { 1: -999, 2: -999 } as Record<number, number>,
    lastPlanEnd: { 1: -999, 2: -999 } as Record<number, number>,
    lastIgnoredPlan: -999,
  };

  constructor(race: Race) {
    this.seed = race.seed;
  }

  // ───────────────────────────── lines and questions ─────────────────────────────

  /**
   * Choose a wording for a line family. Every variant is used once, in a seeded shuffled order, before any
   * repeats, and a new round never opens with the wording that closed the last one.
   */
  private pick(key: string, variants: string[]) {
    let deck = this.decks.get(key);
    if (!deck || deck.order.length !== variants.length || deck.next >= deck.order.length) {
      const round = (deck?.round ?? -1) + 1, order = variants.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(raceRandom(this.seed, 31, (hash(key) % 100000) + round * 7919 + i, 7) * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      if (deck && order.length > 1 && order[0] === deck.order[deck.order.length - 1]) [order[0], order[1]] = [order[1], order[0]];
      deck = { order, next: 0, round };
      this.decks.set(key, deck);
    }
    return variants[deck.order[deck.next++]];
  }

  private once(key: string) {
    if (this.done.has(key)) return false;
    this.done.add(key);
    return true;
  }

  private say(r: Race, speaker: Speaker, text: string, o: { kind?: LineKind; priority?: number; ttl?: number; voice?: boolean; question?: number } = {}) {
    const driver = speaker === 'LAU' || speaker === 'REY';
    const line: Line = {
      id: this.nextId++, at: r.elapsed, speaker, text,
      kind: o.kind ?? (driver ? 'driver' : 'info'), priority: o.priority ?? 1, ttl: o.ttl ?? 25,
      voice: o.voice ?? (speaker !== 'YOU' && speaker !== 'RADIO'), question: o.question,
    };
    this.lines.push(line);
    return line;
  }

  /** A line from outside the conversation (voice errors, model status). Never spoken. */
  system(r: Race, text: string) {
    this.say(r, 'RADIO', text, { kind: 'system', voice: false });
  }

  private ask(r: Race, kind: QuestionKind, car: 0 | 1 | 2, speaker: Speaker, text: string, wait: number, prompt: string, options: QuickReply[], commands?: Command[]) {
    this.questions = this.questions.filter(q => !(q.kind === kind && q.car === car));
    const q: Question = { id: this.nextId++, kind, car, speaker, asked: r.elapsed, deadline: r.elapsed + wait, askedWall: this.now(), prompt, options, commands };
    this.questions.push(q);
    this.asked++;
    this.say(r, speaker, text, { kind: 'question', priority: 3, ttl: wait, question: q.id });
    return q;
  }

  private close(q: Question) {
    this.questions = this.questions.filter(x => x !== q);
    if (q.kind === 'plan' && q.car) this.mem.lastPlanEnd[q.car] = q.asked + Math.max(0, this.lastElapsed - q.asked);
  }

  private openFor(car: 1 | 2) {
    return this.questions.some(q => q.car === car || (q.kind === 'safety' && q.car === 0));
  }

  /** The question a reply most likely answers: one naming the car mentioned, else the newest. */
  focusQuestion(text = ''): Question | undefined {
    if (!this.questions.length) return undefined;
    const intent = parseIntent(text);
    const named = intent.kind === 'command' ? intent.command.car : intent.kind === 'question' || intent.kind === 'unknown' || intent.kind === 'clarify' ? intent.car : undefined;
    return named ? [...this.questions].reverse().find(q => q.car === named || q.car === 0) : this.questions.at(-1);
  }

  // ───────────────────────────── session lifecycle ─────────────────────────────

  start(r: Race) {
    if (this.started) return;
    this.started = true;
    for (const n of [1, 2] as const) this.standing[n] = this.grid[n] = positionOf(r, playerCar(r, n)!);
    if (r.config.startLap === 0) {
      // Season rounds open with the championship picture, then lights out.
      const brief = r.config.setup.brief;
      this.say(r, 'STRATEGIST', brief ? `${brief} Keep it tidy into turn one.` : 'Lights out! Clean start, both of you. Keep it tidy into turn one.', { priority: 2, ttl: 30 });
      return;
    }
    this.say(r, 'STRATEGIST', 'Team, radio check. Theo, Nico. Talk to us.', {priority:2,ttl:40});
    // Then the strategist sets the scene for this particular race.
    const brief = scenarioById(r.config.setup.scenario).opening;
    this.later(r, 3, r => this.say(r, 'STRATEGIST', brief, { priority: 2, ttl: 40 }));
  }

  private grid: Record<number, number> = { 1: 0, 2: 0 };

  private standing: Record<number, number> = { 1: 0, 2: 0 };
  private exitAt: Record<number, number> = { 1: -999, 2: -999 };
  private lastTyreTalk: Record<number, number> = { 1: -999, 2: -999 };

  /** Announce what a position change means — however it happened (pass, rival stop, swap). */
  private settling: Record<number, { pos: number; since: number }> = { 1: { pos: 0, since: 0 }, 2: { pos: 0, since: 0 } };

  private milestones(r: Race, n: 1 | 2, car: Car) {
    const pos = positionOf(r, car), was = this.standing[n];
    // Only announce a position that has held for a few seconds (pit cycles shuffle the order).
    const s = this.settling[n];
    if (s.pos !== pos) { this.settling[n] = { pos, since: r.elapsed }; return; }
    if (!was || pos === was || r.elapsed - s.since < 8) return;
    this.standing[n] = pos;
    // The pit-exit call already gave the position; do not repeat it as a milestone.
    if (r.elapsed - this.exitAt[n] < 20 && pos !== 1) return;
    const name = firstName(car), phrase = targetPhrase(r, n);
    const mate = playerCar(r, n === 1 ? 2 : 1)!, matePos = positionOf(r, mate);
    if (pos + matePos === 3 && mate.finishedAt === null && r.flag === 'green' && this.once('one-two')) {
      const second = pos === 2 ? n : (n === 1 ? 2 : 1);
      this.say(r, 'STRATEGIST', 'One-two! Hold positions, both of you. Bring it home clean.', { priority: 2, ttl: 20 });
      this.later(r, 4, r => this.driverReply(r, second as 1 | 2, second === 2 ? ['Copy… but I’m quicker, just saying.'] : ['Copy. Holding position.']));
      return;
    }
    if (pos === 1 && this.once(`lead-${n}`)) {
      this.say(r, 'DATA ENGINEER', this.pick(`lead-${n}`, [`${name}, you’re leading the race! P1!`, `P1, ${name}! You’re leading!`, `${name}, that’s the lead! Nobody in front of you!`]), { priority: 3, ttl: 20 });
      this.say(r, DRIVER[n], n === 2 ? 'I’m leading?! Let’s go! Keep the calls coming!' : 'Leading. Understood. Let’s manage it from here.', { priority: 2, ttl: 15 });
    } else if (!onTarget(r, n, was) && onTarget(r, n, pos)) {
      this.say(r, 'DATA ENGINEER', this.pick(`target-in-${n}`, [`That’s P${pos}. ${name} is ${phrase.in}.`, `P${pos} for ${name}. That puts him ${phrase.in}.`, `${name} up to P${pos}, ${phrase.in}.`]), { priority: 2, ttl: 20 });
    } else if (onTarget(r, n, was) && !onTarget(r, n, pos)) {
      this.say(r, 'DATA ENGINEER', `${name} drops to P${pos}. ${phrase.out}`, { kind: 'warning', priority: 2, ttl: 20 });
    } else if (n === 2 && pos === 3 && was > 3 && this.once('podium-2')) {
      this.say(r, 'DATA ENGINEER', 'Nico, that’s P3! You’re on the podium!', { priority: 2, ttl: 20 });
    }
  }

  private lastElapsed = 0;

  /** Call after every simulation step. */
  observe(r: Race) {
    this.lastElapsed = r.elapsed;
    while (this.cursor < r.events.length) this.onEvent(r, r.events[this.cursor++]);
    this.detectPasses(r);
    if (r.status === 'running') this.periodic(r);
    this.expire(r);
  }

  /** Call every frame. Handles questions that outlive the simulation (the finish). */
  tick(r: Race) {
    if (r.status !== 'finished') return;
    for (const q of [...this.questions]) {
      if (q.kind === 'result' && this.now() - q.askedWall > RESULT_WAIT_MS) this.timeout(r, q);
      else if (q.kind !== 'result') this.close(q);
    }
    if (!this.questions.length && this.once('closing')) this.closing(r);
  }

  // ───────────────────────────── simulation events ─────────────────────────────

  private onEvent(r: Race, e: RaceEvent) {
    if (e.type === 'safety') {
      this.safetyAt = r.elapsed;
      this.say(r, 'RACE CONTROL', 'Safety car deployed. Debris at turn nine. Pit lane open.', { kind: 'warning', priority: 3, ttl: 30 });
      this.safetyQuestion(r);
    } else if (e.type === 'safety-ending') {
      this.say(r, 'RACE CONTROL', 'Safety car in this lap.', { kind: 'warning', priority: 2, ttl: 20 });
      const nico = playerCar(r, 2)!, theo = playerCar(r, 1)!;
      const driver = nico.finishedAt === null && nico.pitRemaining === 0 ? nico : theo;
      if (driver.pitRemaining === 0) {
        const fresh = driver.wear < 0.35;
        this.say(r, DRIVER[numberOf(driver)], driver.id === 4
          ? (fresh ? this.pick('restart-fresh-2', ['Tyres are warm. I’m ready, let’s go!', 'Fresh rubber, restart coming. I’m going for it!']) : this.pick('restart-old-2', ['Restart on these tyres? This is going to be ugly.', 'These tyres are cold and old. Not ideal for a restart.']))
          : (fresh ? 'Ready for the restart. Tyres are in the window.' : 'Restart on old tyres. I’ll defend where I can.'), { priority: 1, ttl: 15 });
      }
    } else if (e.type === 'green') {
      this.say(r, 'RACE CONTROL', 'Green flag. Racing resumes.', { priority: 2, ttl: 10 });
      const safety = this.questions.find(q => q.kind === 'safety');
      if (safety) this.close(safety);
    } else if (e.type === 'pit') this.onPit(r, e);
    else if (e.type === 'pit-exit') this.onPitExit(r, e.car);
    else if (e.type === 'finish') this.onFinish(r, e.car, e.position);
  }

  private safetyQuestion(r: Race) {
    const available = ([1, 2] as const).map(n => playerCar(r, n)!).filter(c => c.finishedAt === null && c.pitRemaining === 0 && !c.pitOrder);
    if (!available.length) return;
    // Only bring cars a stop could help: worn tyres, or tyres that will not reach the flag.
    const cars = available.filter(c => r.config.totalLaps - c.distance > 3 && (c.wear > 0.3 || !tyresReachFinish(c, r)));
    if (!cars.length) {
      this.say(r, 'STRATEGIST', `Safety car. ${available.length === 2 ? 'Both cars are' : `${firstName(available[0])} is`} on good tyres, so we stay out unless you say otherwise.`, { priority: 2, ttl: 20 });
      return;
    }
    const worth = cars.filter(c => c.wear > 0.45 && r.config.totalLaps - c.distance > 4);
    const advice = worth.length === 2 ? 'I’d box both, Theo first.' : worth.length === 1 ? `I’d box ${firstName(worth[0])}.` : 'Tyres are still good; staying out is fine.';
    const until = Math.min(...cars.map(c => ((Math.ceil(c.distance) - c.distance) * lapPace(c, r)) / 0.6));
    const wait = Math.round(Math.max(20, Math.min(80, until)));
    this.ask(r, 'safety', 0, 'STRATEGIST',
      `Safety car! A stop costs about ${Math.round(r.config.pitLoss * 0.58)} seconds now instead of ${r.config.pitLoss}. ${advice} ${cars.length === 2 ? 'Do we box? Both, one, or stay out?' : `Do we box ${firstName(cars[0])}?`}`,
      wait, 'Safety car: box now?',
      [
        ...(cars.length === 2 ? [{ label: 'Box both', reply: 'box both' }] : []),
        ...cars.map(c => ({ label: `Box ${firstName(c)}`, reply: `box ${firstName(c)}` })),
        { label: 'Stay out', reply: 'no, stay out' },
      ]);
  }

  private onPit(r: Race, e: Extract<RaceEvent, { type: 'pit' }>) {
    const car = r.cars.find(c => c.id === e.car)!;
    if (car.player) {
      const n = numberOf(car);
      this.pitInfo.set(car.id, { slow: e.slow, queued: e.queued });
      for (const q of [...this.questions]) if (q.car === n && (q.kind === 'box' || q.kind === 'push' || q.kind === 'swap')) this.close(q);
      if (e.queued > 0) {
        this.say(r, 'STRATEGIST', `Double stack. ${firstName(car)} has to wait ${Math.round(e.queued)} seconds behind his teammate.`, { kind: 'warning', priority: 2, ttl: 15 });
      } else if (e.slow > 0) {
        this.say(r, 'PIT CREW', this.pick('slow', ['Problem on the rear left! Hold, hold!', 'Wheel gun issue! Hold him!']), { kind: 'warning', priority: 2, ttl: 12 });
      } else if (!this.lines.some(l => l.speaker === 'PIT CREW' && r.elapsed - l.at < 120 && l.text.startsWith(firstName(car)))) {
        this.say(r, 'PIT CREW', `${cap(e.compound)}s ready. In you come.`, { priority: 0, ttl: 8 });
      }
      return;
    }
    // A rival stopping matters when he is fighting one of our cars.
    const rivalPos = positionOf(r, car);
    const ours = ([1, 2] as const).map(n => playerCar(r, n)!).filter(c => c.finishedAt === null && c.pitRemaining === 0);
    const near = ours.map(c => ({ c, d: positionOf(r, c) - rivalPos })).filter(x => Math.abs(x.d) <= 2).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
    if (!near || r.elapsed - this.mem.lastRivalPit < 20 || (r.flag === 'safety' && this.mem.rivalPitLines >= 2)) return;
    this.mem.lastRivalPit = r.elapsed;
    this.mem.rivalPitLines++;
    const ours1 = near.c, name = firstName(ours1), rival = callName(car);
    if (near.d > 0) {
      const gap = (car.distance - ours1.distance) * lapPace(ours1, r);
      const loss = pitLoss(r) + e.slow;
      this.say(r, 'DATA ENGINEER', gap < loss
        ? this.pick('rival-pits-ahead', [`${rival} pits from P${rivalPos}. ${name} should come out ahead of him.`, `${rival}’s in the pits from P${rivalPos}. ${name} stays ahead of him.`, `Box for ${rival}, from P${rivalPos}. That one goes our way, ${name}.`])
        : this.pick('rival-pits-behind', [`${rival} pits from P${rivalPos}. He’ll rejoin ahead of ${name}, but he’s spent his stop.`, `${rival} stops from P${rivalPos}. He’ll come out ahead of ${name}, but his stop is done.`, `${rival} boxes from P${rivalPos}. Still ahead of ${name} after it, with no stop left to make.`]), { priority: 1, ttl: 20 });
    } else {
      const gapBack = (ours1.distance - car.distance) * lapPace(car, r);
      const n = numberOf(ours1);
      if (near.d === -1 && gapBack < 3 && ours1.stops === 0 && ours1.wear > 0.45 && r.config.totalLaps - ours1.distance > 5 && !ours1.pitOrder && r.flag === 'green' && !this.openFor(n) && this.quiet(r)) {
        const compound = this.planCompound(r, ours1);
        this.say(r, 'DATA ENGINEER', `${rival} has just boxed from right behind ${name}. Fresh ${e.compound}s.`, { kind: 'warning', priority: 2, ttl: 20 });
        this.later(r, 3, r => {
          const c = playerCar(r, n)!;
          if (c.pitOrder || c.pitRemaining > 0 || this.openFor(n)) return;
          this.propose(r, n, `If we don’t cover, ${rival} could undercut ${name}. Box ${name} this lap for ${compound}s?`, compound, `James: cover ${rival}? Box ${name}`);
        });
      } else {
        this.say(r, 'DATA ENGINEER', `${rival} pits behind ${name}. Fresh ${e.compound}s. Expect him to come at us late.`, { priority: 1, ttl: 20 });
      }
    }
  }

  private onPitExit(r: Race, id: number) {
    const car = r.cars.find(c => c.id === id)!;
    if (!car.player || car.finishedAt !== null) return;
    const n = numberOf(car);
    this.warmUp[n] = { at: r.elapsed, stops: car.stops, done: false };
    this.later(r, 10, r => {
      const c = playerCar(r, n)!;
      if (c.pitRemaining === 0 && c.finishedAt === null) this.say(r, 'TYRE SPECIALIST', this.pick(`outlap-${n}`, [`${firstName(c)}, new ${c.compound}s need a lap to come in. Careful into turn one.`, `Cold tyres, ${firstName(c)}. Give the ${c.compound}s a lap before you lean on them.`, `${firstName(c)}, easy on the new ${c.compound}s for a lap. They’re not up to temperature yet.`, `Out-lap, ${firstName(c)}. Build the heat into those ${c.compound}s before you push.`]), { priority: 1, ttl: 15 });
    });
    const info = this.pitInfo.get(id) ?? { slow: 0, queued: 0 };
    const pos = positionOf(r, car), ahead = gapAhead(r, car);
    const where = ahead ? `${callName(ahead.car)} is ${seconds(ahead.seconds)} ahead.` : 'Clear air in front.';
    const lost = info.slow + info.queued;
    this.exitAt[n] = r.elapsed;
    this.say(r, 'DATA ENGINEER', lost > 1
      ? `${firstName(car)} out in P${pos}. That stop cost us about ${Math.round(lost)} extra seconds. ${where}`
      : this.pick(`good-stop-${n}`, [`Good stop, ${firstName(car)}. Rejoining P${pos}. ${where}`, `Clean stop, ${firstName(car)}. You’re out in P${pos}. ${where}`, `Nice work from the crew. P${pos}, ${firstName(car)}. ${where}`, `${firstName(car)}, that’s a good one. Back out in P${pos}. ${where}`]), { priority: 2, ttl: 20 });
    if (info.slow > 0) {
      this.say(r, DRIVER[numberOf(car)], car.id === 4
        ? this.pick('slow-exit-2', ['What happened in that stop?!', 'That was so slow! Come on!'])
        : this.pick('slow-exit-1', ['That was slow. Let’s not dwell on it.', 'Lost time there. Let’s get it back.']), { priority: 2, ttl: 15 });
    }
  }

  private onFinish(r: Race, id: number, position: number) {
    const car = r.cars.find(c => c.id === id)!;
    if (!car.player) return;
    const n = numberOf(car);
    this.questions = this.questions.filter(q => q.car !== n);
    const text = n === 2
      ? this.pick('flag-2', ['That’s the flag! I gave it everything. Where did we finish?', 'Chequered flag! Come on, tell me, where are we?'])
      : this.pick('flag-1', ['Chequered flag. Where did we end up?', 'That’s the flag. What’s the result?']);
    this.ask(r, 'result', n, DRIVER[n], text, 20, `${firstName(car)} asks for the result`, [
      { label: `Tell him: P${position}`, reply: `P${position}${onTarget(r, n, position) ? ', great job' : ''}` },
    ]);
  }

  private resultReaction(r: Race, n: 1 | 2, told: boolean) {
    const car = playerCar(r, n)!;
    const pos = positionOf(r, car), hit = onTarget(r, n, pos), title = r.config.objectives[n].kind === 'beat';
    if (!told) {
      this.say(r, 'DATA ENGINEER', hit ? `That’s P${pos}, ${firstName(car)}. P${pos}!` : `P${pos}, ${firstName(car)}. Sorry, mate.`, { priority: 3, ttl: 30 });
    }
    const text = n === 2
      ? pos === 1 ? 'We won it?! P1! What a strategy, guys!' : pos <= 3 ? `P${pos}! Yes! What a strategy, guys, what a strategy!` : hit ? `P${pos}! Job done! Thank you, everyone!` : `P${pos}… That hurts. We had more than that today.`
      : title ? (hit ? 'We did it. Champions! Thank you, everyone. Thank you.' : `Not enough today. Congratulations to him. We’ll come back stronger.`)
        : pos === 1 ? 'We won it! Fantastic job on the wall. Fantastic.' : hit && pos <= 3 ? 'Podium. Good work today, everyone. Thank you.' : hit ? `P${pos}. Job done. Good work, everyone.` : `P${pos}. Not what we wanted. We’ll learn from it.`;
    this.say(r, DRIVER[n], text, { kind: 'driver', priority: 3, ttl: 40 });
    if (r.status === 'finished' && this.once('closing') && !this.questions.some(q => q.kind === 'result')) this.closing(r);
  }

  private closing(r: Race) {
    const a = positionOf(r, playerCar(r, 1)!), b = positionOf(r, playerCar(r, 2)!);
    const hits = Number(onTarget(r, 1, a)) + Number(onTarget(r, 2, b));
    this.say(r, 'STRATEGIST', hits === 2
      ? `Theo P${a}, Nico P${b}. Both targets met. Great calls today. The debrief is ready.`
      : hits === 1 ? `Theo P${a}, Nico P${b}. One target out of two. Let’s see what we could have done better in the debrief.`
        : `Theo P${a}, Nico P${b}. Tough one. The debrief will show us where it went.`, { priority: 1, ttl: 60 });
  }

  // ───────────────────────────── on-track reactions ─────────────────────────────

  private detectPasses(r: Race) {
    const now = order(r).map(c => c.id);
    const before = this.lastOrder;
    this.lastOrder = now;
    if (!before.length || r.flag === 'safety') return;
    for (const n of [1, 2] as const) {
      const car = playerCar(r, n)!;
      if (car.finishedAt !== null || car.pitRemaining > 0) continue;
      const was = before.indexOf(car.id), is = now.indexOf(car.id);
      if (was === is) continue;
      const byId = (id: number) => r.cars.find(c => c.id === id)!;
      if (is < was) {
        const passed = before.slice(is, was).map(byId).filter(c => now.indexOf(c.id) > is && c.pitRemaining === 0 && c.finishedAt === null);
        if (passed.length) this.gained(r, n, car, passed[0]);
      } else {
        const by = now.slice(was, is).map(byId).filter(c => before.indexOf(c.id) > was && c.pitRemaining === 0);
        if (by.length) this.lost(r, n, car, by[0]);
      }
    }
  }

  private gained(r: Race, n: 1 | 2, car: Car, passed: Car) {
    if (passed.player) {
      const swap = this.mem.swap;
      if (swap && swap.beneficiary === n) {
        this.mem.swap = null;
        const next = gapAhead(r, car);
        this.say(r, DRIVER[n], n === 2 ? `Thanks, Theo! ${next ? `Going after ${callName(next.car)} now.` : 'Let’s go!'}` : 'Thanks, Nico. Appreciated.', { priority: 2, ttl: 15 });
      } else {
        this.say(r, DRIVER[n], n === 2 ? 'Sorry, Theo! I’m through!' : 'Past Nico. I had the pace.', { priority: 1, ttl: 12 });
      }
      this.mem.lastPass[n] = r.elapsed;
      return;
    }
    if (r.elapsed - this.mem.lastPass[n] >= 20) {
      this.mem.lastPass[n] = r.elapsed;
      const rival = callName(passed);
      this.say(r, DRIVER[n], n === 2
        ? this.pick('pass-2', [`Got him! ${rival}’s behind!`, `Yes! Past ${rival}!`, `See you, ${rival}!`, `Move over, ${rival}! I’m through!`])
        : this.pick('pass-1', [`Past ${rival}.`, `Done. ${rival} is behind.`, `That’s ${rival} dealt with.`]), { priority: 2, ttl: 12 });
    }
  }

  private lost(r: Race, n: 1 | 2, car: Car, by: Car) {
    if (by.player) {
      if (this.mem.swap && this.mem.swap.yielder === n) return;
      this.mem.lastPass[n] = r.elapsed;
      this.say(r, DRIVER[n], n === 1 ? 'Nico’s through. Fine, he’s quicker today.' : 'Theo’s past me. Okay.', { priority: 1, ttl: 12 });
      return;
    }
    if (r.elapsed - this.mem.lastPass[n] >= 45) {
      this.mem.lastPass[n] = r.elapsed;
      const rival = callName(by);
      const fresher = by.age + 3 < car.age;
      this.say(r, DRIVER[n], n === 2
        ? this.pick('lost-2', [`${rival} got me! I had nothing on the exit!`, `No, no, no! ${rival} is through!`, `${rival} just drove past me! ${fresher ? 'His tyres are so much fresher.' : 'I need more grip!'}`])
        : this.pick('lost-1', [`${rival} is through. ${fresher ? 'He’s quicker on fresher tyres.' : 'I couldn’t hold him.'}`, `Lost a place to ${rival}.`]), { priority: 2, ttl: 12 });
    }
  }

  // ───────────────────────────── proactive calls ─────────────────────────────

  private periodic(r: Race) {
    const t = r.elapsed;
    this.deliverTeamReplies(r);
    this.runFollowUps(r);
    if((t===8||t===28)&&r.config.startLap>0){
      const n=t===8?1:2,car=playerCar(r,n)!;
      if(car.pitRemaining===0&&!car.pitOrder){
        this.say(r,DRIVER[n],n===1?'Loud and clear. Starting to lose grip. Maya, what are you seeing?':'Radio is good. Eli, what’s the gap ahead?',{priority:2,ttl:35});
        this.teamReplies.push({due:t+8,car:n,kind:n===1?'opening-tyres':'opening-gap'});
      }
    }
    // A quiet team still checks in. Four spaced, state-based exchanges per race;
    // never talk over an unanswered decision or pretend to feel tyres in the pit lane.
    if([100,220,550,850].includes(t)&&!this.questions.length){
      const n=t===100||t===550?2:1,car=playerCar(r,n)!;
      if(car.finishedAt===null&&car.pitRemaining===0&&!car.pitOrder){
        const me=firstName(car);
        const report=tyresReachFinish(car, r)
          ?this.pick(`report-ok-${n}`,[`${me} here. Tyres feel manageable. Can we make these last?`,n===2?`Tyres are still alive! Can these go to the end?`:`Tyres are holding up. Are we going to the end on these?`,n===2?`Grip is still there. Do I need to stop again?`:`Feeling consistent. Is the plan to run these to the flag?`])
          :car.wear<0.4
            ?this.pick(`report-fresh-${n}`,[`${me} here. Tyres feel good for now. How long can we run these?`,n===2?`These feel great! How long do I get on them?`:`Good grip on these. What’s the target lap for the stop?`])
            :this.pick(`report-worn-${n}`,[`${me} here. Grip is falling away. How long have we got on these?`,n===2?`The rears are going! How many laps are left in these?`:`Tyres are fading now. How long do they have?`,n===2?`I’m sliding a lot. When are we stopping?`:`Grip’s going off. When’s the stop?`]);
        this.say(r,DRIVER[n],report,{priority:1,ttl:35});
        this.teamReplies.push({due:t+8,car:n,kind:'tyres'});
      }
    }
    this.weatherTalk(r);
    for (const n of [1, 2] as const) {
      const car = playerCar(r, n)!;
      if (car.finishedAt !== null || car.pitRemaining > 0) continue;
      this.laps(r, n, car);
      this.milestones(r, n, car);
      this.tyreCalls(r, n, car);
      this.pushCalls(r, n, car);
      this.finalLaps(r, n, car);
    }
    this.swapCall(r);
    this.proposals(r);
    this.chatter(r);
  }

  private deliverTeamReplies(r:Race){
    const due=this.teamReplies.filter(x=>x.due<=r.elapsed);
    this.teamReplies=this.teamReplies.filter(x=>x.due>r.elapsed);
    for(const reply of due){
      const car=playerCar(r,reply.car)!;if(car.finishedAt!==null)continue;
      const name=firstName(car);
      if(reply.kind==='crew'){
        if(car.pitOrder)this.say(r,'PIT CREW',this.pick(`crew-${reply.car}`,[`${name}, crew ready. ${cap(car.pitOrder)}s on the trolley. See you this lap.`,`${cap(car.pitOrder)}s out and warm, ${name}. We’re ready for you.`,`Crew’s in position, ${name}. ${cap(car.pitOrder)}s waiting.`,`${name}, ${car.pitOrder}s ready in the box. Hit your marks.`]),{priority:2,ttl:20});
        continue;
      }
      if(car.pitRemaining>0||car.pitOrder)continue;
      if(reply.kind==='opening-tyres'){
        this.say(r,'TYRE SPECIALIST','Copy, Theo. We see the wear. Working on your pit window.',{priority:2,ttl:30});
      }else if(reply.kind==='opening-gap'){
        const ahead=gapAhead(r,car);
        this.say(r,'DATA ENGINEER',ahead?`${name}, ${callName(ahead.car)} is ${seconds(ahead.seconds)} ahead.`:`${name}, clear air. You’re leading.`,{priority:2,ttl:25});
      }else if(reply.kind==='tyres'){
        this.lastTyreTalk[reply.car]=r.elapsed;
        if(!tyresReachFinish(car, r)&&car.wear<0.4){this.say(r,'TYRE SPECIALIST',`About ${plural(Math.floor(lapsOfLife(car, r)),'lap')} in those ${car.compound}s, ${name}. We’ll plan the stop around lap ${currentLap(r)+Math.floor(lapsOfLife(car, r)*0.85)}.`,{priority:2,ttl:30});continue;}
        this.say(r,'TYRE SPECIALIST',tyresReachFinish(car, r)?this.pick(`maya-reach-${reply.car}`,[`Copy, ${name}. ${tyreLife(car)} percent left. At this pace, these reach the flag.`,`${tyreLife(car)} percent left, ${name}. That’s enough for the flag at this pace.`,`${name}, ${tyreLife(car)} percent. They’ll go the distance if you hold this pace.`,`Plenty left, ${name}. ${tyreLife(car)} percent, and ${plural(lapsRemaining(car, r),'lap')} to go.`]):(Math.floor(lapsOfLife(car, r))<1?`We see it, ${name}. Those ${car.compound}s are finished. We need another set.`:`We see it, ${name}. About ${plural(Math.floor(lapsOfLife(car, r)),'lap')} left in those ${car.compound}s. We need another set.`),{priority:2,ttl:30});
      }else{
        const ahead=gapAhead(r,car);
        this.say(r,'DATA ENGINEER',ahead?`${name}, ${callName(ahead.car)} is ${seconds(ahead.seconds)} ahead. You’re P${positionOf(r,car)}.`:`${name}, clear air. You’re leading.`,{priority:2,ttl:20});
      }
    }
  }

  private tyreCalls(r: Race, n: 1 | 2, car: Car) {
    const left = r.config.totalLaps - car.distance, name = firstName(car);
    if (!car.pitOrder && car.wear >= 0.78 && left > 2 && r.flag === 'green' && !this.openFor(n) && this.quiet(r) && r.elapsed - this.lastTyreTalk[n] > 60 && this.once(`cliff-${n}-${car.stops}`)) {
      // The tyre engineer flags it to the strategist, who brings the decision to you.
      const life = Math.floor(lapsOfLife(car, r));
      this.say(r, 'TYRE SPECIALIST', this.pick(`cliff-${n}`, [`James, ${name}’s ${car.compound}s are at the cliff. About ${plural(life, 'lap')} of grip left, and ${plural(Math.ceil(left), 'lap')} to go.`, `James, ${name} is nearly out of tyre. ${plural(life, 'lap')} of grip in those ${car.compound}s, ${plural(Math.ceil(left), 'lap')} to go.`, `Warning on ${name}’s ${car.compound}s, James. ${cap(plural(life, 'lap'))} before they drop off, with ${plural(Math.ceil(left), 'lap')} left.`]), { kind: 'warning', priority: 2, ttl: 30 });
      this.later(r, 5, r => {
        const c = playerCar(r, n)!;
        if (c.pitOrder || c.pitRemaining > 0 || c.finishedAt !== null || this.openFor(n)) return;
        if (tyresReachFinish(c, r)) { this.say(r, 'STRATEGIST', `Copy, Maya. They should just make the flag if ${name} is gentle. We stay out.`, { priority: 1, ttl: 20 }); return; }
        if (this.rainSoon(r)) { this.say(r, 'STRATEGIST', `Copy, Maya. Rain is minutes away. We stretch ${name}’s tyres and go straight to inters.`, { priority: 1, ttl: 20 }); return; }
        const compound = this.planCompound(r, c);
        if (!this.settled(r, n)) { this.say(r, 'STRATEGIST', `Copy, Maya. ${name} needs ${compound}s soon. Your call, engineer.`, { priority: 1, ttl: 20 }); return; }
        this.propose(r, n, `Copy, Maya. Engineer, I’d box ${name} this lap for ${compound}s. Box him?`, compound, `James: box ${name} for ${compound}s?`);
      });
    }
    if (car.mode === 'push' && car.wear > 0.85 && left > 3 && this.once(`pushwear-${n}-${car.stops}`)) {
      this.say(r, 'TYRE SPECIALIST', `${name} has been pushing and the tyres are fading. ${tyresReachFinish(car, r) ? 'They should still make it.' : 'They won’t make the finish at this rate.'}`, { kind: 'warning', priority: 2, ttl: 30 });
    }
    const asks = this.counts.get(`box-asks-${n}-${car.stops}`) ?? 0;
    if (!car.pitOrder && car.wear > 0.95 && left > 2 && asks < 3 && !this.openFor(n) && this.quiet(r) && r.elapsed - this.mem.lastBoxAsk[n] > 150 * Math.max(1, asks)) {
      this.mem.lastBoxAsk[n] = r.elapsed;
      this.counts.set(`box-asks-${n}-${car.stops}`, asks + 1);
      const again = this.mem.deniedBox[n] > 0;
      const compound = this.compound(n);
      const text = n === 2
        ? again ? this.pick('box-again-2', ['Still on these? I’m losing seconds every lap! Box me!', 'Please, these tyres are dead! Can we box now?']) : this.pick('box-2', ['These tyres are finished! Box me, come on!', 'I’ve got nothing left! Can we box?'])
        : again ? 'These tyres are costing us a lot of time. Box this lap?' : this.pick('box-1', ['Fronts are gone. I’m losing time in every corner. Box this lap?', 'The tyres are done. I recommend we box.']);
      this.ask(r, 'box', n, DRIVER[n], text, 40, `${name}: box for ${compound}s?`, [
        { label: `Box · ${compound}s`, reply: 'yes, box' },
        { label: 'Stay out', reply: 'no, stay out' },
      ]);
    }
  }

  /** Proactive questions wait until no other question was asked in the last few seconds. */
  private quiet(r: Race) {
    return !this.lines.some(l => l.kind === 'question' && r.elapsed - l.at < 12);
  }

  private boxRefused(r: Race, n: 1 | 2, answered = false) {
    const car = playerCar(r, n)!;
    const asks = this.counts.get(`box-asks-${n}-${car.stops}`) ?? 0;
    const text = asks >= 3
      ? (n === 2 ? 'Fine. I’ll drive these to the flag. Somehow.' : 'Understood. I’ll nurse them to the end.')
      : answered
        ? (n === 2 ? this.pick('box-no-2', ['Seriously?! Okay, okay. I’ll try.', 'Staying out on these? You’re killing me.']) : this.pick('box-no-1', ['Understood. I’ll manage them.', 'Copy. I’ll make them last.']))
        : (n === 2 ? this.pick('box-timeout-2', ['No answer? I’m a sitting duck out here!', 'Hello? Anyone? These tyres are gone!']) : this.pick('box-timeout-1', ['No call. Staying out, but it’s costing us.', 'Nothing from the wall. I’ll keep going.']));
    this.say(r, DRIVER[n], text, { priority: 2, ttl: 12 });
  }

  /** The first lap of a full race: the field is still sorting itself out. */
  private opening(r: Race) {
    return r.config.startLap === 0 && r.elapsed < r.config.lapTime * 1.3;
  }

  private pushCalls(r: Race, n: 1 | 2, car: Car) {
    if (this.opening(r)) return;
    if (r.flag !== 'green' || car.pitOrder || car.mode === 'push' || this.openFor(n) || !this.quiet(r)) return;
    const left = r.config.totalLaps - car.distance, t = r.elapsed;
    if (left < 1.5 || t - this.mem.lastPushAsk[n] < (n === 2 ? 150 : 240) || t - this.mem.deniedPush[n] < 240) return;
    const pushLife = ((0.95 - car.wear) * compoundLife(r, car.compound)) / 1.3;
    const ahead = gapAhead(r, car);
    let text: string | null = null;
    if (car.mode === 'conserve' && left < 9 && pushLife >= left) {
      text = n === 2 ? 'I’ve saved the tyres like you asked. Can I push now?' : 'Tyres feel good. We saved enough. I can push if you want.';
    } else if (ahead && !ahead.car.player && ahead.car.pitRemaining === 0 && ahead.seconds > 0.2 && ahead.seconds < (n === 2 ? 1.5 : 1.0) && car.wear < 0.9) {
      const rival = callName(ahead.car), gap = seconds(ahead.seconds);
      text = n === 2
        ? this.pick('push-2', [`I’m right behind ${rival}. ${gap} seconds. Let me push!`, `${rival} is slow in the last sector. Can I go?`, `I’m faster than ${rival}! Can I push?`])
        : this.pick('push-1', [`${rival} is ${gap} ahead. I can attack, but it costs tyre. Your call.`, `Within a second of ${rival}. Do we go for it?`]);
    }
    if (!text) return;
    this.mem.lastPushAsk[n] = t;
    this.ask(r, 'push', n, DRIVER[n], text, 30, `${firstName(car)} wants to push`, [
      { label: 'Push', reply: 'yes, push' },
      { label: 'Hold', reply: 'no, hold' },
    ]);
  }

  private finalLaps(r: Race, n: 1 | 2, car: Car) {
    const left = lapsRemaining(car, r);
    if (left <= 5 && this.once(`five-${n}`)) {
      if (this.once('five-summary')) {
        const a = positionOf(r, playerCar(r, 1)!), b = positionOf(r, playerCar(r, 2)!);
        const need = ([1, 2] as const).map(k => { const off = placesOff(r, k, k === 1 ? a : b); return off ? `${k === 1 ? 'Theo' : 'Nico'} needs ${plural(off, 'place')} ${targetPhrase(r, k).need}` : ''; }).filter(Boolean).join(', and ');
        this.say(r, 'STRATEGIST', `Five laps to go. Theo P${a}, Nico P${b}. ${need ? need + '.' : 'Both on target. Bring them home.'}`, { priority: 2, ttl: 30 });
      }
      const pos = positionOf(r, car), pushLife = ((0.95 - car.wear) * compoundLife(r, car.compound)) / 1.3;
      if (!onTarget(r, n, pos) && car.mode !== 'push' && pushLife >= left - 0.5 && !this.openFor(n) && r.flag === 'green') {
        this.mem.lastPushAsk[n] = r.elapsed;
        this.ask(r, 'push', n, n === 2 ? 'REY' : 'STRATEGIST',
          n === 2 ? `Five laps. The tyres have ${tyreLife(car)}% left. Let me go for it!` : `Five to go and Theo needs ${plural(placesOff(r, 1, pos), 'place')}. Tyres have ${tyreLife(car)}% left. Push to the end?`,
          30, `Push ${firstName(car)} to the end?`, [{ label: 'Push', reply: 'yes, push' }, { label: 'Hold', reply: 'no, hold' }]);
      }
    }
    if (car.distance >= r.config.totalLaps - 1 && this.once(`last-${n}`)) {
      const ahead = gapAhead(r, car), behind = gapBehind(r, car), name = firstName(car);
      const text = ahead && ahead.seconds < 1.5 && !ahead.car.player
        ? `Last lap, ${name}. ${callName(ahead.car)} is ${seconds(ahead.seconds)} ahead. One chance.`
        : behind && behind.seconds < 1.5 && !behind.car.player
          ? `Last lap, ${name}. ${callName(behind.car)} is ${seconds(behind.seconds)} behind. Defend.`
          : `Last lap, ${name}. Bring it home.`;
      this.say(r, 'DATA ENGINEER', text, { priority: 2, ttl: 20 });
    }
  }

  private swapCall(r: Race) {
    // A team order the simulation abandoned (gap opened, timeout) no longer blocks new ones.
    if (this.mem.swap && playerCar(r, this.mem.swap.yielder)!.yieldTo === null) this.mem.swap = null;
    if (r.flag !== 'green' || r.elapsed - this.mem.swapAsked < 300 || this.mem.swap) return;
    const a = playerCar(r, 1)!, b = playerCar(r, 2)!;
    if ([a, b].some(c => c.finishedAt !== null || c.pitRemaining > 0 || c.pitOrder) || this.openFor(1) || this.openFor(2) || !this.quiet(r)) return;
    const sorted = order(r), ia = sorted.indexOf(a), ib = sorted.indexOf(b);
    if (Math.abs(ia - ib) !== 1) return;
    const [lead, follow] = ia < ib ? [a, b] : [b, a];
    const gap = (lead.distance - follow.distance) * lapPace(follow, r);
    const delta = lapPace(lead, r) - lapPace(follow, r);
    if (gap > 1.2 || delta < 0.3 || r.config.totalLaps - follow.distance < 3) return;
    this.mem.swapAsked = r.elapsed;
    const yielder = numberOf(lead);
    const text = follow.id === 4
      ? `I’m ${seconds(delta)} a lap quicker than Theo! Let me through!`
      : `Theo is ${seconds(delta)} a lap quicker and stuck behind Nico. Do we swap them?`;
    this.ask(r, 'swap', yielder, follow.id === 4 ? 'REY' : 'STRATEGIST', text, 30, `Swap: ${firstName(lead)} lets ${firstName(follow)} through?`, [
      { label: 'Swap them', reply: 'yes, swap them' },
      { label: 'Let them race', reply: 'no, let them race' },
    ], [{ car: yielder, action: 'swap' }]);
  }

  private expire(r: Race) {
    for (const q of [...this.questions]) {
      const car = q.car ? playerCar(r, q.car)! : null;
      // Questions the race has already answered quietly close.
      if (q.kind === 'push' && car && (car.mode === 'push' || car.pitRemaining > 0)) { this.close(q); continue; }
      if ((q.kind === 'box' || q.kind === 'plan') && car && (car.pitOrder || car.pitRemaining > 0)) { this.close(q); continue; }
      if (q.kind === 'safety' && r.flag === 'green') { this.close(q); continue; }
      if (r.elapsed >= q.deadline) this.timeout(r, q);
    }
  }

  private timeout(r: Race, q: Question) {
    this.close(q);
    const n = q.car as 1 | 2;
    if (q.kind !== 'result') { this.mem.ignoredPlans++; this.mem.lastIgnoredPlan = r.elapsed; }
    if (q.kind === 'push') {
      this.mem.deniedPush[n] = r.elapsed;
      if (q.speaker === 'STRATEGIST') this.say(r, 'STRATEGIST', 'No call. Theo holds his pace.', { priority: 1, ttl: 12 });
      else this.say(r, DRIVER[n], n === 2 ? this.pick('push-timeout-2', ['Hello? …Fine, I’ll hold for now.', 'Nothing? Okay, holding.']) : 'No call. I’ll keep it steady.', { priority: 1, ttl: 12 });
    } else if (q.kind === 'box') {
      this.mem.deniedBox[n]++;
      this.boxRefused(r, n);
    } else if (q.kind === 'safety') {
      const pitted = ([1, 2] as const).filter(k => { const c = playerCar(r, k)!; return c.pitOrder || c.pitRemaining > 0; });
      if (!pitted.length) this.say(r, 'STRATEGIST', 'No call. Both cars stay out. That’s a big chance gone.', { priority: 2, ttl: 15 });
    } else if (q.kind === 'swap') {
      this.say(r, 'STRATEGIST', this.pick('swap-none', ['No call, so they race. Keep it clean, both of you.', 'No team orders. Race each other, but no contact.', 'They’re free to race. Give each other room.']), { priority: 1, ttl: 12 });
    } else if (q.kind === 'plan') {
      const name = firstName(playerCar(r, n)!);
      this.say(r, 'STRATEGIST', this.pick('plan-timeout', [`No call. ${name} stays out for now.`, `Nothing from you, so ${name} stays out.`, `No answer. We leave ${name} out and keep watching.`]), { priority: 1, ttl: 12 });
    } else if (q.kind === 'result') {
      this.resultReaction(r, n, false);
    }
  }

  // ───────────────────────────── team chatter and proposals ─────────────────────────────

  private later(r: Race, delay: number, run: (r: Race) => void) {
    this.followUps.push({ due: r.elapsed + delay, run });
  }

  private runFollowUps(r: Race) {
    if (!this.followUps.some(f => f.due <= r.elapsed)) return;
    const due = this.followUps.filter(f => f.due <= r.elapsed);
    this.followUps = this.followUps.filter(f => f.due > r.elapsed);
    for (const f of due) f.run(r);
  }

  private fresh(r: Race, key: string, gap: number) {
    return r.elapsed - (this.topicAt.get(key) ?? -99999) >= gap;
  }

  private mark(r: Race, key: string) {
    this.topicAt.set(key, r.elapsed);
    this.lastChatter = r.elapsed;
  }

  /** Room for unprompted talk: nothing waiting on the player, nobody mid-sentence, and spacing that stretches at high sim speed. */
  private chatterWindow(r: Race) {
    if (this.questions.length || r.status !== 'running' || this.radioBusy()) return false;
    if (r.elapsed - this.lastChatter < Math.max(30, 12 * this.speed)) return false;
    const last = [...this.lines].reverse().find(l => l.voice);
    return !last || r.elapsed - last.at >= 6;
  }

  private planCompound(r: Race, car: Car): Compound {
    const left = r.config.totalLaps - car.distance;
    if (wetness(r) > 0.3) return 'inter';
    return left <= 9 ? 'soft' : slickFor(r, left);
  }

  /** A strategy call the team recommends. The player decides; nothing happens without an answer. */
  /** The player has not just made a call for this car, and the team has not just asked about it. */
  private settled(r: Race, n: 1 | 2) {
    return r.elapsed - this.mem.lastCommandAt[n] >= 30 && r.elapsed - this.mem.lastPlanEnd[n] >= 90;
  }

  private propose(r: Race, n: 1 | 2, text: string, compound: Compound, prompt: string) {
    // A player who has let two proposals lapse gets advice, not more questions, for a while.
    if (this.mem.ignoredPlans >= 2 && r.elapsed - this.mem.lastIgnoredPlan < 300) {
      this.say(r, 'STRATEGIST', `For the record, I’d box ${firstName(playerCar(r, n)!)} for ${compound}s. Your call whenever you’re ready.`, { priority: 1, ttl: 20 });
      return;
    }
    this.ask(r, 'plan', n, 'STRATEGIST', text, 30, prompt, [
      { label: `Box · ${compound}s`, reply: 'yes' },
      { label: 'Stay out', reply: 'no' },
    ], [{ car: n, action: 'pit', compound }]);
  }

  /** Record gaps at each completed lap so the team can talk about trends, not just snapshots. */
  private laps(r: Race, n: 1 | 2, car: Car) {
    const ahead = gapAhead(r, car);
    const close = ahead && !ahead.car.player && ahead.car.pitRemaining === 0 && ahead.seconds < 1 ? ahead.car.id : null;
    if (close === null) this.closeSince[n] = null;
    else if (this.closeSince[n]?.id !== close) this.closeSince[n] = { id: close, since: r.elapsed };
    if (car.lapTimes.length === this.lapSeen[n]) return;
    this.lapSeen[n] = car.lapTimes.length;
    const behind = gapBehind(r, car);
    const log = this.gapLog[n];
    log.push({
      lap: car.lapTimes.length, stops: car.stops,
      ahead: ahead && !ahead.car.player && ahead.car.pitRemaining === 0 ? { id: ahead.car.id, s: ahead.seconds, stops: ahead.car.stops } : undefined,
      behind: behind && !behind.car.player && behind.car.pitRemaining === 0 ? { id: behind.car.id, s: behind.seconds, stops: behind.car.stops } : undefined,
    });
    if (log.length > 3) log.shift();
    if (r.config.startLap === 0 && car.lapTimes.length === 1 && this.once(`start-${n}`)) this.startReview(r, n, car);
    const warm = this.warmUp[n];
    if (warm && !warm.done && car.stops === warm.stops && r.elapsed - warm.at > 30) {
      warm.done = true;
      this.say(r, 'TYRE SPECIALIST', this.pick(`window-${n}`, [`${firstName(car)}, the tyres are in the window now. Go.`, `Tyres are up to temperature, ${firstName(car)}. Push when you’re ready.`, `${firstName(car)}, warm-up done. Full grip from here.`, `Temps are good, ${firstName(car)}. You can lean on them now.`]), { priority: 1, ttl: 20 });
    }
  }

  /** Lap-on-lap gap change to the same cars, ignoring laps where anyone stopped. Positive delta = closing. */
  private trend(n: 1 | 2) {
    const log = this.gapLog[n];
    if (log.length < 2) return null;
    const [a, b] = log.slice(-2);
    if (a.stops !== b.stops) return null;
    const same = (x?: { id: number; s: number; stops: number }, y?: { id: number; s: number; stops: number }) => x && y && x.id === y.id && x.stops === y.stops;
    return {
      lap: b.lap,
      ahead: same(a.ahead, b.ahead) ? { id: b.ahead!.id, s: b.ahead!.s, delta: a.ahead!.s - b.ahead!.s } : null,
      behind: same(a.behind, b.behind) ? { id: b.behind!.id, s: b.behind!.s, delta: a.behind!.s - b.behind!.s } : null,
    };
  }

  private chatter(r: Race) {
    if (r.flag === 'safety') return this.safetyChatter(r);
    if (!this.chatterWindow(r)) return;
    this.chatterTurn = this.chatterTurn === 1 ? 2 : 1;
    for (const n of [this.chatterTurn, this.chatterTurn === 1 ? 2 : 1] as (1 | 2)[]) {
      const car = playerCar(r, n)!;
      if (car.finishedAt !== null || car.pitRemaining > 0 || car.pitOrder) continue;
      if (this.trendTalk(r, n, car) || this.lapTalk(r, n, car) || this.stuckTalk(r, n, car) || this.teammateTalk(r, n, car)) return;
    }
    if (this.summaryTalk(r)) return;
    if (this.fieldTalk(r)) return;
    this.fillerTalk(r);
  }

  /** After a quiet minute, someone checks in: a battle update from Eli, or a driver on how the car feels. */
  private fillerTalk(r: Race) {
    const last = [...this.lines].reverse().find(l => l.voice);
    if (last && r.elapsed - last.at < 60) return false;
    for (const n of [this.chatterTurn, this.chatterTurn === 1 ? 2 : 1] as (1 | 2)[]) {
      const car = playerCar(r, n)!;
      if (car.finishedAt !== null || car.pitRemaining > 0 || !this.fresh(r, `filler-${n}`, 120)) continue;
      this.mark(r, `filler-${n}`);
      const name = firstName(car), ahead = gapAhead(r, car), behind = gapBehind(r, car);
      if (behind && !behind.car.player && behind.seconds < 2.5) {
        const them = callName(behind.car), gap = seconds(behind.seconds), left = plural(lapsRemaining(car, r), 'lap');
        this.say(r, 'DATA ENGINEER', this.pick(`fill-behind-${n}`, [`${name}, ${them} is ${gap} behind. Holding steady.`, `Gap to ${them} behind is ${gap}, ${name}. Keep it clean.`, `${them} still ${gap} back, ${name}. He’s on ${Math.floor(behind.car.age)}-lap-old ${behind.car.compound}s.`, `Mirrors, ${name}: ${them}, ${gap}. ${cap(left)} to go.`, `${name}, ${gap} to ${them} behind. Just hit your marks.`, `${them} sitting ${gap} behind you, ${name}. Yours are ${Math.floor(car.age)} laps old, his ${Math.floor(behind.car.age)}.`]), { priority: 0, ttl: 15 });
      } else if (ahead && !ahead.car.player && ahead.seconds < 3) {
        const them = callName(ahead.car), gap = seconds(ahead.seconds), left = plural(lapsRemaining(car, r), 'lap');
        this.say(r, 'DATA ENGINEER', this.pick(`fill-ahead-${n}`, [`${name}, ${gap} to ${them}. Stay with him.`, `${them} is ${gap} up the road, ${name}.`, `${gap} to ${them}, ${name}. He’s on ${Math.floor(ahead.car.age)}-lap-old ${ahead.car.compound}s.`, `${name}, ${them} ahead by ${gap}. ${cap(left)} to go.`, `Gap to ${them}: ${gap}. Keep him honest, ${name}.`, `${them} is the target, ${name}. ${gap}, ${left} left.`]), { priority: 0, ttl: 15 });
      } else {
        const w = car.wear;
        this.say(r, DRIVER[n], n === 2
          ? this.pick(`fill-feel-2-${w < 0.5 ? 'g' : 'b'}`, w < 0.5 ? ['Car feels good. Rears are holding up.', 'Balance is nice now. I can lean on it.', 'This thing is mega right now!', 'Grip’s great. Give me someone to chase!', 'Feeling strong. I’ve got more if you want it.'] : ['Rears are starting to slide a bit.', 'I’m getting oversteer out of the slow corners.', 'These tyres are going off fast!', 'Snap oversteer on entry. It’s getting tricky!', 'I’m sliding everywhere. How long do these need to last?'])
          : this.pick(`fill-feel-1-${w < 0.5 ? 'g' : 'b'}`, w < 0.5 ? ['Car’s working well. Managing the gap.', 'All good here. Tyres feel consistent.', 'Balance is fine. Nothing to report.', 'Comfortable. I can hold this pace.', 'Good grip. I’m looking after the rears.'] : ['Fronts are starting to grain a little.', 'Losing a bit of front end in the long corners.', 'Understeer is creeping in. The turn-in is lazy.', 'Traction is going out of the slow corners.', 'Tyres are past their best. I’m managing it.']), { priority: 0, ttl: 15 });
        // The tyre engineer answers from what the car is actually doing.
        this.later(r, 4, r => {
          const c = playerCar(r, n)!;
          if (c.finishedAt !== null || c.pitRemaining > 0) return;
          this.say(r, 'TYRE SPECIALIST', c.wear < 0.5
            ? this.pick(`fill-maya-g-${n}`, [`Copy, ${name}. Temperatures look good from here.`, `Data agrees, ${name}. ${tyreLife(c)} percent left.`, `Looks healthy from here, ${name}. ${tyreLife(c)} percent left on the ${c.compound}s.`, `Confirmed, ${name}. ${cap(c.compound)}s at ${tyreLife(c)} percent.`])
            : n === 2
              ? this.pick('fill-maya-b-2', [`Copy, Nico. Rear temps are up. Be gentle on the throttle out of the slow corners.`, `We see it. ${tyreLife(c)} percent left on those ${c.compound}s.`, `Nico, ${tyreLife(c)} percent. Smooth on the throttle and they’ll come back to you.`, `Copy. Rears at ${tyreLife(c)} percent. ${tyresReachFinish(c, r) ? 'They’ll make the flag if you’re gentle.' : 'They won’t last to the flag.'}`])
              : this.pick('fill-maya-b-1', [`Copy, Theo. Front-left graining. It should clean up in a lap or two.`, `We see it, Theo. ${tyreLife(c)} percent left. ${tyresReachFinish(c, r) ? 'Still enough for the flag.' : 'They won’t reach the flag.'}`, `Copy, Theo. ${tyreLife(c)} percent left. Keep the fronts cool through the fast stuff.`, `Understood, Theo. ${cap(c.compound)}s at ${tyreLife(c)} percent. ${tyresReachFinish(c, r) ? 'We can still make the flag.' : 'They won’t make the flag.'}`]), { priority: 0, ttl: 15 });
        });
      }
      return true;
    }
    return false;
  }

  /** Every few minutes the strategist sums up where both cars stand and what the plan is. */
  private summaryTalk(r: Race) {
    if (r.elapsed < 150 || !this.fresh(r, 'summary', 240)) return false;
    const cars = ([1, 2] as const).map(n => ({ n, car: playerCar(r, n)! })).filter(x => x.car.finishedAt === null);
    if (!cars.length) return false;
    this.mark(r, 'summary');
    const parts = cars.map(({ n, car }) => {
      const pos = positionOf(r, car), ahead = gapAhead(r, car), name = firstName(car);
      const fight = car.pitRemaining === 0 && ahead && !ahead.car.player && ahead.seconds < 3 ? `, ${seconds(ahead.seconds)} behind ${callName(ahead.car)}` : '';
      const plan = car.pitRemaining > 0 ? 'in the pits now' : car.pitOrder ? `boxing this lap for ${car.pitOrder}s` : tyresReachFinish(car, r)
        ? this.pick(`plan-ok-${n}`, [`${car.compound}s good to the flag`, `tyres fine to the end`, `no more stops needed`])
        : this.pick(`plan-stop-${n}`, ['needs another set before the end', 'still has a stop to make', `those ${car.compound}s won’t last`]);
      return `${name} P${pos}${fight}, ${plan}${onTarget(r, n, pos) ? '' : `, ${plural(placesOff(r, n, pos), 'place')} off target`}`;
    });
    this.say(r, 'STRATEGIST', `Lap ${currentLap(r)} picture. ${parts.join('. ')}.`, { priority: 1, ttl: 25 });
    return true;
  }

  private trendTalk(r: Race, n: 1 | 2, car: Car) {
    const t = this.trend(n);
    if (!t || lapsRemaining(car, r) < 2) return false;
    const name = firstName(car), byId = (id: number) => r.cars.find(c => c.id === id)!;
    const amount = (d: number) => d < 0.95 ? `${Math.max(1, Math.round(d * 10))} ${Math.round(d * 10) === 1 ? 'tenth' : 'tenths'}` : `${seconds(d)} seconds`;
    if (t.behind && t.behind.delta >= 0.25 && t.behind.s < 4 && this.fresh(r, `threat-${n}-${t.behind.id}`, 150)) {
      const rival = byId(t.behind.id), fresher = rival.age + 3 < car.age;
      this.mark(r, `threat-${n}-${t.behind.id}`);
      const tail = fresher ? ` He’s on fresher ${rival.compound}s.` : '';
      this.say(r, 'DATA ENGINEER', this.pick(`threat-${n}`, [`${name}, ${callName(rival)} is coming. ${cap(amount(t.behind.delta))} a lap quicker, ${seconds(t.behind.s)} behind.${tail}`, `Heads up, ${name}: ${callName(rival)}, ${seconds(t.behind.s)} behind and ${amount(t.behind.delta)} a lap faster.${tail}`, `${callName(rival)} is closing, ${name}. ${seconds(t.behind.s)} back, gaining ${amount(t.behind.delta)} a lap.${tail}`]), { kind: 'warning', priority: 2, ttl: 20 });
      this.later(r, 4, r => this.driverReply(r, n, n === 2 ? ['He’s not getting past me!', 'Let him try.'] : ['I see him. I’ll defend into turn one.', 'Copy. I’ll keep it tidy.']));
      return true;
    }
    if (t.ahead && t.ahead.delta >= 0.2 && t.ahead.s > 0.6 && t.ahead.s < 6 && this.fresh(r, `closing-${n}-${t.ahead.id}`, 180)) {
      const rival = callName(byId(t.ahead.id)), lapsToCatch = Math.ceil((t.ahead.s - 0.5) / t.ahead.delta);
      this.mark(r, `closing-${n}-${t.ahead.id}`);
      const outlook = lapsToCatch <= lapsRemaining(car, r) - 1 ? `You’ll be on him in about ${plural(lapsToCatch, 'lap')}.` : 'Not enough laps to catch him at this rate, though.';
      this.say(r, 'DATA ENGINEER', this.pick(`closing-${n}`, [`${name}, you’re taking ${amount(t.ahead.delta)} a lap out of ${rival}. ${seconds(t.ahead.s)} seconds now. ${outlook}`, `${rival} is coming back to you, ${name}: ${amount(t.ahead.delta)} a lap. ${seconds(t.ahead.s)} now. ${outlook}`, `${name}, ${amount(t.ahead.delta)} a lap quicker than ${rival}. Gap is ${seconds(t.ahead.s)}. ${outlook}`]), { priority: 1, ttl: 20 });
      const catchable = lapsToCatch <= lapsRemaining(car, r) - 1;
      this.later(r, 4, r => this.driverReply(r, n, catchable
        ? (n === 2 ? ['Copy! Let me at him!', 'I can see him. Keep the gaps coming!'] : ['Copy. I’ll keep chipping away.', 'Understood. Patience.'])
        : (n === 2 ? ['I’ll try anyway!', 'Watch me!'] : ['Understood. Every tenth counts.'])));
      return true;
    }
    if (t.behind && t.behind.delta <= -0.4 && t.behind.s > 2 && t.behind.s < 6 && this.fresh(r, `escape-${n}`, 300)) {
      this.mark(r, `escape-${n}`);
      const them = callName(byId(t.behind.id)), gap = seconds(t.behind.s);
      this.say(r, 'DATA ENGINEER', this.pick(`escape-${n}`, [`Nice work, ${name}. ${gap} to ${them} behind, and growing.`, `${name}, you’re pulling away from ${them}. ${gap} now.`, `Gap to ${them} is out to ${gap}, ${name}. Good pace.`, `${them} can’t hold you, ${name}. ${gap} and growing.`]), { priority: 1, ttl: 20 });
      return true;
    }
    return false;
  }

  private lapTalk(r: Race, n: 1 | 2, car: Car) {
    const times = car.lapTimes;
    if (times.length < 3 || r.elapsed - car.lapStarted > 30 || !this.fresh(r, `pb-${n}`, 240)) return false;
    const last = times.at(-1)!, best = Math.min(...times.slice(0, -1));
    if (last >= best) return false;
    this.mark(r, `pb-${n}`);
    const time = `${Math.floor(last / 60)}:${String(last % 60).padStart(2, '0')}`;
    this.say(r, 'DATA ENGINEER', this.pick(`pb-${n}`, [`${firstName(car)}, personal best. ${time}.`, `Purple for you, ${firstName(car)}. ${time}, your best lap yet.`, `${time}, ${firstName(car)}. That’s your fastest lap.`]), { priority: 1, ttl: 20 });
    this.later(r, 3, r => this.driverReply(r, n, n === 2 ? ['Yes! The car is alive!', 'Mega! There’s more in it!'] : ['Good. There’s a bit more there.', 'Copy. Tyres feel good.']));
    return true;
  }

  private stuckTalk(r: Race, n: 1 | 2, car: Car) {
    const close = this.closeSince[n];
    if (!close || r.elapsed - close.since < 60 || !this.fresh(r, `stuck-${n}-${close.id}`, 99999)) return false;
    const rival = r.cars.find(c => c.id === close.id)!, name = callName(rival);
    this.mark(r, `stuck-${n}-${close.id}`);
    this.say(r, DRIVER[n], n === 2
      ? this.pick('stuck-2', [`I’m stuck in ${name}’s dirty air. I lose the front in turn three.`, `I can’t follow ${name} through the fast corners! Dirty air!`, `${name}’s too quick on the straights. I need a better exit!`])
      : this.pick('stuck-1', [`${name} is quick on the straight. Hard to get close.`, `Losing the front behind ${name}. The dirty air is bad here.`, `I can match ${name} in the corners, but not on the straight.`]), { priority: 1, ttl: 20 });
    this.later(r, 4, r => {
      const c = playerCar(r, n)!;
      if (c.finishedAt !== null || c.pitRemaining > 0) return;
      if (gapAhead(r, c)?.car !== rival) { this.say(r, 'STRATEGIST', `Never mind. He’s through. Nice job, ${firstName(c)}.`, { priority: 1, ttl: 15 }); return; }
      const older = rival.age - c.age;
      this.say(r, 'STRATEGIST', older > 3
        ? `Stay patient, ${firstName(c)}. His tyres are ${Math.round(older)} laps older. He’ll fade.`
        : c.mode === 'push' ? this.pick(`pressure-${n}`, ['Copy. Keep the pressure on. Make him use his tyres.', 'Stay on his gearbox. Force a mistake.', 'Keep him under pressure. He’ll have to defend every corner.']) : this.pick(`attack-offer-${n}`, ['Copy. If you want to attack, we can turn the pace up. Your call, engineer.', 'We can go to push mode if you want him. Your call, engineer.']), { priority: 1, ttl: 20 });
    });
    return true;
  }

  private teammateTalk(r: Race, n: 1 | 2, car: Car) {
    if (r.elapsed < 300 || this.done.has(`mate-${n}`) || raceRandom(this.seed, n, r.elapsed, 11) > 0.25) return false;
    this.done.add(`mate-${n}`);
    this.mark(r, `mate-${n}`);
    this.say(r, DRIVER[n], n === 1 ? 'How’s Nico getting on?' : `Where’s Theo? Still ${targetPhrase(r, 1).in}?`, { priority: 1, ttl: 20 });
    this.later(r, 4, r => {
      const mate = playerCar(r, n === 1 ? 2 : 1)!, pos = positionOf(r, mate), name = firstName(mate);
      if (mate.finishedAt !== null) return;
      const ahead = gapAhead(r, mate);
      const detail = mate.pitRemaining > 0 ? 'He’s in the pit lane right now.' : ahead && !ahead.car.player && ahead.seconds < 1.5 ? `Fighting ${callName(ahead.car)}, ${seconds(ahead.seconds)} between them.` : '';
      const target = onTarget(r, n === 1 ? 2 : 1, pos) ? 'on target' : 'off target for now';
      this.say(r, 'DATA ENGINEER', `${name} is P${pos}, ${target}. ${detail}`.trim(), { priority: 1, ttl: 20 });
    });
    return true;
  }

  private fieldTalk(r: Race) {
    if (r.elapsed < 600 || r.elapsed > 1100 || this.done.has('field')) return false;
    this.done.add('field');
    this.mark(r, 'field');
    const rivals = r.cars.filter(c => !c.player && c.finishedAt === null);
    const stopped = rivals.filter(c => c.stops > 0).length;
    const sorted = order(r);
    const ours = ([1, 2] as const).map(k => playerCar(r, k)!);
    const longRun = rivals.filter(c => c.stops === 0).sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b))[0];
    this.say(r, 'DATA ENGINEER', `Field update. ${stopped === rivals.length ? 'All the rivals have stopped.' : stopped === 0 ? 'None of the rivals have stopped yet.' : `${stopped} of the ${rivals.length} rivals have stopped.`}${longRun ? ` ${callName(longRun)} is going long on ${Math.floor(longRun.age)}-lap-old ${longRun.compound}s.` : ''}`, { priority: 1, ttl: 25 });
    this.later(r, 5, r => {
      if (!longRun) { this.say(r, 'STRATEGIST', 'Everyone has stopped. It’s a straight fight to the flag now.', { priority: 1, ttl: 20 }); return; }
      const behindHim = ours.find(c => sorted.indexOf(c) === sorted.indexOf(longRun) + 1);
      this.say(r, 'STRATEGIST', behindHim
        ? `If ${callName(longRun)} still has to stop, that’s a place for ${firstName(behindHim)}. Keep the pressure on.`
        : compoundLife(r, longRun.compound) - longRun.age > r.config.totalLaps - longRun.distance ? `Those ${longRun.compound}s can make the flag. He may not stop at all.` : `Watch ${callName(longRun)}. He still has to stop.`, { priority: 1, ttl: 20 });
    });
    return true;
  }

  private safetyChatter(r: Race) {
    if (this.safetyAt < 0 || r.elapsed - this.safetyAt < 50 || this.questions.length || this.done.has('sc-temps')) return;
    this.done.add('sc-temps');
    this.say(r, 'TYRE SPECIALIST', 'Tyre temperatures are dropping behind the safety car. Keep weaving, both of you.', { priority: 1, ttl: 20 });
    this.later(r, 3, r => this.driverReply(r, 1, ['Copy. Weaving.']));
  }

  private driverReply(r: Race, n: 1 | 2, options: string[]) {
    const c = playerCar(r, n)!;
    if (c.finishedAt !== null || c.pitRemaining > 0) return;
    this.say(r, DRIVER[n], this.pick(`reply-${n}-${options[0]}`, options), { priority: 1, ttl: 15 });
  }

  /** Strategy calls the team brings to you: the undercut while a rival’s tyres fade. */
  private proposals(r: Race) {
    if (this.opening(r)) return;
    if (r.flag !== 'green' || !this.quiet(r) || this.radioBusy() || wetness(r) > 0.02 || this.rainSoon(r)) return;
    for (const n of [1, 2] as const) {
      const car = playerCar(r, n)!;
      if (car.finishedAt !== null || car.pitRemaining > 0 || car.pitOrder || car.stops > 0 || this.openFor(n)) continue;
      const ahead = gapAhead(r, car);
      if (!ahead || ahead.car.player || ahead.car.pitRemaining > 0 || ahead.car.stops > 0) continue;
      const left = r.config.totalLaps - car.distance;
      if ((this.counts.get(`box-asks-${n}-${car.stops}`) ?? 0) > 0 || !this.settled(r, n)) continue;
      if (ahead.seconds > 2.5 || ahead.car.wear < 0.6 || car.wear < 0.45 || left < 6 || !this.once(`undercut-${n}-${ahead.car.id}`)) continue;
      const compound = this.planCompound(r, car), rival = callName(ahead.car);
      this.propose(r, n, `${firstName(car)} is ${seconds(ahead.seconds)} behind ${rival}, and ${rival}’s tyres are ${Math.floor(ahead.car.age)} laps old. Box now and fresh ${compound}s should undercut him. Box ${firstName(car)}?`, compound, `James: undercut ${rival}? Box ${firstName(car)}`);
      return;
    }
  }

  // ───────────────────────────── the start and the weather ─────────────────────────────

  private startReview(r: Race, n: 1 | 2, car: Car) {
    const pos = positionOf(r, car), change = this.grid[n] - pos, name = firstName(car);
    const text = n === 2
      ? change > 0 ? `Great launch! ${plural(change, 'place')} off the line! P${pos}!` : change < 0 ? `Bad start, sorry. Lost ${plural(-change, 'place')} into turn one.` : `Clean start. Holding P${pos}. Let’s go!`
      : change > 0 ? `Good start. Up to P${pos}.` : change < 0 ? `Lost ${plural(-change, 'place')} at the start. I’ll get it back.` : 'Clean start. Holding position.';
    this.say(r, DRIVER[n], text, { priority: 1, ttl: 20 });
    this.later(r, 4, r => {
      const c = playerCar(r, n)!, ahead = gapAhead(r, c), behind = gapBehind(r, c);
      if (c.finishedAt !== null || c.pitRemaining > 0) return;
      this.say(r, 'DATA ENGINEER', `Copy, ${name}. ${ahead ? `${callName(ahead.car)} ${seconds(ahead.seconds)} ahead` : 'Clear air ahead'}${behind ? `, ${callName(behind.car)} ${seconds(behind.seconds)} behind.` : '.'} Long way to go.`, { priority: 1, ttl: 20 });
    });
  }

  private raining = false;
  private radarWarned = false;

  /** When rain next reaches the track (wetness above 5%) within the next few minutes, or null. */
  private rainOnset(r: Race) {
    if (!r.config.weather) return null;
    for (let t = r.elapsed + 10; t <= r.elapsed + 400; t += 10) if (wetness(r, t) > 0.05) return t;
    return null;
  }

  /** Rain expected within six minutes: no point fitting fresh slicks now. */
  private rainSoon(r: Race) {
    if (!r.config.weather || wetness(r) >= 0.05) return false;
    for (let t = r.elapsed + 10; t <= r.elapsed + 360; t += 10) if (wetness(r, t) > 0.05) return true;
    return false;
  }

  weatherReport(r: Race) {
    const wet = wetness(r);
    if (!r.config.weather) return 'Dry to the finish. No rain on the radar.';
    const onset = wet < 0.05 ? this.rainOnset(r) : null;
    if (wet < 0.05) return onset !== null ? `Dry for now. Rain expected in about ${plural(Math.max(1, Math.round((onset - r.elapsed) / 60)), 'minute')}.` : 'Dry, and the radar is clear.';
    const later = wetness(r, r.elapsed + 240);
    const trend = later > wet + 0.05 ? 'getting wetter' : later < wet - 0.05 ? 'starting to dry' : 'holding steady';
    return `Track is ${trackState(r).toLowerCase()} and ${trend}. ${wet > 0.3 ? 'Inters are the tyre right now.' : 'Slicks still work on the dry line.'}`;
  }

  /** Rain on the radar, the first drops, the crossover to inters, and the switch back. */
  private weatherTalk(r: Race) {
    if (!r.config.weather || r.status !== 'running') return;
    const wet = wetness(r);
    if (wet < 0.02) this.raining = false;
    if (wet < 0.05) {
      const onset = this.rainOnset(r);
      if (onset !== null && onset - r.elapsed <= 240 && onset - r.elapsed >= 60 && !this.raining && !this.radarWarned) {
        this.radarWarned = true;
        this.say(r, 'DATA ENGINEER', `Radar update: rain expected in about ${plural(Math.max(1, Math.round((onset - r.elapsed) / 60)), 'minute')}. Light at first, then heavier.`, { priority: 2, ttl: 30 });
        this.later(r, 4, r => this.driverReply(r, 2, ['Copy. Tell me the second you want inters.']));
      }
      return;
    }
    // One announcement per shower: the first drops switch the state on; a dry track resets it.
    if (!this.raining) {
      this.raining = true;
      this.radarWarned = false;
      this.say(r, 'RACE CONTROL', 'Rain reported in sector three.', { kind: 'warning', priority: 2, ttl: 20 });
      this.later(r, 3, r => this.driverReply(r, 2, ['It’s starting to rain in turn ten!']));
    }
    for (const n of [1, 2] as const) {
      const car = playerCar(r, n)!, name = firstName(car);
      if (car.finishedAt !== null || car.pitRemaining > 0 || car.pitOrder || r.config.totalLaps - car.distance < 2) continue;
      if (car.compound !== 'inter') {
        if (wet >= 0.3 && !this.openFor(n) && this.quiet(r) && this.once(`inters-${n}-${car.stops}`)) {
          this.ask(r, 'plan', n, 'STRATEGIST', `The track’s wet enough for inters now. Box ${name} for inters?`, 30, `James: inters for ${name}?`,
            [{ label: 'Box · inters', reply: 'yes' }, { label: 'Stay out', reply: 'no' }], [{ car: n, action: 'pit', compound: 'inter' }]);
          return;
        }
        if (wet >= 0.45 && this.once(`aqua-${n}-${car.stops}`)) {
          this.say(r, DRIVER[n], n === 2 ? 'I’m aquaplaning out here! I need inters!' : 'Very little grip on these slicks. Standing water in turn fifteen.', { kind: 'warning', priority: 2, ttl: 15 });
        }
      } else {
        if (wet < 0.28 && this.once(`overheat-${n}-${car.stops}`)) {
          this.say(r, 'TYRE SPECIALIST', `${name}, the inters are overheating. Find the wet patches to cool them.`, { priority: 1, ttl: 20 });
        }
        if (wet < 0.22 && !this.openFor(n) && this.quiet(r) && this.once(`dry-${n}-${car.stops}`)) {
          const compound = slickFor(r, r.config.totalLaps - car.distance);
          this.ask(r, 'plan', n, 'STRATEGIST', `A dry line is forming. Slicks for ${name}? ${cap(compound)}s.`, 30, `James: slicks for ${name}?`,
            [{ label: `Box · ${compound}s`, reply: 'yes' }, { label: 'Stay out', reply: 'no' }], [{ car: n, action: 'pit', compound }]);
          return;
        }
      }
    }
  }

  // ───────────────────────────── the player speaks ─────────────────────────────

  /** Handle a typed or spoken call. Returns a request for the language model when nothing else fits. */
  hear(r: Race, input: string): BrainCall | null {
    const text = input.trim();
    if (!text) return null;
    this.say(r, 'YOU', text, { kind: 'you', voice: false });
    const normalized=normalize(text);
    if (/^(say again|repeat(?: that)?|what was that)$/.test(normalized)) {
      const last=[...this.lines].reverse().find(l=>l.voice&&l.speaker!=='YOU');
      if(last)this.say(r,last.speaker,last.text,{priority:2,ttl:25});
      return null;
    }
    const focus = this.focusQuestion(text);
    const clarification=this.clarification;this.clarification=null;
    // A short answer to “Which car?” or “Which tyre?” completes the call it was asked about.
    const shortCar=/^(?:car (?:one|two)|theo|nico|laurent|reyes)$/.test(normalized);
    const shortTyre=/^(?:on |the )?(?:softs?|mediums?|hards?|inters?|intermediates?|reds?|yellows?|whites?)(?: please| then)?$/.test(normalized);
    const completes=clarification&&this.now()<clarification.until&&(clarification.reason==='which-car'?shortCar:shortTyre);
    const intent = parseIntent(completes ? `${text}, ${clarification.text}` : text, focus?.car || this.recentCar, this.compound, !!r.config.weather);
    if(this.lastTopic&&/^(?:and |what about |how about )(?:theo|nico|car one|car two)\??$/.test(normalized)) {
      const target=parseIntent(text);const n='car' in target&&target.car?target.car:/nico|two/.test(normalized)?2:1;
      this.recentCar=n;this.answer(r,this.lastTopic,n as 1|2);return null;
    }
    if(/^(why|why is that|how come|explain that)$/.test(normalized)&&this.recentCar&&(this.lastTopic==='strategy'||this.lastTopic==='tyres')) {
      const car=playerCar(r,this.recentCar)!;
      this.say(r,'STRATEGIST',`${firstName(car)} has about ${Math.max(0,Math.floor(lapsOfLife(car, r)))} laps of tyre life at this pace, with ${lapsRemaining(car, r)} to go. ${tyresReachFinish(car, r)?'A stop gives away track position we do not need to lose.':'Staying out means running past the tyre cliff.'}`,{priority:2,ttl:25});return null;
    }

    if (focus?.kind === 'result' && intent.kind !== 'question') {
      this.close(focus);
      this.resultReaction(r, focus.car as 1 | 2, true);
      return null;
    }
    const answer = parseAnswer(text);
    // A refusal answers the open question (so the driver can react to it), unless it carries a pit call: “no, box now”.
    if (focus && answer === 'no' && intent.kind !== 'question' && intent.kind !== 'swap' && (intent.kind !== 'command' || (intent.command.action === 'stay' && focus.kind === 'box'))) {
      this.resolve(r, focus, 'no');
      return null;
    }
    if (intent.kind === 'command') {
      this.mem.ignoredPlans = 0;
      const commands = intent.cars ? intent.cars.map(car => ({ ...intent.command, car })) : [intent.command];
      if (!intent.cars) this.recentCar = intent.command.car;
      this.execute(r, commands);
      return null;
    }
    if (intent.kind === 'swap') {
      const yielder = intent.car ?? this.leadingCar(r);
      this.recentCar = yielder;
      this.execute(r, [{ car: yielder, action: 'swap' }]);
      return null;
    }
    if (focus && answer && intent.kind !== 'question') {
      this.resolve(r, focus, answer);
      return null;
    }
    if (intent.kind === 'question') {
      this.lastTopic=intent.topic;
      this.recentCar = intent.car;
      const to = addressee(text);
      const namedDriver=/\b(theo|laurent|nico|reyes|car one|car two)\b/.test(normalized);
      const speaker=to??(namedDriver?DRIVER[intent.car as 1|2]:this.chatSpeaker??DRIVER[intent.car as 1|2]);
      this.chatSpeaker=speaker;
      if ((intent.topic === 'feel' || intent.topic === 'open') && this.brainAvailable()) {
        return { speaker, car: intent.car as 1 | 2, text };
      }
      // Without the model, an open question goes to whoever was addressed, on their specialist topic.
      const topic: Topic = intent.topic !== 'open' ? intent.topic : to === 'STRATEGIST' ? 'strategy' : to === 'TYRE SPECIALIST' ? 'tyres' : to === 'DATA ENGINEER' ? 'gaps' : 'feel';
      this.answer(r, topic, intent.car as 1 | 2, intent.rival);
      return null;
    }
    if (intent.kind === 'clarify') {
      if(intent.reason==='which-car'||intent.reason==='which-tyre')this.clarification={text,until:this.now()+30000,reason:intent.reason};
      const speaker: Speaker = intent.reason === 'dry' ? 'TYRE SPECIALIST' : intent.car ? DRIVER[intent.car as 1 | 2] : 'STRATEGIST';
      const line = intent.reason === 'which-car' ? 'Which car, Theo or Nico?'
        : intent.reason === 'one-car' ? 'One car at a time, or say “box both” for a double stack.'
        : intent.reason === 'one-compound' || intent.reason === 'which-tyre' ? 'Which tyre? Softs, mediums or hards?'
          : intent.reason === 'dry' ? 'It’s bone dry out there. Softs, mediums or hards only.'
            : 'One thing at a time. Box, stay out, push or save?';
      this.say(r, speaker, line, { priority: 2, ttl: 15 });
      return null;
    }
    // Nothing matched.
    const car = (intent.car ?? this.recentCar) as 1 | 2 | undefined;
    if (answer && !focus) {
      this.say(r, 'STRATEGIST', 'Copy. Standing by for your next call.', { priority: 1, ttl: 10 });
      return null;
    }
    if (this.brainAvailable()) return { speaker: addressee(text) ?? (car ? DRIVER[car] : 'STRATEGIST'), car: car ?? 1, text };
    this.sayAgain(r, car);
    return null;
  }

  private sayAgain(r: Race, car?: 1 | 2, hint = true) {
    if (car) this.say(r, DRIVER[car], car === 2 ? this.pick('again-2', ['Say again? I lost you.', 'Didn’t get that. Say again?']) : this.pick('again-1', ['Say again?', 'Radio’s breaking up. Say again?']), { priority: 2, ttl: 12 });
    else this.say(r, 'STRATEGIST', 'Didn’t catch that. Which car, and what’s the call?', { priority: 2, ttl: 12 });
    if (hint) this.system(r, `Try “Nico, box for softs”, “Theo, push”, “yes” / “no” to a question, or “how are Nico’s tyres?”.${this.brainAvailable() ? '' : ' Turn on Team chat AI for free-form questions.'}`);
  }

  private leadingCar(r: Race): 1 | 2 {
    const sorted = order(r);
    return sorted.indexOf(playerCar(r, 1)!) < sorted.indexOf(playerCar(r, 2)!) ? 1 : 2;
  }

  private resolve(r: Race, q: Question, answer: 'yes' | 'no') {
    this.close(q);
    this.mem.ignoredPlans = 0;
    const n = q.car as 1 | 2;
    if (q.kind === 'push') {
      if (answer === 'yes') this.execute(r, [{ car: n, action: 'push' }]);
      else {
        this.mem.deniedPush[n] = r.elapsed;
        this.say(r, DRIVER[n], n === 2 ? this.pick('push-no-2', ['Ugh. Okay. Holding.', 'Fine. But I’m faster, you know.']) : this.pick('push-no-1', ['Copy. Holding station.', 'Understood. Saving it for later.']), { priority: 2, ttl: 12 });
      }
    } else if (q.kind === 'box') {
      if (answer === 'yes') this.execute(r, [{ car: n, action: 'pit', compound: this.compound(n) }]);
      else {
        this.mem.deniedBox[n]++;
        this.boxRefused(r, n, true);
      }
    } else if (q.kind === 'safety') {
      if (answer === 'yes') {
        const cars = ([1, 2] as const).filter(k => { const c = playerCar(r, k)!; return c.finishedAt === null && c.pitRemaining === 0 && !c.pitOrder; });
        this.execute(r, cars.map(car => ({ car, action: 'pit', compound: this.compound(car) } as Command)));
      } else this.say(r, 'STRATEGIST', 'Copy. Both cars stay out.', { priority: 2, ttl: 12 });
    } else if (q.kind === 'swap') {
      if (answer === 'yes') this.execute(r, q.commands ?? []);
      else this.say(r, 'STRATEGIST', 'Copy. No team orders. Let them race.', { priority: 2, ttl: 12 });
    } else if (q.kind === 'plan') {
      if (answer === 'yes') this.execute(r, q.commands ?? []);
      else this.say(r, 'STRATEGIST', this.pick('plan-no', ['Copy. Staying out. I’ll keep watching it.', 'Understood. Your call. We stay out.']), { priority: 2, ttl: 12 });
    } else if (q.kind === 'result') {
      this.resultReaction(r, n, true);
    }
  }

  // ───────────────────────────── commands ─────────────────────────────

  /** Execute calls from the radio or the dashboard buttons and acknowledge them in character. */
  execute(r: Race, commands: Command[]) {
    const results = commands.map(command => {
      const car = playerCar(r, command.car);
      const before = car ? { pitOrder: car.pitOrder, mode: car.mode, wear: car.wear } : null;
      return { command, car, before, outcome: applyCommand(r, command) };
    });
    for (const { command, outcome } of results) {
      if (outcome !== 'ok') continue;
      this.mem.lastCommandAt[command.car] = r.elapsed;
      if(command.action==='pit'){this.teamReplies=this.teamReplies.filter(x=>!(x.car===command.car&&x.kind==='crew'));this.teamReplies.push({due:r.elapsed+6,car:command.car as 1|2,kind:'crew'});}
      for (const q of [...this.questions]) {
        const related = q.car === command.car && ((q.kind === 'push' && (command.action === 'push' || command.action === 'conserve' || command.action === 'balanced')) || ((q.kind === 'box' || q.kind === 'plan') && (command.action === 'pit' || command.action === 'stay')) || (q.kind === 'swap' && command.action === 'swap'));
        if (related || (q.kind === 'safety' && (command.action === 'pit' || command.action === 'stay'))) this.close(q);
      }
      if (command.action === 'swap') this.mem.swap = { yielder: command.car as 1 | 2, beneficiary: command.car === 1 ? 2 : 1 };
    }
    if (results.length > 1) {
      const ok = results.filter(x => x.outcome === 'ok');
      const a = results[0].command;
      if (ok.length === 2 && a.action === 'pit') this.say(r, 'STRATEGIST', `Double stack. Theo first, then Nico. Crew, ${a.compound}s for Theo, ${(results[1].command as { compound: Compound }).compound}s for Nico.`, { priority: 2, ttl: 15 });
      else if (ok.length === 2) this.say(r, 'STRATEGIST', `Copy. Both cars: ${a.action === 'stay' ? 'stay out' : a.action === 'balanced' ? 'normal pace' : a.action}.`, { priority: 2, ttl: 15 });
      // Skip “too late” noise for a car that was already committed when the other one could still react.
      else for (const x of results) if (!ok.length || x.outcome === 'ok' || (x.outcome !== 'committed' && x.outcome !== 'finished')) this.acknowledge(r, x.command, x.outcome, x.before);
      return;
    }
    const x = results[0];
    if (x) this.acknowledge(r, x.command, x.outcome, x.before);
  }

  private acknowledge(r: Race, command: Command, outcome: CommandOutcome, before: { pitOrder: Compound | null; mode: Car['mode']; wear: number } | null) {
    const n = command.car as 1 | 2;
    const car = playerCar(r, n);
    if (outcome === 'not-running') { this.system(r, 'Start the session before making a call.'); return; }
    if (!car || outcome === 'no-car' || outcome === 'bad-compound' || outcome === 'unknown') { this.system(r, 'That call is not available.'); return; }
    const speaker = DRIVER[n], theo = n === 1;
    const line = (text: string, priority = 2) => this.say(r, speaker, text, { priority, ttl: 15 });
    if (outcome === 'finished') return line(theo ? 'We’re done here. I’ve taken the flag.' : 'I’ve already crossed the line!');
    if (outcome === 'committed') return line(theo ? 'Already committed to the pit lane.' : 'Too late, I’m already in the pit lane!');
    if (outcome === 'no-swap') return this.say(r, 'STRATEGIST', 'They’re not close enough to swap right now.', { priority: 2, ttl: 12 });
    const ahead = gapAhead(r, car);
    const rival = ahead && !ahead.car.player ? callName(ahead.car) : null;
    switch (command.action) {
      case 'pit': {
        const c = command.compound;
        if (before?.pitOrder === c) return line(theo ? `Already copied. ${cap(c)}s.` : `Yes, yes, ${c}s. I heard you!`);
        if (before?.pitOrder) return line(theo ? `Switching to ${c}s. Copy.` : `Change to ${c}s. Got it.`);
        if (c === 'inter') return line(theo ? 'Inters this lap. Copy.' : this.pick('ack-inter-2', ['Inters, yes! Finally!', 'Inters this lap. Good call!']));
        if (car.compound === 'inter') return line(theo ? `Slicks. ${cap(c)}s this lap. Copy.` : `Slicks! ${cap(c)}s! Let’s go!`);
        if ((before?.wear ?? 1) < 0.25) return line(theo ? `These are still fresh, but understood. ${cap(c)}s.` : `Again? These are new! …Okay, boxing for ${c}s.`);
        if (r.flag === 'safety') return line(theo ? `Box under the safety car. Good call. ${cap(c)}s.` : `Box box under the safety car, yes! ${cap(c)}s!`);
        if (r.config.totalLaps - car.distance < 2.5) return line(theo ? `Box with ${Math.ceil(r.config.totalLaps - car.distance)} to go? Understood. ${cap(c)}s.` : `Box now? Only ${Math.ceil(r.config.totalLaps - car.distance)} laps left… Okay, ${c}s.`);
        return line(theo ? this.pick('ack-pit-1', [`Box this lap, ${c}s. Copy.`, `Understood. ${cap(c)}s at the end of this lap.`]) : this.pick('ack-pit-2', [`Box box, ${c}s! Let’s go!`, `Copy, box this lap. ${cap(c)}s. Give me a fast one, guys!`]));
      }
      case 'stay':
        if (before?.pitOrder) return line(theo ? 'Copy. Staying out. Stop cancelled.' : 'Staying out? Okay… don’t leave me out here too long.');
        if (car.wear > 0.95) return line(theo ? 'Staying out. It’ll be slow, but understood.' : 'Staying out on these?! Okay, I’ll try.');
        return line(theo ? 'Copy. Staying out.' : 'Staying out, yeah.');
      case 'push':
        if (before?.mode === 'push') return line(theo ? 'We’re already pushing.' : 'I’m already flat out!');
        if (car.wear > 0.85) return line(theo ? 'Pushing, but these tyres won’t take much more.' : 'Pushing! The tyres are screaming, though.');
        return line(theo
          ? this.pick('ack-push-1', ['Understood. Pushing now.', rival ? `Copy. Let’s go and get ${rival}.` : 'Copy. Finding a bit more.'])
          : this.pick('ack-push-2', ['Finally! Let’s go!', rival ? `Yes! Let’s go get ${rival}!` : 'Yes! Pushing!']));
      case 'conserve':
        if (before?.mode === 'conserve') return line(theo ? 'Already managing them.' : 'I’m already saving them!');
        return line(theo ? this.pick('ack-save-1', ['Copy. Short-shifting, looking after the rears.', 'Understood. Managing the tyres.']) : this.pick('ack-save-2', ['Okay, backing off. Tell me when I can fight again.', 'Saving them. Not happy, but okay.']));
      case 'balanced':
        return line(theo ? 'Copy. Back to target pace.' : 'Normal pace. Understood.');
      case 'swap':
        return line(theo ? this.pick('ack-swap-1', ['Understood. I’ll let him through at turn ten.', 'Copy. Letting Nico by.']) : this.pick('ack-swap-2', ['What?! …Fine. Letting him through.', 'Seriously? Okay. Theo’s coming through.']));
    }
  }

  // ───────────────────────────── answers ─────────────────────────────

  private answer(r: Race, topic: Topic, n: 1 | 2, rivalName?: string) {
    const car = playerCar(r, n)!, name = firstName(car), pos = positionOf(r, car);
    const reply = (speaker: Speaker, text: string) => this.say(r, speaker, text, { priority: 2, ttl: 20 });
    if (topic === 'weather') return reply('DATA ENGINEER', this.weatherReport(r));
    if (topic === 'laps') return reply('DATA ENGINEER', `${plural(r.config.totalLaps - currentLap(r) + 1, 'lap')} to go, including this one.`);
    if (topic === 'status') {
      const a = positionOf(r, playerCar(r, 1)!), b = positionOf(r, playerCar(r, 2)!);
      const ta = onTarget(r, 1, a), tb = onTarget(r, 2, b);
      return reply('STRATEGIST', `Theo P${a}, Nico P${b}. ${ta && tb ? 'Both on target right now.' : !ta && !tb ? 'Both cars are off target.' : !ta ? `Theo needs ${targetPhrase(r, 1).goal}.` : `Nico needs ${targetPhrase(r, 2).goal}.`}`);
    }
    if (topic === 'rival' && rivalName) {
      const rival = r.cars.find(c => !c.player && c.name.endsWith(rivalName));
      if (!rival) return reply('DATA ENGINEER', `I don’t have ${rivalName} on the timing screens.`);
      const rp = positionOf(r, rival);
      const closest = ([1, 2] as const).map(k => playerCar(r, k)!).sort((x, y) => Math.abs(positionOf(r, x) - rp) - Math.abs(positionOf(r, y) - rp))[0];
      const gap = Math.abs(rival.distance - closest.distance) * lapPace(closest, r);
      const relation = `${seconds(gap)} ${rival.distance > closest.distance ? 'ahead of' : 'behind'} ${firstName(closest)}`;
      const plan = rival.pitRemaining > 0 ? 'He’s in the pit lane now.' : rival.stops === 0 && rival.wear > 0.75 ? 'His tyres are old. Expect him to pit soon.' : rival.stops === 0 ? 'He hasn’t stopped yet.' : 'He’s already stopped.';
      return reply('DATA ENGINEER', `${callName(rival)} is P${rp} on ${Math.floor(rival.age)}-lap-old ${rival.compound}s, ${relation}. ${plan}`);
    }
    if (car.finishedAt !== null) return reply('DATA ENGINEER', `${name} has finished. P${pos}.`);
    if (topic === 'tyres') {
      this.lastTyreTalk[n] = r.elapsed;
      const left = r.config.totalLaps - car.distance;
      const outlook = tyresReachFinish(car, r) ? `They’ll reach the finish${car.mode === 'push' ? ', even pushing' : car.mode === 'conserve' ? ' comfortably while he saves them' : ' at this pace'}.` : `About ${plural(Math.floor(lapsOfLife(car, r)), 'lap')} before they fall away, and ${plural(Math.ceil(left), 'lap')} to go.`;
      return reply('TYRE SPECIALIST', `${name}: ${car.compound}s, ${Math.floor(car.age)} laps old, ${tyreLife(car)}% left. ${outlook}`);
    }
    if (topic === 'gaps' || topic === 'position') {
      const ahead = gapAhead(r, car), behind = gapBehind(r, car);
      const goal = topic === 'position' ? (onTarget(r, n, pos) ? ' On target.' : ` ${plural(placesOff(r, n, pos), 'place')} off target.`) : '';
      return reply('DATA ENGINEER', `${name} is P${pos}.${goal} ${ahead ? `${callName(ahead.car)} ${seconds(ahead.seconds)} ahead` : 'Leading'}${behind ? `, ${callName(behind.car)} ${seconds(behind.seconds)} behind.` : '.'}`);
    }
    if (topic === 'strategy') {
      if (car.pitRemaining > 0) return reply('STRATEGIST', `${name} is in the pit lane now. Let’s see where he rejoins.`);
      if (car.pitOrder) return reply('STRATEGIST', `${name} boxes this lap for ${car.pitOrder}s. Say “stay out” to cancel.`);
      const f = pitForecast(r, car);
      const left = r.config.totalLaps - car.distance;
      const compound = wetness(r) > 0.3 ? 'inter' : slickFor(r, left);
      if (r.flag === 'safety' && left > 3) return reply('STRATEGIST', `The safety car makes a stop cheap. I’d box ${name} for ${compound}s; he rejoins about P${f.position}. Your call.`);
      if (!tyresReachFinish(car, r) && left > 2) return reply('STRATEGIST', `I’d box ${name} now. ${cap(compound)}s reach the end, and he rejoins about P${f.position}${f.aheadCar ? `, behind ${callName(f.aheadCar)}` : ''}. Your call.`);
      return reply('STRATEGIST', `Stay out with ${name}. Tyres have ${tyreLife(car)}% and should reach the end. A stop now drops him to about P${f.position}.`);
    }
    // feel / open questions without the language model.
    const wear = car.wear;
    return reply(DRIVER[n], n === 2
      ? wear < 0.4 ? 'Car feels mega! Just let me use it!' : wear < 0.78 ? 'Bit of oversteer, but it’s fine. I can fight.' : 'It’s sliding everywhere! These tyres are done!'
      : wear < 0.4 ? 'Car feels good. Tyres are in the window.' : wear < 0.78 ? 'It’s okay. The rears are starting to go off a little.' : 'Struggling. The fronts are going.');
  }

  // ───────────────────────────── language model replies ─────────────────────────────

  /** Lines the model sees as context, newest last. */
  recentRadio(count = 4): string[] {
    return this.lines.filter(l => l.kind !== 'system').slice(-count).map(l => `${SPEAKER_NAME[l.speaker]}: ${l.text}`);
  }

  /** Speak a model reply. The model can only talk; calls always go through the parser and buttons. */
  brainReply(r: Race, call: BrainCall, say: string | null, error?: string) {
    if (say) { this.say(r, call.speaker, say, { priority: 2, ttl: 20 }); return; }
    this.sayAgain(r, call.speaker === 'LAU' ? 1 : call.speaker === 'REY' ? 2 : undefined, !error);
    if (error) this.system(r, `Team chat model unavailable: ${error}`);
  }
}
