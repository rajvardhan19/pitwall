// Serves models/ at /models/ for the dev and preview servers (never part of the build).
// Supports byte ranges: transformers.js probes each file's size with `Range: bytes=0-0`.
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

export function modelsMiddleware(root) {
  const base = resolve(root);
  return (req, res, next) => {
    if (!req.url?.startsWith('/models/')) return next();
    let file;
    try { file = resolve(base, decodeURIComponent(req.url.slice('/models/'.length).split('?')[0])); }
    catch { res.statusCode = 400; return res.end(); }
    if (!file.startsWith(base + sep)) { res.statusCode = 403; return res.end(); }
    let size;
    try { const s = statSync(file); if (!s.isFile()) throw new Error('not a file'); size = s.size; }
    catch { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', extname(file) === '.json' ? 'application/json' : 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    let start = 0, end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]));
      else { start = Number(range[1]); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
      if (start > end) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
    if (req.method === 'HEAD' || size === 0) return res.end();
    createReadStream(file, { start, end }).pipe(res);
  };
}
