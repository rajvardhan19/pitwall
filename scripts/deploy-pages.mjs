// Publishes the game to GitHub Pages: builds it for the repository's subpath
// (https://<owner>.github.io/<repo>/) into a temporary folder and pushes that to the
// gh-pages branch. The local dist/ is left alone. Players' browsers download the voice and
// team chat models from Hugging Face; nothing large is hosted here.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const read = (cmd, args) => execFileSync(cmd, args).toString().trim();
const origin = read('git', ['remote', 'get-url', 'origin']);
const repo = origin.replace(/\.git$/, '').split('/').pop();
const source = read('git', ['rev-parse', '--short', 'HEAD']);
const out = mkdtempSync(join(tmpdir(), 'pitwall-pages-'));
try {
  run('node', ['scripts/prepare-voice-runtime.mjs']);
  run('npx', ['tsc', '--noEmit']);
  run('npx', ['vite', 'build', `--base=/${repo}/`, `--outDir=${out}`, '--emptyOutDir']);
  writeFileSync(join(out, '.nojekyll'), ''); // serve every file as-is
  run('git', ['init', '-q', '-b', 'gh-pages'], { cwd: out });
  run('git', ['add', '-A'], { cwd: out });
  run('git', ['commit', '-q', '-m', `Deploy ${source}`], { cwd: out });
  run('git', ['push', '-q', '--force', origin, 'gh-pages'], { cwd: out });
  const owner = origin.replace(/\.git$/, '').split('/').slice(-2, -1)[0];
  console.log(`Published ${source} to https://${owner.toLowerCase()}.github.io/${repo}/ (GitHub Pages takes a minute or two to update).`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
