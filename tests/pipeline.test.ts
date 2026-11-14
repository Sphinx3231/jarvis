import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HACKERONE_SECRET } from '../server/integrations/hackerone.ts';
import { makeApp, waitFor } from './helpers.ts';

/** A stand-in HackerOne Hacker API: JSON:API lists with page[size] pagination and Basic auth. */
interface Data {
  programs: Array<{ handle: string; name: string; offers_bounties: boolean; submission_state?: string; currency?: string }>;
  reports: Array<{ id: string; title: string; state: string; created_at?: string; program?: string }>;
  earnings: Array<{ id: string; amount: number; currency?: string; awarded_at?: string; program?: string }>;
}

async function fakeHackerOne(data: Data) {
  const auths: string[] = [];
  const program = (p: Data['programs'][number]) => ({ id: p.handle, type: 'program', attributes: { handle: p.handle, name: p.name, offers_bounties: p.offers_bounties, submission_state: p.submission_state ?? 'open', currency: p.currency ?? 'usd' } });
  const report = (r: Data['reports'][number]) => ({ id: r.id, type: 'report', attributes: { title: r.title, state: r.state, created_at: r.created_at }, relationships: r.program ? { program: { data: { attributes: { handle: r.program } } } } : {} });
  const earning = (e: Data['earnings'][number]) => ({ id: e.id, type: 'earning', attributes: { amount: e.amount, currency: e.currency ?? 'usd', awarded_at: e.awarded_at }, relationships: e.program ? { program: { data: { attributes: { handle: e.program } } } } : {} });

  const server: Server = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ''));
    const url = new URL(req.url ?? '/', 'http://x');
    const size = Number(url.searchParams.get('page[size]') ?? '100');
    const pageNum = Number(url.searchParams.get('page[number]') ?? '1');
    let items: unknown[] = [];
    if (url.pathname.endsWith('/programs')) items = data.programs.map(program);
    else if (url.pathname.endsWith('/me/reports')) items = data.reports.map(report);
    else if (url.pathname.endsWith('/payments/earnings')) items = data.earnings.map(earning);
    else return res.writeHead(404).end();
    const start = (pageNum - 1) * size;
    const slice = items.slice(start, start + size);
    const hasMore = start + size < items.length;
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}${url.pathname}`;
    const body = { data: slice, links: hasMore ? { next: `${base}?page[size]=${size}&page[number]=${pageNum + 1}` } : {} };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    auths,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

async function connected(data: Data) {
  const h1 = await fakeHackerOne(data);
  process.env.JARVIS_HACKERONE_API = h1.url;
  const made = await makeApp();
  made.app.settings.update({ integrations: { hackerone: { enabled: true, username: 'hunter', autoRun: true, bountyOnly: true } } });
  made.app.secrets.set(HACKERONE_SECRET, 'h1-test-token-123456');
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

test('pipeline: tracks earnings and reports, and discovers only genuinely new programs', async () => {
  const data: Data = {
    programs: [
      { handle: 'acme', name: 'Acme', offers_bounties: true },
      { handle: 'globex', name: 'Globex', offers_bounties: true },
      { handle: 'initech', name: 'Initech (VDP)', offers_bounties: false },
    ],
    reports: [
      { id: '101', title: 'XSS in login', state: 'resolved', program: 'acme', created_at: iso(40) },
      { id: '102', title: 'IDOR in API', state: 'triaged', program: 'globex', created_at: iso(5) },
      { id: '103', title: 'Open redirect', state: 'duplicate', program: 'acme', created_at: iso(3) },
    ],
    earnings: [
      { id: 'e1', amount: 500, awarded_at: iso(40), program: 'acme' },
      { id: 'e2', amount: 1500, awarded_at: iso(10), program: 'acme' },
      { id: 'e3', amount: 750, awarded_at: iso(2), program: 'globex' },
    ],
  };
  const { app, h1, cleanup } = await connected(data);
  try {
    assert.equal(app.pipeline.missing(), null);
    const first = await app.pipeline.sync();
    assert.equal(first.ok, true, first.detail);
    // Authenticated with Basic auth carrying the stored token.
    assert.match(h1.auths[0], /^Basic /);
    assert.equal(Buffer.from(h1.auths[0].slice(6), 'base64').toString(), 'hunter:h1-test-token-123456');

    const s1 = app.pipeline.summary();
    assert.equal(s1.earnings.total, 2750);
    assert.equal(s1.earnings.count, 3);
    assert.equal(s1.earnings.last30d, 2250, 'only bounties from the last 30 days');
    assert.equal(s1.earnings.averageBounty, Math.round((2750 / 3) * 100) / 100);
    assert.ok(s1.earnings.monthly.length >= 1);
    assert.equal(s1.reports.total, 3);
    assert.deepEqual(s1.reports.byState, { resolved: 1, triaged: 1, duplicate: 1 });
    assert.equal(s1.reports.resolved, 1);
    assert.equal(s1.programs.total, 3);
    assert.equal(s1.programs.bountyPaying, 2);
    assert.equal(s1.programs.newCount, 0, 'the first bulk import is the baseline, not “new”');

    // A program appears later → discovered as new (and only bounty-paying ones, since bountyOnly).
    data.programs.push({ handle: 'umbrella', name: 'Umbrella', offers_bounties: true });
    data.programs.push({ handle: 'soylent', name: 'Soylent (points only)', offers_bounties: false });
    const second = await app.pipeline.sync();
    assert.equal(second.discovered, 2, 'two programs are new to the store');
    const s2 = app.pipeline.summary();
    assert.equal(s2.programs.total, 5);
    assert.equal(s2.programs.newCount, 1, 'only the bounty-paying new program is surfaced');
    assert.equal(s2.programs.discovered[0].handle, 'umbrella');
    assert.equal(s2.programs.discovered[0].isNew, true);
  } finally {
    await cleanup();
  }
});

test('pipeline: the read-only skills expose programs, earnings and reports', async () => {
  const { app, cleanup } = await connected({
    programs: [{ handle: 'acme', name: 'Acme', offers_bounties: true }],
    reports: [{ id: '1', title: 'SSRF', state: 'new', program: 'acme', created_at: iso(1) }],
    earnings: [{ id: 'e1', amount: 1000, awarded_at: iso(1), program: 'acme' }],
  });
  try {
    await app.pipeline.sync();
    const names = app.registry.info().map((s) => s.name);
    for (const n of ['hackerone.programs', 'hackerone.earnings', 'hackerone.reports']) assert.ok(names.includes(n), n);

    const earn = await app.runner.invoke({ agent: 'jarvis', skill: 'hackerone.earnings', input: {} });
    assert.equal(earn.status, 'ok', earn.status === 'ok' ? '' : JSON.stringify(earn));
    assert.match(earn.description, /Total earned: USD 1,?000/);

    const progs = await app.runner.invoke({ agent: 'jarvis', skill: 'hackerone.programs', input: { bountyOnly: true } });
    assert.equal(progs.status, 'ok');
    assert.match(progs.description, /Acme \(acme\)/);

    const reps = await app.runner.invoke({ agent: 'jarvis', skill: 'hackerone.reports', input: { state: 'new' } });
    assert.equal(reps.status, 'ok');
    assert.match(reps.description, /SSRF/);
  } finally {
    await cleanup();
  }
});

test('pipeline: runs on its own only while kept on; without a token it is unavailable, never guessed', async () => {
  // Not configured: the skills are unavailable with an honest reason, and the job skips.
  const { app, cleanup } = await makeApp();
  try {
    const prog = app.registry.info().find((s) => s.name === 'hackerone.programs')!;
    assert.equal(prog.available, false);
    assert.match(prog.unavailableReason!, /turned off/);
    assert.match(await app.scheduler.runJob('hackerone-pipeline', { manual: true }), /paused/);
  } finally {
    await cleanup();
  }

  // Configured and left running: the job actually syncs.
  const live = await connected({ programs: [{ handle: 'acme', name: 'Acme', offers_bounties: true }], reports: [], earnings: [] });
  try {
    const out = await live.app.scheduler.runJob('hackerone-pipeline', { manual: true });
    assert.match(out, /program/);
    assert.equal(live.app.pipeline.summary().running, true);

    // Turning "keep running" off stops it on its own, without disconnecting.
    live.app.settings.update({ integrations: { hackerone: { autoRun: false } } });
    assert.match(await live.app.scheduler.runJob('hackerone-pipeline', { manual: true }), /paused/);
    assert.equal(live.app.pipeline.summary().running, false);
    assert.equal(live.app.pipeline.missing(), null, 'still connected, just not auto-running');

    // A bad token is reported plainly (401), not hidden.
    live.app.secrets.delete(HACKERONE_SECRET);
    assert.equal(live.app.pipeline.missing(), 'Your HackerOne API token is not set.');
  } finally {
    await live.cleanup();
  }
});
