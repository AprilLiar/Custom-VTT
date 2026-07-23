import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.get('/api/health', async (_req, res) => {
  try {
    await db.execute('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', message: err.message });
  }
});

// Serve the built frontend (single deployable app)
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

async function getPingState() {
  const result = await db.execute(
    'SELECT COUNT(*) AS count, MAX(created_at) AS last_at FROM pings'
  );
  const row = result.rows[0];
  return { count: Number(row.count), lastAt: row.last_at ?? null };
}

io.on('connection', async (socket) => {
  // New client gets the current state immediately
  socket.emit('ping:update', await getPingState());

  // The Phase 0 round-trip: write to the DB, broadcast to every client
  socket.on('ping:send', async ({ label } = {}) => {
    await db.execute({
      sql: 'INSERT INTO pings (client_label) VALUES (?)',
      args: [String(label ?? 'anonymous').slice(0, 100)],
    });
    io.emit('ping:update', await getPingState());
  });
});

await initDb();
httpServer.listen(PORT, () => {
  console.log(`Custom VTT server listening on port ${PORT}`);
});
