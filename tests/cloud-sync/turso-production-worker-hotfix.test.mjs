import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow=readFileSync('.github/workflows/v1.3-turso-prod-worker-hotfix.yml','utf8');

test('Turso Worker hotfix is owner-authorized, branch-pinned and one-shot',()=>{
  assert.match(workflow,/v1\.3-turso-prod-worker-hotfix-trigger\.json/);
  assert.match(workflow,/owner_authorized/);
  assert.match(workflow,/one_shot/);
  assert.match(workflow,/merge-base','--is-ancestor/);
  assert.match(workflow,/Require exact latency-fix code in authorized history/);
});

test('hotfix deploys only the Turso production config and performs no migrations or live business writes',()=>{
  const configs=[...workflow.matchAll(/--config\s+([^\s]+)/g)].map(m=>m[1]);
  assert.ok(configs.length>=3);
  assert.ok(configs.every(value=>value.includes('wrangler.turso-prod.jsonc')),JSON.stringify(configs));
  assert.doesNotMatch(workflow,/wrangler\.jsonc(?:\s|$)/);
  assert.doesNotMatch(workflow,/migrations\s+apply|d1\s+migrations|sale\.create|payment\.batch|inventory\.adjust|auth\/activate|DELETE FROM auth_sessions/i);
  assert.match(workflow,/no_schema_changes/);
  assert.match(workflow,/no_live_sale/);
});

test('focused regressions and dry-run happen before deploy, then health verification and Turso-only rollback',()=>{
  const regressions=workflow.indexOf('Focused Turso sale and session regressions');
  const dry=workflow.indexOf('Turso production Worker dry-run');
  const before=workflow.indexOf('Verify production health before hotfix');
  const deploy=workflow.indexOf('Deploy Turso production Worker hotfix');
  const after=workflow.indexOf('Verify production health after hotfix');
  const rollback=workflow.indexOf('Roll back code on Turso if deploy verification fails');
  assert.ok(regressions>=0 && dry>regressions && before>dry && deploy>before && after>deploy && rollback>after);
  const rollbackBlock=workflow.slice(rollback);
  assert.match(rollbackBlock,/git checkout --detach "\$ROLLBACK_REF"/);
  assert.match(rollbackBlock,/wrangler\.turso-prod\.jsonc/);
  assert.doesNotMatch(rollbackBlock,/wrangler\.jsonc(?:\s|$)/);
});

test('DNI secret sync keeps the value off logs and wrangler output visible for diagnosis',()=>{
  const start=workflow.indexOf('Sync Decolecta DNI secret');
  const block=workflow.slice(start,workflow.indexOf('Verify production health after secret sync'));
  assert.ok(start>=0);
  assert.match(block,/echo "::add-mask::\$DECOLECTA_API_TOKEN"/);
  assert.match(block,/printf '%s' "\$DECOLECTA_API_TOKEN" \| npx wrangler secret put DECOLECTA_API_TOKEN/);
  assert.doesNotMatch(block,/\/dev\/null/);
  assert.doesNotMatch(block,/set -x/);
  assert.doesNotMatch(block,/secret list[^\n]*\| *grep/,'grep -q in a pipe can SIGPIPE wrangler under pipefail');
  const echoes=[...block.matchAll(/echo[^\n]*DECOLECTA_API_TOKEN[^\n]*/g)].map(m=>m[0]);
  assert.ok(echoes.every(e=>e.includes('::add-mask::')||!e.includes('$DECOLECTA_API_TOKEN')),JSON.stringify(echoes));
});
