// tests/e2e/server.mjs
// Servidor HTTP local mínimo para os fixtures do teste E2E — serve os
// arquivos de tests/e2e/fixtures/ e simula um CDN de vídeo de verdade:
// responde range request (206 + Content-Range) como fbcdn.net/Instagram e
// outros CDNs fazem, para exercitar o mesmo código de dedupe/tamanho que
// o service worker usa em produção (ver utils/id.js e o handler de
// webRequest em background/service-worker.js).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, 'fixtures');

const MIME = {
  '.html': 'text/html',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
};

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = decodeURIComponent(url.pathname);
    if (file === '/') file = '/page.html';
    file = file.replace(/^\/cdn\//, '/'); // /cdn/feed1.mp4 -> fixtures/feed1.mp4
    const full = path.join(root, file);
    if (!full.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(full, (statErr, stat) => {
      if (statErr) {
        res.writeHead(404);
        res.end('not found: ' + file);
        return;
      }
      const ext = path.extname(full);
      const contentType = MIME[ext] || 'application/octet-stream';
      const range = req.headers.range;

      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(full, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(full).pipe(res);
    });
  });
}

/** Sobe o servidor numa porta livre e resolve com { server, port }. */
export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// Permite rodar standalone (`node server.mjs [porta]`) para debug manual.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8873;
  createServer().listen(port, () => console.log(`fixture server em http://localhost:${port}`));
}
