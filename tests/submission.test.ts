import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HACKERONE_SECRET } from '../server/integrations/hackerone.ts';
import { makeApp, waitFor } from './helpers.ts';

/**
 * Report submission + the two fail-closed gates: autonomous authorization and in-scope verification.
 * A stand-in HackerOne serves structured scopes and accepts POST /reports, capturing every body so we
 * can assert exactly when a report is (and is NOT) sent.
 */

interface ScopeDef {
  identifier: string;
  eligible: boolean;
  asset_type?: string;
}

async function fakeH1(opts: { programs: string[]; scopes: Record<string, ScopeDef[]> }) {
  const posted: Array<{ team_handle: string; title: string; severity_rating: string; asset?: string }> = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'POST' && p.endsWith('/reports')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      posted.push(body.data?.attributes ?? {});
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { id: '9001', type: 'report', attributes: { title: body.data?.attributes?.title } } }));
      return;
    }
    const scopeMatch = p.match(/\/programs\/([^/]+)\/structured_scopes$/);
    let items: unknown[] = [];
    if (scopeMatch) {
      const handle = decodeURIComponent(scopeMatch[1]);
      items = (opts.scopes[handle] ?? []).map((s, i) => ({ id: `${handle}-${i}`, type: 'structured-scope', attributes: { asset_identifier: s.identifier, asset_type: s.asset_type ?? 'URL', eligible_for_submission: s.eligible, max_severity: 'critical' } }));
    } else if (p.endsWith('/programs')) {
      items = opts.programs.map((h) => ({ id: h, type: 'program', attributes: { handle: h, name: h, offers_bounties: true, submission_state: 'open', currency: 'usd' } }));
    } else if (p.endsWith('/me/reports') || p.endsWith('/payments/earnings')) {
      items = [];
    } else {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: items, links: {} }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, posted, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

async function connected(opts: { programs: string[]; scopes: Record<string, ScopeDef[]> }) {
  const h1 = await fakeH1(opts);
  process.env.JARVIS_HACKERONE_API = h1.url;
  const made = await makeApp();
  made.app.settings.update({ integrations: { hackerone: { enabled: true, username: 'hunter', autoRun: false } } });
  made.app.secrets.set(HACKERONE_SECRET, 'h1-test-token-123456');
  await made.app.pipeline.sync();
  return {
    ...made,
    h1,
    cleanup: async () => {
      await made.cleanup();
      await h1.close();
      delete process.env.JARVIS_HACKERONE_API;
    },
  };
}

const report = (program: string, asset: string) => ({ program, title: 'Reflected XSS in search', vulnerabilityInformation: 'Steps: 1) open ?q=<script>… full PoC here.', severity: 'high' as const, asset, impact: 'Session theft.' });

test('submission: the in-scope gate fails closed — no known scope means nothing is sent', async () => {
  const { app, h1, cleanup } = await connected({ programs: ['acme'], scopes: {} });
  try {
    const r = await app.pipeline.submitReport(report('acme', 'https://app.acme.com'));
    assert.equal(r.ok, false);
    assert.equal(r.held, true, 'held, not failed');
    assert.match(r.reason, /No eligible in-scope assets/i);
    assert.equal(h1.posted.length, 0, 'nothing was POSTed');
    // The held attempt is in the audit trail.
    const audit = app.pipeline.submissions();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].submitted, false);
    assert.equal(audit[0].scopeOk, false);
  } finally {
    await cleanup();
  }
});

test('submission: an out-of-scope asset is held; an in-scope asset is submitted', async () => {
  const { app, h1, cleanup } = await connected({
    programs: ['acme'],
    scopes: { acme: [{ identifier: '*.acme.com', eligible: true, asset_type: 'WILDCARD' }, { identifier: 'https://legacy.example.org', eligible: false }] },
  });
  try {
    // Out of scope (different domain) → held.
    const out = await app.pipeline.submitReport(report('acme', 'https://evil-unrelated.com/x'));
    assert.equal(out.held, true);
    assert.equal(h1.posted.length, 0);

    // In scope via wildcard → submitted.
    const ok = await app.pipeline.submitReport(report('acme', 'https://api.acme.com/v1'));
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.reportId, '9001');
    assert.match(ok.matchedScope ?? '', /\*\.acme\.com/);
    assert.equal(h1.posted.length, 1, 'exactly one report sent');
    assert.equal(h1.posted[0].team_handle, 'acme');
    assert.equal(h1.posted[0].severity_rating, 'high');

    // An out-of-scope "eligible:false" asset is never a match even if named in scopes.
    const legacy = await app.pipeline.submitReport(report('acme', 'https://legacy.example.org'));
    assert.equal(legacy.held, true);
    assert.equal(h1.posted.length, 1, 'still just the one');
  } finally {
    await cleanup();
  }
});

test('submission: autonomous submit is held unless full access + offensive + auto-submit are all on', async () => {
  const { app, h1, cleanup } = await connected({ programs: ['acme'], scopes: { acme: [{ identifier: '*.acme.com', eligible: true }] } });
  try {
    // All three off → held, nothing sent.
    const held = await app.pipeline.submitReport(report('acme', 'https://api.acme.com'), { autonomous: true });
    assert.equal(held.held, true);
    assert.match(held.reason, /Full access \+ Offensive mode \+ Auto-submit/i);
    assert.equal(h1.posted.length, 0);

    // Only two of three → still held.
    app.settings.update({ permissions: { fullAccess: true }, agents: { offensive: true } });
    assert.equal((await app.pipeline.submitReport(report('acme', 'https://api.acme.com'), { autonomous: true })).held, true);
    assert.equal(h1.posted.length, 0);

    // All three on + in scope → submits autonomously.
    app.settings.update({ agents: { autoSubmit: true } });
    const sent = await app.pipeline.submitReport(report('acme', 'https://api.acme.com'), { autonomous: true });
    assert.equal(sent.ok, true, sent.reason);
    assert.equal(h1.posted.length, 1);
    assert.equal(app.pipeline.submissions().find((s) => s.submitted)!.autonomous, true);
  } finally {
    await cleanup();
  }
});

test('submission: the submit skill needs approval and the scope can never be auto-allowed', async () => {
  const { app, h1, cleanup } = await connected({ programs: ['acme'], scopes: { acme: [{ identifier: '*.acme.com', eligible: true }] } });
  try {
    // hackerone.submit is consequential: a global "allow" is refused.
    assert.throws(() => app.permissions.validatePolicyPatch({ 'hackerone.submit': 'allow' }), /cannot be allowed/i);

    // Via a task it stops for approval, then runs on approval and actually submits.
    const { task } = app.engine.createTask({ title: 'Report', origin: 'user', steps: [{ skill: 'hackerone.submit_report', input: report('acme', 'https://api.acme.com'), description: '' }] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval');
    assert.equal(h1.posted.length, 0, 'not sent before approval');
    app.permissions.decideApproval(app.permissions.listApprovals('pending')[0].id, 'approve');
    await waitFor(() => (app.tasks.get(task.id)!.status === 'completed' ? true : null));
    assert.equal(h1.posted.length, 1, 'sent after approval');
  } finally {
    await cleanup();
  }
});
