import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
const root = resolve(import.meta.dirname, "frontend");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const upstream = http.request({ hostname: "127.0.0.1", port: 3000, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream); return;
  }
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400).end(); return; }
  let file = resolve(root, "." + pathname);
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { if (!statSync(file).isFile()) throw Error(); } catch { file = resolve(root, "index.html"); }
  res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
  const stream = createReadStream(file); stream.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); }); stream.pipe(res);
}).listen(8080, "127.0.0.1");
