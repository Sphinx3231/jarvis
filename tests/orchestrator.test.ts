import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { palsuText } from '@kenkaiiii/gg-ai';
import { HACKERONE_SECRET } from '../server/integrations/hackerone.ts';
import { makeApp, usePalsu } from './helpers.ts';

/**
 * The autonomous orchestrator: authorization gating, drafting a report from a finding with the local
 * model, and submission that is held or sent exactly according to the switches and the scope gate.
 * A stand-in HackerOne serves scopes and captures POSTed reports; the local model is scripted.
 */

async function fakeH1(programs: string[], scopes: Record<string, Array<{ identifier: string; eligible: boolean }>>) {
  const posted: Array<Record<string, unknown>> = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'POST' && p.endsWith('/reports')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').data?.attributes ?? {});
      return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { id: '7777', type: 'report', attributes: {} } }));
    }
    const sm = p.match(/\/programs\/([^/]+)\/structured_scopes$/);
    let items: unknown[] = [];
    if (sm) items = (scopes[decodeURIComponent(sm[1])] ?? []).map((s, i) => ({ id: `s${i}`, type: 'structured-scope', attributes: { asset_identifier: s.identifier, asset_type: 'URL', eligible_for_submission: s.eligible } }));
    else if (p.endsWith('/programs')) items = programs.map((h) => ({ id: h, type: 'program', attributes: { handle: h, name: h, offers_bounties: true, submission_state: 'open', currency: 'usd' } }));
    else if (p.endsWith('/me/reports') || p.endsWith('/payments/earnings')) items = [];
    else return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: items, links: {} }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, posted, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

async function setup(programs: string[], scopes: Record<string, Array<{ identifier: string; eligible: boolean }>>) {
  const h1 = await fakeH1(programs, scopes);
  process.env.JARVIS_HACKERONE_API = h1.url;
  const made = await makeApp();
  const model = await usePalsu(made.app);
  made.app.settings.update({ integrations: { hackerone: { enabled: true, username: 'hunter', autoRun: false } } });
  made.app.secrets.set(HACKERONE_SECRET, 'h1-test-token-123456');
  await made.app.pipeline.sync();
  return {
    ...made,
    h1,
    model,
    cleanup: async () => {
      await made.cleanup();
      await h1.close();
      delete process.env.JARVIS_HACKERONE_API;
    },
  };
}

const reportJson = (asset: string) => JSON.stringify({ report: true, title: 'IDOR exposes user records', severity: 'high', asset, vulnerability_information: 'Requesting /api/users/{id} returns other users’ data. Steps: … PoC: …', impact: 'Mass PII disclosure.' });
const seedFinding = (app: Awaited<ReturnType<typeof setup>>['app'], handle: string) =>
  app.memory.add({ kind: 'fact', content: `[${handle}] Finding (needs verification): IDOR on /api/users/{id}`, source: 'agent:trinity', tags: ['agent:trinity', handle, 'finding'], verified: false });

test('orchestrator: paused until Full access + Offensive + Autonomous hunting are on', async () => {
  const { app, cleanup } = await setup(['acme'], { acme: [{ identifier: '*.acme.com', eligible: true }] });
  try {
    assert.equal(app.orchestrator.authorization().canHunt, false);
    const r = await app.orchestrator.runCycle({ skipTesting: true });
    assert.equal(r.ran, false);
    assert.match(r.reason, /Full access/);
  } finally {
    await cleanup();
  }
});

test('orchestrator: hunts and drafts, but HOLDS the report until Auto-submit is on', async () => {
  const { app, h1, model, cleanup } = await setup(['acme'], { acme: [{ identifier: '*.acme.com', eligible: true }] });
  try {
    seedFinding(app, 'acme');
    app.settings.update({ permissions: { fullAccess: true }, agents: { offensive: true, autoHunt: true } }); // no autoSubmit
    model.setResponses([palsuText(reportJson('https://api.acme.com'))]);

    const r = await app.orchestrator.runCycle({ skipTesting: true });
    assert.equal(r.ran, true);
    assert.equal(r.target, 'acme');
    assert.equal(r.draftTitle, 'IDOR exposes user records', 'the model drafted a report');
    assert.equal(r.submitted, false);
    assert.equal(r.held, true, 'held because Auto-submit is off');
    assert.equal(h1.posted.length, 0, 'nothing sent');
  } finally {
    await cleanup();
  }
});

test('orchestrator: with every switch on and an in-scope asset, it ships autonomously', async () => {
  const { app, h1, model, cleanup } = await setup(['acme'], { acme: [{ identifier: '*.acme.com', eligible: true }] });
  try {
    seedFinding(app, 'acme');
    app.settings.update({ permissions: { fullAccess: true }, agents: { offensive: true, autoHunt: true, autoSubmit: true } });
    assert.equal(app.orchestrator.authorization().canSubmit, true);
    model.setResponses([palsuText(reportJson('https://api.acme.com'))]);

    const r = await app.orchestrator.runCycle({ skipTesting: true });
    assert.equal(r.submitted, true, r.reason);
    assert.equal(r.reportId, '7777');
    assert.equal(h1.posted.length, 1);
    assert.equal(h1.posted[0].severity_rating, 'high');
    // Recorded in the audit trail and Trinity's memory.
    assert.ok(app.pipeline.submissions().some((s) => s.submitted && s.autonomous));
    assert.ok(app.memory.list({ kind: 'fact', limit: 100 }).some((m) => m.tags.includes('submitted')));
  } finally {
    await cleanup();
  }
});

test('orchestrator: an out-of-scope draft is held by the scope gate, never sent', async () => {
  const { app, h1, model, cleanup } = await setup(['acme'], { acme: [{ identifier: '*.acme.com', eligible: true }] });
  try {
    seedFinding(app, 'acme');
    app.settings.update({ permissions: { fullAccess: true }, agents: { offensive: true, autoHunt: true, autoSubmit: true } });
    model.setResponses([palsuText(reportJson('https://unrelated-evil.com'))]); // not in scope

    const r = await app.orchestrator.runCycle({ skipTesting: true });
    assert.equal(r.submitted, false);
    assert.equal(r.held, true);
    assert.equal(h1.posted.length, 0, 'the scope gate blocked it');
  } finally {
    await cleanup();
  }
});

test('orchestrator: rotates to the next program each cycle, and advances when there is no finding', async () => {
  const { app, cleanup } = await setup(['acme', 'globex'], { acme: [{ identifier: '*.acme.com', eligible: true }], globex: [{ identifier: '*.globex.com', eligible: true }] });
  try {
    app.settings.update({ permissions: { fullAccess: true }, agents: { offensive: true, autoHunt: true } });
    // No findings seeded: each cycle still runs and advances to a different target.
    const a = await app.orchestrator.runCycle({ skipTesting: true });
    const b = await app.orchestrator.runCycle({ skipTesting: true });
    assert.equal(a.ran, true);
    assert.equal(b.ran, true);
    assert.notEqual(a.target, b.target, 'the two cycles hunted different programs');
    for (const r of [a, b]) assert.match(r.reason, /No reportable finding/);
  } finally {
    await cleanup();
  }
});
