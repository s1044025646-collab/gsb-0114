import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { migrate, openDatabase } from '../src/db/connection.ts';

test('migrations are repeatable on :memory: and existing file DBs', () => {
  const mem = openDatabase(':memory:');
  assert.equal(migrate(mem), 1);
  assert.equal(migrate(mem), 1);

  const file = join(tmpdir(), `cnc-mig-${process.pid}-${Date.now()}.db`);
  try {
    const db1 = openDatabase(file);
    migrate(db1);
    db1.prepare("INSERT INTO machines(code, name, created_at) VALUES ('M1','Mill','2026-01-01T00:00:00Z')").run();
    db1.close();

    const db2 = openDatabase(file);
    migrate(db2);
    const row = db2.prepare('SELECT COUNT(*) AS c FROM machines').get() as { c: number };
    assert.equal(row.c, 1);
    db2.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});
