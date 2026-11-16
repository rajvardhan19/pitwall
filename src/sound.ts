// Procedural audio only: no third-party recordings. What a race engineer hears from the pit wall:
// the circuit in the distance, cars screaming past the wall, and the pit crew's wheel guns.
// The synthesis functions take any BaseAudioContext, so they can also be rendered offline for checks.

const C = 343; // speed of sound, m/s

function noiseBuffer(ctx: BaseAudioContext, seconds: number, brown = false) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate), data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = brown ? (last = (last + white * 0.02) / 1.02) * 3.5 : white;
  }
  return buffer;
}
const drive = (() => { const curve = new Float32Array(1024); for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(2.6 * (i / 511.5 - 1)); return curve; })();
const cleanup = (first: AudioScheduledSourceNode, nodes: AudioNode[]) => { first.onended = () => nodes.forEach(n => n.disconnect()); };

/**
 * A turbo V6 passing the pit wall. The firing frequency is rpm / 20 (three pulses per revolution); the
 * Doppler shift takes it from c/(c-v) above to c/(c+v) below as the car goes by, the highs open up as it
 * arrives (air absorbs them over distance), and it pans across. `level` 1 is our car on the pit straight.
 */
export function passBy(ctx: BaseAudioContext, out: AudioNode, at: number, level: number, safety: boolean) {
  const rpm = safety ? 7400 + Math.random() * 700 : 10900 + Math.random() * 1100, f = rpm / 20;
  const v = safety ? 38 : 80, up = C / (C - v), down = C / (C + v);
  const dur = safety ? 3.8 : 2.6, mid = at + dur * 0.45, end = at + dur;
  const shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
  shaper.curve = drive; tone.type = 'lowpass'; tone.Q.value = 0.8;
  tone.frequency.setValueAtTime(800, at);
  tone.frequency.exponentialRampToValueAtTime(level > 0.9 ? 7500 : 3000, mid);
  tone.frequency.exponentialRampToValueAtTime(650, end);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.24 * level, mid);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  pan.pan.setValueAtTime(-0.9, at); pan.pan.linearRampToValueAtTime(0.9, end);
  shaper.connect(tone); tone.connect(gain); gain.connect(pan); pan.connect(out);
  const nodes: AudioNode[] = [shaper, tone, gain, pan], oscillators: OscillatorNode[] = [];
  // The fundamental, the V6's half order, and two harmonics; plus the turbo and MGU-H whistle.
  for (const [mult, type, amount] of [[1, 'sawtooth', 0.5], [0.5, 'square', 0.22], [2, 'sawtooth', 0.16], [3, 'triangle', 0.08], [7, 'sine', 0.035]] as const) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type; g.gain.value = amount;
    const base = f * mult;
    osc.frequency.setValueAtTime(base * up, at);
    osc.frequency.linearRampToValueAtTime(base * up * 1.035, mid - 0.12); // still accelerating down the straight
    osc.frequency.setTargetAtTime(base * down, mid - 0.05, 0.08);
    osc.connect(g); g.connect(mult === 7 ? tone : shaper);
    osc.start(at); osc.stop(end + 0.05);
    oscillators.push(osc); nodes.push(osc, g);
  }
  cleanup(oscillators[0], nodes);
}

/** An impact wrench: hammer blows (about 45 a second) on a burst of air, with the motor's whine. */
function wheelGun(ctx: BaseAudioContext, out: AudioNode, at: number, length: number, noise: AudioBuffer, pan: number) {
  const src = ctx.createBufferSource(), band = ctx.createBiquadFilter(), hammer = ctx.createGain(), env = ctx.createGain(), panner = ctx.createStereoPanner();
  const lfo = ctx.createOscillator(), depth = ctx.createGain(), whine = ctx.createOscillator(), whineHp = ctx.createBiquadFilter(), whineGain = ctx.createGain();
  src.buffer = noise; src.loop = true;
  band.type = 'bandpass'; band.frequency.value = 1900 + Math.random() * 500; band.Q.value = 2.2;
  lfo.type = 'square'; lfo.frequency.value = 42 + Math.random() * 8; depth.gain.value = 0.5; hammer.gain.value = 0.5;
  whine.type = 'sawtooth'; whine.frequency.setValueAtTime(170, at); whine.frequency.linearRampToValueAtTime(235, at + length);
  whineHp.type = 'highpass'; whineHp.frequency.value = 500; whineGain.gain.value = 0.18;
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(0.5, at + 0.015);
  env.gain.setValueAtTime(0.5, at + length - 0.04);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  panner.pan.value = pan;
  lfo.connect(depth); depth.connect(hammer.gain);
  src.connect(band); band.connect(hammer); whine.connect(whineHp); whineHp.connect(whineGain); whineGain.connect(hammer);
  hammer.connect(env); env.connect(panner); panner.connect(out);
  for (const node of [src, lfo, whine]) { node.start(at); node.stop(at + length + 0.02); }
  cleanup(src, [src, band, hammer, env, panner, lfo, depth, whine, whineHp, whineGain]);
}

/** The jacks dropping the car: a low thump. */
function thump(ctx: BaseAudioContext, out: AudioNode, at: number) {
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = 'sine'; osc.frequency.setValueAtTime(95, at); osc.frequency.exponentialRampToValueAtTime(38, at + 0.18);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.55, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
  osc.connect(g); g.connect(out); osc.start(at); osc.stop(at + 0.32);
  cleanup(osc, [osc, g]);
}

/** Pit-lane limiter: the engine held at low revs, cutting in and out. Then the launch out of the box. */
function engineTone(ctx: BaseAudioContext, out: AudioNode, at: number, length: number, from: number, to: number, limiter: boolean, panTo: number) {
  const a = ctx.createOscillator(), b = ctx.createOscillator(), mixer = ctx.createGain(), shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), env = ctx.createGain(), pan = ctx.createStereoPanner();
  a.type = 'sawtooth'; b.type = 'square';
  for (const [osc, mult] of [[a, 1], [b, 0.5]] as const) { osc.frequency.setValueAtTime(from * mult, at); osc.frequency.exponentialRampToValueAtTime(to * mult, at + length); }
  mixer.gain.value = 0.4; shaper.curve = drive; tone.type = 'lowpass'; tone.frequency.setValueAtTime(1100, at); tone.frequency.exponentialRampToValueAtTime(limiter ? 1300 : 5000, at + length * 0.6);
  env.gain.setValueAtTime(0.0001, at);
  const level = limiter ? 0.16 : 0.24;
  env.gain.exponentialRampToValueAtTime(level, at + (limiter ? 0.4 : 0.25));
  // The limiter holds until the car stops in its box; the launch fades as the car leaves.
  if (limiter) env.gain.setValueAtTime(level, at + length - 0.15);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  pan.pan.setValueAtTime(limiter ? -0.6 : 0, at); pan.pan.linearRampToValueAtTime(panTo, at + length);
  a.connect(mixer); b.connect(mixer); mixer.connect(shaper); shaper.connect(tone); tone.connect(env); env.connect(pan); pan.connect(out);
  const nodes: AudioNode[] = [a, b, mixer, shaper, tone, env, pan];
  if (limiter) {
    // The limiter cuts ignition several times a second: the stutter of a car in the pit lane.
    const lfo = ctx.createOscillator(), depth = ctx.createGain(), chop = ctx.createGain();
    lfo.type = 'square'; lfo.frequency.value = 9; depth.gain.value = 0.35; chop.gain.value = 0.65;
    env.disconnect(); env.connect(chop); chop.connect(pan); lfo.connect(depth); depth.connect(chop.gain);
    lfo.start(at); lfo.stop(at + length + 0.02); nodes.push(lfo, depth, chop);
  }
  for (const osc of [a, b]) { osc.start(at); osc.stop(at + length + 0.02); }
  cleanup(a, nodes);
}

/** One of our cars in the box: limiter in, four wheel guns off and back on, the jacks drop, and away. About 4.5 s. */
export function pitStop(ctx: BaseAudioContext, out: AudioNode, at: number, noise: AudioBuffer) {
  engineTone(ctx, out, at, 1.8, 230, 245, true, -0.1);
  const guns = [-0.5, 0.45, -0.3, 0.6];
  guns.forEach((pan, i) => wheelGun(ctx, out, at + 1.85 + i * 0.055, 0.36, noise, pan)); // wheels off
  guns.forEach((pan, i) => wheelGun(ctx, out, at + 2.5 + i * 0.045, 0.2, noise, pan)); // new wheels on
  thump(ctx, out, at + 2.9);
  engineTone(ctx, out, at + 2.95, 1.6, 260, 620, false, 0.9);
}

export class PitwallSound {
  private context: AudioContext | null = null;
  private master: GainNode | null = null; // headset on or off
  private ambience: GainNode | null = null; // ducked under the radio
  private noise: AudioBuffer | null = null;
  private enabled = false; private talking = false; private running = false;
  private lap = -1; private lastPass = 0; private nextDistant = 0;

  setEnabled(enabled: boolean) { this.enabled = enabled; if (enabled) this.ensure(); this.mix(); }
  setTalking(talking: boolean) { this.talking = talking; this.mix(); }

  /** Called as the race renders. `distance` is the selected car's race distance in laps. */
  update(running: boolean, safety: boolean, distance: number) {
    this.running = running;
    const lap = Math.floor(distance);
    if (!this.context || !this.enabled || !running) { this.lap = lap; this.mix(); return; }
    this.mix();
    const now = this.context.currentTime;
    // Our car crossing the line, right past the pit wall.
    if (lap > this.lap && this.lap >= 0 && now - this.lastPass > 2.5) { passBy(this.context, this.ambience!, now + 0.02, 1, safety); this.lastPass = now; }
    this.lap = lap;
    // The rest of the field, further away down the straight.
    if (now > this.nextDistant) {
      if (now - this.lastPass > 1.2) passBy(this.context, this.ambience!, now + 0.02, 0.3 + Math.random() * 0.3, safety);
      this.nextDistant = now + (safety ? 9 : 3.5) + Math.random() * (safety ? 8 : 6);
    }
  }

  /** One of our cars arrives in its pit box. */
  pitStop() {
    if (!this.enabled) return;
    this.ensure();
    pitStop(this.context!, this.ambience!, this.context!.currentTime + 0.05, this.noise!);
  }

  cue(kind: 'open' | 'close' | 'alert' = 'open') {
    if (!this.enabled) return; this.ensure(); const ctx = this.context!;
    const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.type = 'sine'; osc.frequency.value = kind === 'alert' ? 740 : kind === 'open' ? 1320 : 880;
    gain.gain.setValueAtTime(0, ctx.currentTime); gain.gain.linearRampToValueAtTime(.055, ctx.currentTime + .008); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .1);
    osc.connect(gain); gain.connect(this.master!); osc.start(); osc.stop(ctx.currentTime + .12); osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  private ensure() {
    if (!this.context) {
      const ctx = new AudioContext(); this.context = ctx;
      this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
      this.ambience = ctx.createGain(); this.ambience.gain.value = 0; this.ambience.connect(this.master);
      this.noise = noiseBuffer(ctx, 1);
      // The circuit in the distance: wind, crowd and far-off engines, as a low bed under everything.
      const bed = ctx.createBufferSource(), low = ctx.createBiquadFilter(), bedGain = ctx.createGain();
      bed.buffer = noiseBuffer(ctx, 3, true); bed.loop = true; low.type = 'lowpass'; low.frequency.value = 420; bedGain.gain.value = 0.12;
      bed.connect(low); low.connect(bedGain); bedGain.connect(this.ambience); bed.start();
    }
    void this.context.resume().catch(() => {});
  }

  private mix() {
    if (!this.context || !this.master || !this.ambience) return;
    const t = this.context.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? .35 : 0, t, .12);
    this.ambience.gain.setTargetAtTime(this.running ? (this.talking ? .18 : 1) : 0, t, .18);
  }
}
