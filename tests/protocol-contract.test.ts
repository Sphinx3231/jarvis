import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvelopeBase, MESSAGE_TYPES, Payloads } from '../shared/protocol/protocol.ts';

const root = join(import.meta.dirname, '..');

test('protocol contract: the generated schema and fixtures are up to date (no drift between TypeScript and Kotlin)', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/protocol-export.ts', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `Run: node scripts/protocol-export.ts\n${r.stdout}${r.stderr}`);
});

test('protocol contract: every message type has a valid fixture', () => {
  const envs = JSON.parse(readFileSync(join(root, 'shared/protocol/fixtures/envelopes.json'), 'utf8')) as Array<{ type: string; payload: unknown }>;
  assert.deepEqual(envs.map((e) => e.type).sort(), [...MESSAGE_TYPES].sort());
  for (const e of envs) {
    EnvelopeBase.parse(e);
    Payloads[e.type as keyof typeof Payloads].parse(e.payload);
  }
});
