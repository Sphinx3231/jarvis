import { test } from 'node:test';
import assert from 'node:assert/strict';
import { palsuText } from '@kenkaiiii/gg-ai';
import { findCapabilities, knowledgeSummary, operatorBriefing } from '../server/agents/knowledge/index.ts';
import { makeApp, usePalsu } from './helpers.ts';

const seedProgram = (app: Awaited<ReturnType<typeof makeApp>>['app'], handle = 'acme', name = 'Acme') => {
  const t = Date.now();
  app.db.run(
    'INSERT INTO h1_programs (handle, name, currency, offers_bounties, state, url, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?,?,?)',
    handle, name, 'usd', 1, 'open', `https://hackerone.com/${handle}`, t, t, '{}',
  );
};

test('knowledge base: 21 families, 90 tools, lowest-impact-first lookup', () => {
  const ks = knowledgeSummary();
  assert.equal(ks.families, 21);
  assert.equal(ks.tools, 90);
  assert.ok(ks.methodologyBytes > 10_000, 'methodology text is loaded');

  const dns = findCapabilities('DNS');
  assert.ok(dns.families.some((f) => /DNS/i.test(f.name)), 'DNS capability family found');
  assert.ok(dns.tools.length > 0);
  // Low-impact tools come first (dig/whois before active enumerators).
  const impacts = dns.tools.map((t) => t.impact.toLowerCase());
  assert.ok(impacts[0].includes('low'), `lowest impact first (got ${impacts[0]})`);

  // The operator briefing carries the authorized scope and the arsenal, but no command strings.
  const brief = operatorBriefing({ program: 'acme', url: 'https://hackerone.com/acme', activeAllowed: false });
  assert.match(brief, /AUTHORIZED TARGET: program "acme"/);
  assert.match(brief, /ACTIVE TESTING \(sending live traffic\): DISABLED/);
  assert.match(brief, /Network discovery & mapping/);
});

test('security.toolkit: finds candidate tools for a capability (knowledge only)', async () => {
  const { app, cleanup } = await makeApp();
  try {
    const res = await app.runner.invoke({ agent: 'jarvis', skill: 'security.toolkit', input: { query: 'subdomains' } });
    assert.equal(res.status, 'ok', res.status === 'ok' ? '' : JSON.stringify(res));
    assert.match(res.description, /Sublist3r|Amass|dnsenum|subdomain/i);
  } finally {
    await cleanup();
  }
});

test('security.operate: refuses a target that is not an authorized in-scope program', async () => {
  const { app, cleanup } = await makeApp();
  try {
    await usePalsu(app);
    app.settings.update({ permissions: { fullAccess: true } }); // so the skill executes rather than asking
    const res = await app.runner.invoke({ agent: 'executor', skill: 'security.operate', input: { program: 'some-random-site', execute: true } });
    assert.equal(res.status, 'failed');
    assert.match(res.error ?? '', /not a known in-scope program/);
  } finally {
    await cleanup();
  }
});

test('security.operate: plans with the local model but sends no traffic until offensive mode is on', async () => {
  const { app, cleanup } = await makeApp();
  try {
    seedProgram(app);
    await usePalsu(app, [palsuText('{"capability":"Asset discovery & OSINT","tool":"Amass","impact":"low","purpose":"enumerate subdomains passively","command":"amass enum -passive -d acme.example","finding":"","done":true}')]);
    // Full access on, but offensive mode OFF → plan only, nothing runs.
    app.settings.update({ permissions: { fullAccess: true }, agents: { offensive: false } });
    const res = await app.runner.invoke({ agent: 'executor', skill: 'security.operate', input: { program: 'acme', objective: 'map the attack surface', execute: true } });
    assert.equal(res.status, 'ok', res.status === 'ok' ? '' : JSON.stringify(res));
    assert.match(res.description, /planning only|offensive mode is off/i);
    assert.match(res.description, /Amass/);
    assert.doesNotMatch(res.description, /→ exit/, 'no command was executed');
  } finally {
    await cleanup();
  }
});

test('security.operate: with full access + offensive mode, it runs the step live on the authorized target', async () => {
  const { app, cleanup } = await makeApp();
  try {
    seedProgram(app);
    // A harmless command stands in for a real low-impact tool so the live loop is exercised end to end.
    await usePalsu(app, [palsuText('{"capability":"Port & service identification","tool":"echo","impact":"low","purpose":"prove the operator runs an authorized step","command":"echo scope-check-ok","finding":"","done":true}')]);
    app.settings.update({ permissions: { fullAccess: true }, agents: { enabled: true, offensive: true }, integrations: { shell: { enabled: true } } });
    const res = await app.runner.invoke({ agent: 'executor', skill: 'security.operate', input: { program: 'acme', execute: true, maxSteps: 1 } });
    assert.equal(res.status, 'ok', res.status === 'ok' ? '' : JSON.stringify(res));
    assert.match(res.description, /→ exit 0/);
    assert.match(res.description, /scope-check-ok/);
    // The run is remembered in Trinity's mind, tagged to the program.
    const mem = app.db.all<{ content: string }>("SELECT content FROM memories WHERE source = 'agent:trinity' ORDER BY created_at DESC");
    assert.ok(mem.some((m) => /acme/.test(m.content)), 'operator run recorded in Trinity memory');
  } finally {
    await cleanup();
  }
});

test('Trinity agent: armed with the arsenal, plans against authorized targets Tom surfaces', async () => {
  const { app, cleanup } = await makeApp();
  try {
    // No programs yet → armed, waiting.
    const armed = await app.subAgents.runAgent('trinity');
    assert.match(armed.lastSummary, /Armed: 90 tools \/ 21 families/);

    seedProgram(app, 'tinycorp', 'TinyCorp');
    const planned = await app.subAgents.runAgent('trinity');
    assert.match(planned.lastSummary, /authorized target/);
    assert.match(planned.lastSummary, /tinycorp/);
    assert.match(planned.lastSummary, /planning only/); // offensive mode off by default
    const mem = app.db.all<{ content: string }>("SELECT content FROM memories WHERE source = 'agent:trinity' ORDER BY created_at DESC");
    assert.ok(mem.some((m) => /Testing plan for TinyCorp/.test(m.content)));
  } finally {
    await cleanup();
  }
});
