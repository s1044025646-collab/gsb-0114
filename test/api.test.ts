import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase, migrate, type Db } from '../src/db/connection.ts';
import { FixedClock } from '../src/domain/clock.ts';
import { handleRequest } from '../src/api/app.ts';

async function startServer(db: Db): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => void handleRequest({ db }, req, res));
  await new Promise<void>((resolveFn) => server.listen(0, '127.0.0.1', () => resolveFn()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function jsonFetch(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

test('API: validation, error codes, pagination and happy path', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  void new FixedClock();
  const { server, base } = await startServer(db);
  try {
    const bad = await jsonFetch(base, '/machines', { method: 'POST', body: JSON.stringify({ code: '' }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

    const ok = await jsonFetch(base, '/machines', {
      method: 'POST',
      body: JSON.stringify({ code: 'MC1', name: 'Mill' }),
    });
    assert.equal(ok.status, 201);

    const dup = await jsonFetch(base, '/machines', {
      method: 'POST',
      body: JSON.stringify({ code: 'MC1', name: 'Mill' }),
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'CONFLICT');

    for (let i = 0; i < 5; i++) {
      await jsonFetch(base, '/work-orders', {
        method: 'POST',
        body: JSON.stringify({ code: `W${i}`, partNo: 'P', qty: 1 }),
      });
    }
    const page = await jsonFetch(base, '/work_orders?limit=2&offset=1');
    assert.equal(page.status, 200);
    assert.equal(page.body.data.length, 2);
    assert.equal(page.body.pagination.hasMore, true);

    const badPage = await jsonFetch(base, '/work_orders?limit=9999');
    assert.equal(badPage.status, 400);

    const notFound = await jsonFetch(base, '/nope');
    assert.equal(notFound.status, 404);
  } finally {
    server.close();
    db.close();
  }
});
