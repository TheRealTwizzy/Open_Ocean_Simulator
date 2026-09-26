// Zero-dependency static file server for the browser tests. Serves the repo
// root over HTTP (ES modules do not load from file://) on 127.0.0.1 and an
// OS-assigned port.
//
//   const server = await startServer();   // { url: 'http://127.0.0.1:PORT/', root, close() }
//   await page.goto(server.url + '?q=low');
//   await server.close();

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// Maps a request URL onto a file under root: { file } or { status } when the
// path is malformed (400) or would escape the root (403).
function toFile(root, reqUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(reqUrl, 'http://localhost').pathname);
  } catch {
    return { status: 400 };                        // malformed %-escape
  }
  if (pathname.includes('\0')) return { status: 400 };
  const file = resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + sep)) return { status: 403 };
  return { file };
}

async function handle(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  let { file, status } = toFile(root, req.url);
  if (status) return send(res, status, status === 400 ? 'Bad Request' : 'Forbidden');
  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      file = resolve(file, 'index.html');
      info = await stat(file);
    }
  } catch {
    return send(res, 404, 'Not Found');
  }
  if (!info.isFile()) return send(res, 404, 'Not Found');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/**
 * Starts the server. Resolves once it is listening.
 * @param {{ root?: string }} [opts] root defaults to the repository root
 * @returns {Promise<{ url: string, root: string, close: () => Promise<void> }>}
 *   url always ends with '/', e.g. 'http://127.0.0.1:41234/'
 */
export async function startServer({ root = ROOT } = {}) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    handle(base, req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Internal Server Error'); else res.destroy(); });
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); ok(); });
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    root: base,
    close: () => new Promise(ok => {
      server.closeAllConnections?.();
      server.close(() => ok());
    }),
  };
}
