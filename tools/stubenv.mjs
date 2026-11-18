// stubenv.mjs — a minimal stand-in for the make.fun trial harness.
//
// The real harness hands the entry a MAKEFUN_ENV_URL with two routes:
// POST /register (the entry announces its port) and GET /done (the entry
// polls it until the trial is over). This stub adds two control routes for
// local testing: GET /port (what the entry registered) and GET /finish
// (flip /done to true so the entry shuts down).
//
// Usage: node tools/stubenv.mjs   — prints "STUBENV_PORT <n>" on stdout.

import { createServer } from 'node:http';

let registeredPort = null;
let done = false;

const server = createServer((req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'POST' && req.url === '/register') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        registeredPort = JSON.parse(Buffer.concat(chunks).toString('utf8')).port;
      } catch {
        registeredPort = null;
      }
      reply(200, {});
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/done') return reply(200, { done });
  if (req.method === 'GET' && req.url === '/port') return reply(200, { port: registeredPort });
  if (req.method === 'GET' && req.url === '/finish') {
    done = true;
    return reply(200, { done });
  }
  reply(404, {});
});

server.listen(0, '127.0.0.1', () => {
  console.log(`STUBENV_PORT ${server.address().port}`);
});
