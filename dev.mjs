// Local development server:  node dev.mjs   ->  http://localhost:5173
// Serves the static site and runs the same /api/* handlers that Vercel runs in production.
// No dependencies. Code written with AI assistance (Claude), reviewed by team Sigma Boys.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const t0 = Date.now();
  res.on('finish', () => console.log(`${res.statusCode} ${req.method} ${url.pathname}${url.search.slice(0, 80)} ${Date.now() - t0}ms`));
  try {
    // Local-only helper (not deployed): lets the team save exported images into ./media for slides.
    if (url.pathname === '/__save' && req.method === 'POST') {
      const name = (url.searchParams.get('name') || '').replace(/[^\w.-]/g, '_');
      if (!/\.(png|gif|jpg|json)$/.test(name)) { res.statusCode = 400; return res.end('bad name'); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(ROOT, 'media'), { recursive: true });
      await writeFile(join(ROOT, 'media', name), Buffer.concat(chunks));
      res.statusCode = 200; return res.end('saved ' + name);
    }
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
      if (!name || name.startsWith('_')) { res.statusCode = 404; return res.end('not found'); }
      const file = join(ROOT, 'api', name + '.js');
      await stat(file);
      const mod = await import(pathToFileURL(file).href + '?v=' + (await stat(file)).mtimeMs);
      req.query = Object.fromEntries(url.searchParams);
      return await mod.default(req, res);
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/') || p === '') p += 'index.html';
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end('forbidden'); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) res.statusCode = e && e.code === 'ENOENT' ? 404 : 500;
    res.end(e && e.code === 'ENOENT' ? 'not found' : 'server error: ' + (e && e.message));
  }
}).listen(PORT, () => console.log(`\n  Planet X / SPHEREx viewer running at  http://localhost:${PORT}\n  (Ctrl+C to stop)\n`));
