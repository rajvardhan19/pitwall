// Saves the voice and team chat models to models/ so the game loads them from this computer
// instead of downloading ~1.5 GB from Hugging Face in the browser. `npm run dev` runs this first:
// files already on disk are skipped, so once everything is saved it makes no network requests.
// A failed download never blocks the dev server; the browser falls back to Hugging Face.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODEL_FILES } from './model-files.mjs';

const ROOT = new URL('../models/', import.meta.url);
const exists = path => stat(new URL(path, ROOT)).then(s => s.isFile(), () => false);
const mb = n => `${Math.round(n / 1e6)} MB`;

async function download(path) {
  const [owner, repo, ...rest] = path.split('/');
  const response = await fetch(`https://huggingface.co/${owner}/${repo}/resolve/main/${rest.join('/')}`);
  if (!response.ok || !response.body) throw new Error(`${path}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const target = new URL(path, ROOT), part = new URL(path + '.part', ROOT);
  await mkdir(new URL('.', target), { recursive: true });
  let received = 0, shown = -1;
  const label = path.split('/').slice(1).join('/');
  const progress = new TransformStream({
    transform(chunk, controller) {
      received += chunk.length;
      const pct = total ? Math.floor(received / total * 100) : 0;
      if (total > 20e6 && pct !== shown && pct % 10 === 0) { shown = pct; console.log(`  ${label} · ${mb(total)} · ${pct}%`); }
      controller.enqueue(chunk);
    },
  });
  // Write to .part and rename at the end, so an interrupted download is never mistaken for a file.
  await pipeline(Readable.fromWeb(response.body.pipeThrough(progress)), createWriteStream(part));
  if (total && received !== total) { await rm(part, { force: true }); throw new Error(`${path}: got ${received} of ${total} bytes`); }
  await rename(part, target);
}

async function main() {
  const missing = [];
  for (const path of MODEL_FILES) if (!(await exists(path))) missing.push(path);
  if (missing.length) {
    console.log(`Saving ${missing.length} model file${missing.length === 1 ? '' : 's'} to models/ (about 1.5 GB the first time) so voices and team chat load from this computer.`);
    for (const path of missing) {
      try { await download(path); }
      catch (e) { console.warn(`  Could not save ${path}: ${e instanceof Error ? e.message : e}. The browser will download it instead.`); }
    }
  }
  // The manifest lists what is on disk; the game reads only files it names.
  const files = [];
  for (const path of MODEL_FILES) if (await exists(path)) files.push(path);
  await mkdir(ROOT, { recursive: true });
  await writeFile(new URL('manifest.json', ROOT), JSON.stringify({ version: 1, files }, null, 1) + '\n');
  if (missing.length) console.log(`models/: ${files.length} of ${MODEL_FILES.length} files ready.`);
}

if (!process.env.PITWALL_SKIP_MODELS) {
  // Never stop the dev server from starting: the game can always download in the browser.
  await main().catch(e => console.warn(`Model setup skipped: ${e instanceof Error ? e.message : e}`));
}
