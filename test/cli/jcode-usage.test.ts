// jcode-usage.test.ts — the read-only jcode ledger import: rows land under host `jcode`,
// repeated syncs stay idempotent, and the source ledger is never written.
import { expect, test } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { jcodeLedgerPath, readUsageDb, syncUsageDb, usageDbPath } from '../../extensions/shared/usage-store.ts';
import { sqliteExec, sqliteRead } from '../../extensions/shared/sqlite.ts';
import { hasSqlite, withHome } from '../helpers/env.ts';

const LEDGER_SCHEMA =
  'CREATE TABLE IF NOT EXISTS turns (' +
  'ts TEXT NOT NULL, session_id TEXT, model TEXT, cwd TEXT, status TEXT, duration_ms INTEGER, ' +
  'prompt_tokens INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, ' +
  'cache_read_tokens INTEGER, cache_write_tokens INTEGER);';

/** The same shape `scripts/tersio/usage-log.sh` creates, seeded with the given turn rows. */
function seedLedger(home: string, rows: string[]): string {
  // withHome sets TERSIO_HOME, so the ledger resolves to <home>/.tersio/jcode-usage.db; its dir may not exist yet.
  const db = jcodeLedgerPath();
  mkdirSync(path.dirname(db), { recursive: true });
  sqliteExec(db, LEDGER_SCHEMA);
  for (const row of rows) sqliteExec(db, row);
  return db;
}

function sourceDigest(db: string): string {
  // Portable across the in-process engine and the sqlite3 CLI: no md5sum(), just the rows themselves.
  return sqliteRead(
    db,
    "SELECT group_concat(tuple, ' · ') FROM (SELECT ts || '|' || session_id || '|' || model || '|' || ifnull(cwd,'') || '|' || ifnull(status,'') || '|' || ifnull(duration_ms,'') || '|' || ifnull(prompt_tokens,'') || '|' || input_tokens || '|' || output_tokens || '|' || ifnull(cache_read_tokens,'') || '|' || ifnull(cache_write_tokens,'') AS tuple FROM turns ORDER BY rowid);",
  )[0]?.[0] ?? '';
}

test.skipIf(!hasSqlite())('jcode turns import under host jcode with tokens, duration, and status', () => {
  withHome((home) => {
    const db = seedLedger(home, [
      "INSERT INTO turns (ts, session_id, model, cwd, status, duration_ms, prompt_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES " +
        "('2026-11-20T10:00:00.000Z','sess-1','gpt-5.2','/tmp/proj','completed',4200,120,100,50,900,30)",
      "INSERT INTO turns (ts, session_id, model, cwd, status, duration_ms, prompt_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES " +
        "('2026-11-20T10:05:00.000Z','sess-1','gpt-5.2','/tmp/proj','error',800,10,10,2,NULL,NULL)",
    ]);
    const digestBefore = sourceDigest(db);
    expect(syncUsageDb()).toBe(true);
    const usage = readUsageDb();
    expect(usage?.tokens.messages).toBe(2);
    expect(usage?.tokens.totals.input).toBe(110);
    expect(usage?.tokens.totals.output).toBe(52);
    expect(usage?.tokens.totals.cacheRead).toBe(900);
    expect(usage?.tokens.totals.cacheWrite).toBe(30);
    const key = 'gpt-5.2';
    const hostTokens = usage?.tokens.byHost[key]?.jcode;
    expect(hostTokens?.input).toBe(110);
    expect(hostTokens?.output).toBe(52);
    expect(hostTokens?.cacheRead).toBe(900);
    expect(hostTokens?.cacheWrite).toBe(30);
    // The source ledger keeps its bytes: same rows, still jcode-owned.
    expect(sourceDigest(db)).toBe(digestBefore);
  });
});

test.skipIf(!hasSqlite())('a repeated sync adds no duplicate jcode rows', () => {
  withHome((home) => {
    seedLedger(home, [
      "INSERT INTO turns (ts, session_id, model, cwd, status, duration_ms, prompt_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES " +
        "('2026-11-20T11:00:00.000Z','sess-2','glm-5.3-flash','/tmp/w','completed',1500,50,40,20,100,10)",
    ]);
    expect(syncUsageDb()).toBe(true);
    expect(syncUsageDb()).toBe(true);
    expect(syncUsageDb()).toBe(true);
    const usage = readUsageDb();
    expect(usage?.tokens.messages).toBe(1);
    expect(usage?.tokens.totals.input).toBe(40);
    // One synthetic files row per import; the repeated syncs must not add more.
    const files = sqliteRead(usageDbPath(), 'SELECT count(*) FROM files;')[0]?.[0];
    expect(Number(files)).toBe(1);
  });
});

test.skipIf(!hasSqlite())('blank models read as unknown and invalid timestamps stay undated', () => {
  withHome((home) => {
    seedLedger(home, [
      "INSERT INTO turns (ts, session_id, model, cwd, status, duration_ms, prompt_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES " +
        "('not-a-date','sess-3','','/tmp/x','completed',100,5,5,5,0,0)",
    ]);
    expect(syncUsageDb()).toBe(true);
    const modelText = sqliteRead(usageDbPath(), 'SELECT model, t FROM messages;');
    const firstRow = modelText.split('\n').filter((l) => l.trim() !== '')[0]?.split('\t');
    expect(firstRow?.[0]).toBe('unknown');
    // Invalid timestamps stay without a date rather than gaining the current time.
    expect(firstRow?.[1]).toBe('');
  });
});

test.skipIf(!hasSqlite())('a missing ledger is a clean no-op and transcript sync still succeeds', () => {
  withHome((home) => {
    // The TERSIO_HOME override resolves inside the fixture home, so nothing exists there yet.
    expect(existsSync(jcodeLedgerPath())).toBe(false);
    expect(syncUsageDb()).toBe(true);
    expect(readUsageDb()?.tokens.messages ?? 0).toBe(0);
    expect(home.length).toBeGreaterThan(0);
  });
});
