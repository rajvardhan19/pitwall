// Which radio a device gets, and how far its setup has got.
// Full: neural voices and team chat, downloaded and set up before the first race (about 1.4 GB).
// Lite (phones, tablets and devices without usable GPU access): the team as text, with the
// recorded team clips; nothing large is downloaded.
export type Tier = 'full' | 'lite';
export interface DeviceInfo { mobile: boolean; webgpu: boolean; fallbackAdapter: boolean; memoryGB?: number }
export interface TierChoice { tier: Tier; reason: string; forced: boolean }

/** `override` comes from ?radio=full|lite or an earlier “load anyway” on this browser. */
export function chooseTier(d: DeviceInfo, override?: string | null): TierChoice {
  if (override === 'full' || override === 'lite') return { tier: override, reason: override === 'full' ? 'chosen on this browser' : 'text radio chosen', forced: true };
  if (d.mobile) return { tier: 'lite', reason: 'phone or tablet', forced: false };
  if (!d.webgpu) return { tier: 'lite', reason: 'this browser offers no GPU access (WebGPU)', forced: false };
  if (d.fallbackAdapter) return { tier: 'lite', reason: 'only a software GPU is available', forced: false };
  // navigator.deviceMemory is rounded down and capped at 8; team chat alone needs about 1 GB.
  if (d.memoryGB !== undefined && d.memoryGB < 4) return { tier: 'lite', reason: `${d.memoryGB} GB of memory`, forced: false };
  return { tier: 'full', reason: 'desktop with GPU access', forced: false };
}

type Nav = Navigator & {
  userAgentData?: { mobile?: boolean };
  deviceMemory?: number;
  gpu?: { requestAdapter(): Promise<{ isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } } | null> };
};
export async function probeDevice(nav: Nav = navigator as Nav): Promise<DeviceInfo> {
  // iPadOS reports a Mac user agent; its touch screen gives it away.
  const mobile = nav.userAgentData?.mobile ?? (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1));
  const adapter = nav.gpu
    ? await Promise.race([nav.gpu.requestAdapter().catch(() => null), new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))])
    : null;
  return { mobile, webgpu: !!adapter, fallbackAdapter: !!(adapter?.isFallbackAdapter || adapter?.info?.isFallbackAdapter), memoryGB: nav.deviceMemory };
}

export type Downloads = Map<string, { loaded: number; total: number }>;
/** Share of the model weights downloaded. Only large files count: a 150 KB model graph that finishes first must not read as 100%. */
export function weightsProgress(files: Downloads) {
  let loaded = 0, total = 0;
  for (const f of files.values()) if (f.total > 5e6) { loaded += Math.min(f.loaded, f.total); total += f.total; }
  return total ? loaded / total : 0;
}

export interface SetupState {
  voice: { progress: number; ready: boolean };
  chat: { progress: number; warming: boolean; ready: boolean };
}
/** Overall setup progress, 0–1, weighted by download size (voices ~0.3 GB, team chat ~1.1 GB). Setup steps after each download take the last part of its share. */
export function setupProgress(s: SetupState) {
  const voice = s.voice.ready ? 1 : 0.85 * s.voice.progress;
  const chat = s.chat.ready ? 1 : s.chat.warming ? 0.92 : 0.85 * s.chat.progress;
  return 0.25 * voice + 0.75 * chat;
}
/** Start lights: one per fifth of the setup; all five once both are ready. */
export function lightsOn(fraction: number) {
  return Math.max(0, Math.min(5, Math.floor(fraction * 5 + 1e-9)));
}
