// Local development only: what a Cloudflare quick tunnel points at, so that only webhook deliveries
// reach the API from the internet. Forwards POST /api/v1/webhooks/<provider> to the API unchanged and
// answers 404 to everything else. Usage: npm run webhooks:gateway (see docs/PROVIDER_SETUP_GUIDE.md).
import http from 'node:http';

const LISTEN_PORT = Number(process.env.WEBHOOK_GATEWAY_PORT ?? 4080);
const API_PORT = Number(process.env.WEBHOOK_GATEWAY_API_PORT ?? 4000);
const WEBHOOK_PATH = /^\/api\/v1\/webhooks\/[a-z][a-z0-9_]{1,31}\/?$/;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !WEBHOOK_PATH.test(req.url)) {
    req.resume();
    res.writeHead(404).end();
    return;
  }
  const upstream = http.request({ host: '127.0.0.1', port: API_PORT, path: req.url, method: 'POST', headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

// Loopback only: the tunnel connects from this machine.
server.listen(LISTEN_PORT, '127.0.0.1', () => console.log(`webhook gateway on 127.0.0.1:${LISTEN_PORT} -> API port ${API_PORT}`));
