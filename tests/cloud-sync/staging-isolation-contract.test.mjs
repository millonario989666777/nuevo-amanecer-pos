import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync('tools/cloudflare-staging/environment-contract.json', 'utf8'));
const backend = readFileSync('tools/cloudflare-staging/wrangler.backend.template.jsonc', 'utf8');
const web = readFileSync('tools/cloudflare-staging/wrangler.web.template.jsonc', 'utf8');
const all = JSON.stringify(contract) + backend + web;

test('staging contract uses isolated resource names and synthetic data only', () => {
  assert.equal(contract.environment, 'staging');
  assert.equal(contract.d1_binding, 'DB');
  assert.equal(contract.data_policy, 'synthetic-only');
  assert.equal(contract.production_resource_access, false);
  assert.equal(contract.immutable_artifact_required, true);
  for (const value of [contract.frontend_worker_name, contract.backend_worker_name, contract.d1_database_name, contract.r2_bucket_name]) {
    assert.match(value, /staging/);
  }
});

test('staging templates cannot resolve to known production or LAB resources', () => {
  for (const forbidden of [
    'cf2c83d3-f187-472e-967b-0ad24be969eb',
    'e734e6f1-41c4-4bfa-ab1f-5acbcdd2272e',
    'nuevo-amanecer-prod-v2',
    'nuevo-amanecer-prod-v2-backups',
    'nuevo-amanecer-lab',
    'nuevo-amanecer-pos-prod',
    'nuevo-amanecer-pos-web.nuevo-amanecer-pos.workers.dev'
  ]) assert.equal(all.includes(forbidden), false, forbidden);
  assert.match(backend, /__STAGING_D1_DATABASE_ID__/);
  const parsedWeb = JSON.parse(web);
  assert.deepEqual(parsedWeb.services, [
    { binding: 'CANON_BACKEND', service: 'nuevo-amanecer-pos-staging' }
  ]);
  assert.deepEqual(parsedWeb.assets.run_worker_first, [
    '/', '/app', '/app/', '/runtime-config.js', '/health', '/auth/*', '/read/*', '/features/*',
    '/commands/*', '/imports/*', '/sync/operations*', '/settings'
  ]);
  assert.doesNotMatch(all, /CLOUDFLARE_API_TOKEN|POS_ACTIVATION_SECRET|LAB_IMPORT_HMAC_SECRET/);
});

test('phase-one staging scaffold contains no deploy command', () => {
  assert.doesNotMatch(all, /wrangler\s+deploy|wrangler\s+d1\s+execute|wrangler\s+r2\s+object\s+put/);
});
