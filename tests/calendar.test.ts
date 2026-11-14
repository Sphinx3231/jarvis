import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { buildEvent, eventsFromIcs } from '../server/integrations/calendar.ts';
import { makeApp, tempDir, waitFor } from './helpers.ts';

const hasRadicale = spawnSync('python3', ['-c', 'import radicale'], { stdio: 'ignore' }).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const auth = { authorization: `Basic ${Buffer.from('me:secret').toString('base64')}` };

test('ics: building and parsing events, including recurrence with an exception', () => {
  const ics = buildEvent({ uid: 'u1', title: 'Plan; review, then ship', start: new Date('2026-11-20T15:00:00Z'), end: new Date('2026-11-20T16:00:00Z'), description: 'Line one\nLine two' });
  assert.match(ics, /SUMMARY:Plan\\; review\\, then ship/);
  const [e] = eventsFromIcs(ics, 'Test', new Date('2026-11-01'), new Date('2026-12-01'));
  assert.equal(e.title, 'Plan; review, then ship');
  assert.equal(e.start, '2026-11-20T15:00:00.000Z');
  assert.equal(e.description, 'Line one\nLine two');

  const feed = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:standup',
    'DTSTART:20261116T090000Z',
    'DTEND:20261116T091500Z',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'EXDATE:20261123T090000Z',
    'SUMMARY:Standup',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:holiday',
    'DTSTART;VALUE=DATE:20261126',
    'DTEND;VALUE=DATE:20261127',
    'SUMMARY:Holiday',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = eventsFromIcs(feed, 'Feed', new Date('2026-11-15T00:00:00Z'), new Date('2026-12-31T00:00:00Z'));
  const standups = events.filter((x) => x.title === 'Standup').map((x) => x.start.slice(0, 10));
  assert.deepEqual(standups, ['2026-11-16', '2026-11-30', '2026-12-07'], 'weekly, minus the excluded date');
  assert.equal(events.find((x) => x.title === 'Holiday')!.allDay, true);
});

test('calendar: CalDAV (Radicale) create/list with approval, no duplicates on repeat; ICS feed subscription', { skip: !hasRadicale && 'Radicale not installed (pip install radicale)' }, async () => {
  const storage = tempDir('radicale-');
  const port = await freePort();
  const radicale = spawn('python3', ['-m', 'radicale', '--server-hosts', `127.0.0.1:${port}`, '--storage-filesystem-folder', storage, '--auth-type', 'none', '--logging-level', 'warning'], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const feedServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:feed-1', `DTSTART:${new Date(Date.now() + 2 * 86_400_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`, 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  });
  await new Promise<void>((r) => feedServer.listen(0, '127.0.0.1', () => r()));
  const { app, cleanup } = await makeApp();
  try {
    // Wait until Radicale accepts requests.
    for (let i = 0; i < 50; i++) {
      const ok = await fetch(`${base}/me/`, { method: 'PROPFIND', headers: { ...auth, depth: '0' } }).then((r) => r.status < 500, () => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const mk = await fetch(`${base}/me/work/`, {
      method: 'MKCALENDAR',
      headers: { ...auth, 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Work</D:displayname></D:prop></D:set></C:mkcalendar>',
    });
    assert.equal(mk.status, 201);

    app.settings.update({ integrations: { calendar: { caldav: { enabled: true, serverUrl: `${base}/`, username: 'me' } } } });
    app.secrets.set('calendar:caldav:password', 'secret');
    const check = await app.calendar.test();
    assert.equal(check.ok, true, check.detail);
    assert.match(check.detail, /Work/);

    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(15, 0, 0, 0);
    const step = { skill: 'calendar.create_event', input: { title: 'Design review', start: start.toISOString(), durationMinutes: 45, location: 'Lair' }, description: 'Add event' };
    const { task } = app.engine.createTask({ title: 'Book review', origin: 'user', steps: [step] });
    await waitFor(() => app.tasks.get(task.id)!.status === 'awaiting_approval');
    app.permissions.decideApproval(app.permissions.listApprovals('pending')[0].id, 'approve', { remember: true });
    const done = await waitFor(() => {
      const t = app.tasks.get(task.id)!;
      return ['completed', 'failed'].includes(t.status) ? t : null;
    }, 15_000);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.match(done.plan![0].verification!, /Event found in “Work”/);

    // Repeating the same step (e.g. after a crash) rewrites the same event instead of duplicating it.
    const again = await app.runner.invoke({ agent: 'executor', skill: 'calendar.create_event', input: step.input, taskId: task.id, stepIndex: 0 });
    assert.equal(again.status, 'ok', again.status === 'failed' ? again.error : '');

    app.settings.update({ permissions: { policies: { 'calendar.read': 'allow' } } });
    const listed = await app.runner.invoke({ agent: 'jarvis', skill: 'calendar.events', input: { days: 3 } });
    assert.equal(listed.status, 'ok', listed.status === 'failed' ? listed.error : '');
    const events = (listed as { output: { events: Array<{ title: string; location: string | null; calendar: string; start: string; end: string }> } }).output.events;
    const reviews = events.filter((e) => e.title === 'Design review');
    assert.equal(reviews.length, 1, 'exactly one event');
    assert.equal(reviews[0].calendar, 'Work');
    assert.equal(reviews[0].location, 'Lair');
    assert.equal(new Date(reviews[0].end).getTime() - new Date(reviews[0].start).getTime(), 45 * 60_000);

    app.calendar.addFeed('Personal', `http://127.0.0.1:${(feedServer.address() as { port: number }).port}/cal.ics`);
    const both = await app.runner.invoke({ agent: 'jarvis', skill: 'calendar.events', input: { days: 3 } });
    const titles = (both as { output: { events: Array<{ title: string; calendar: string }> } }).output.events.map((e) => `${e.title}@${e.calendar}`);
    assert.ok(titles.includes('Dentist@Personal') && titles.includes('Design review@Work'), titles.join(', '));
    assert.equal(app.secrets.get(`calendar:feed:${app.settings.get().integrations.calendar.feeds[0].id}`)?.includes('/cal.ics'), true, 'feed URL kept in the secret store');
    assert.ok(!JSON.stringify(app.settings.get()).includes('/cal.ics'), 'feed URL not stored in plain settings');
  } finally {
    await cleanup();
    radicale.kill();
    feedServer.close();
    rmSync(storage, { recursive: true, force: true });
  }
});
