// Model files saved on this computer by `npm run models` (scripts/fetch-models.mjs). The dev and
// preview servers serve them at /models/. When they are there, the voice and team chat workers
// read them instead of downloading ~1.5 GB from Hugging Face. A deployed site without them, or a
// file that was not saved, falls back to Hugging Face as before.
import { BASE } from './base.ts';
export interface LocalModels { base: string; files: string[] }

const HUB = 'https://huggingface.co/';

/** The local address of a Hugging Face file, or null when that file is not on this computer. */
export function localURL(url: string, local: LocalModels | null): string | null {
  if (!local || !url.startsWith(HUB)) return null;
  // https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file> → <owner>/<repo>/<file>
  const match = /^([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url.slice(HUB.length).split('?')[0]);
  if (!match) return null;
  const path = `${match[1]}/${match[2]}`;
  return local.files.includes(path) ? local.base + path : null;
}

/** Read the manifest the download script writes. A 404, or a host's HTML fallback page, means no local models. */
export async function findLocalModels(base = `${BASE}models/`): Promise<LocalModels | null> {
  try {
    const response = await fetch(base + 'manifest.json', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return null;
    const manifest = await response.json() as { files?: unknown };
    if (!Array.isArray(manifest.files)) return null;
    const files = manifest.files.filter((f): f is string => typeof f === 'string');
    return files.length ? { base: new URL(base, location.href).href, files } : null;
  } catch {
    return null;
  }
}

// transformers.js types its fetch as (string | URL, any) => Promise<any>.
type ModelEnv = { fetch: (input: string | URL, init?: any) => Promise<any>; useBrowserCache: boolean };
let routed = false;
/**
 * Send this worker's model requests for saved files to the local copies. transformers.js fetches
 * through `env.fetch`; kokoro-js fetches its voice files with the global fetch, so both are routed.
 * Returns true when every file in `needed` is local: then the browser cache is skipped, so the
 * files are not copied a second time into browser storage.
 */
export function routeToLocal(local: LocalModels | null, env: ModelEnv, needed: string[]) {
  if (!local) return false;
  if (!routed) {
    const original = globalThis.fetch.bind(globalThis);
    const route = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return original(localURL(url, local) ?? input, init);
    }) as typeof fetch;
    env.fetch = route;
    globalThis.fetch = route;
    routed = true;
  }
  const all = needed.every(file => local.files.includes(file));
  if (all) env.useBrowserCache = false;
  return all;
}
