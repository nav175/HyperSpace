// Local API server, for trying the endpoints before Karn's Next.js app exists.
// It serves the same functions the Next.js routes will call (lib/api.mjs).
//   npm run api    → http://localhost:8787/api/node/68212199
import { createServer } from 'node:http';
import { getNode } from './lib/api.mjs';

const PORT = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const send = (status, body) => {
    // Any origin, so Navjot's and Karn's dev servers on other ports can call it.
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const node = pathname.match(/^\/api\/node\/([^/]+)$/);
    if (req.method === 'GET' && node) {
      const found = await getNode(node[1]);
      return found ? send(200, found) : send(404, { error: 'Node not found' });
    }
    send(404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    send(500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`API on http://localhost:${PORT}  (try /api/node/68212199)`));
