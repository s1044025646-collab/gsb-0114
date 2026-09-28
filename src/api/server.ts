import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrate, openDatabase } from '../db/connection.ts';
import { handleRequest } from './app.ts';

const dbPath = process.env.CNC_DB_PATH ?? resolve(process.cwd(), 'data', 'cnc.db');
const port = Number(process.env.PORT ?? 0);

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const version = migrate(db);

const server = createServer((req, res) => {
  void handleRequest({ db }, req, res);
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`CNC API listening on http://127.0.0.1:${actualPort} (db=${dbPath}, schema=v${version})`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
