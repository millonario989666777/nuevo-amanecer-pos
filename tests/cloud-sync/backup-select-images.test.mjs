import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { backupSelectSql } from '../../tools/cloudflare-prod/scripts/backup-select.mjs';
test('backup excludes image rows and rate counters only', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE pos_settings(key TEXT, value_json TEXT)');
    const keys = ['normal', 'internal:dni:x', 'internal:img:m:abc', 'internal:img:c:abc:etag:0', 'internal:imgrate:abc'];
    for (const key of keys) db.prepare('INSERT INTO pos_settings VALUES (?,?)').run(key, '{}');
    assert.deepEqual(db.prepare(backupSelectSql('pos_settings')).all().map(r => r.key), keys.slice(0, 2));
    assert.equal(backupSelectSql('products'), 'SELECT * FROM "products"');
    assert.equal(backupSelectSql('a"b'), 'SELECT * FROM "a""b"');
  } finally { db.close(); }
});
test('maintenance scripts use the filtered backup selector', () => {
  const dir = new URL('../../tools/cloudflare-prod/scripts/', import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.mjs') && n !== 'backup-select.mjs')) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    assert.ok(!/'SELECT \* FROM "'\s*\+\s*(?:n|name)\b/.test(source), name);
  }
});
