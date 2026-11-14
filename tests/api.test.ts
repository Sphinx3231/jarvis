import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startJarvis, type RunningJarvis } from '../server/main.ts';
import { tempDir, waitFor } from './helpers.ts';

async function start(): Promise<RunningJarvis & { dir: string; call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }> }> {
  const dir = tempDir();
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<html><head><meta name="jarvis-token" content="" /></head><body>ui</body></html>');
  const running = await startJarvis({ dataDir: join(dir, 'data'), port: 0, quiet: true, webDir: web });
  running.app.settings.update({ background: { enabled: false } });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${running.url}${path}`, {
      method,
      headers: { 'x-jarvis-token': running.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { ...running, dir, call };
}

/** Raw request so we can send a spoofed Host header (fetch forbids it). */
function rawGet(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('api: authentication, DNS-rebinding and CSRF protections', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/api/status', undefined, { 'x-jarvis-token': 'wrong' })).status, 401);
    assert.equal((await s.call('GET', '/api/status', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal(await rawGet(`${s.url}/api/status`, { host: 'evil.example', 'x-jarvis-token': s.token }), 421);
    assert.equal((await s.call('GET', '/api/status')).status, 200);
    const html = await (await fetch(s.url)).text();
    assert.ok(html.includes(`content="${s.token}"`), 'token embedded in the served page');
    const res = await fetch(`${s.url}/tasks`);
    assert.match(res.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal((await fetch(`${s.url}/../../etc/passwd.txt`)).status, 404);
  } finally {
    await s.stop();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('api: chat, tasks, approvals, memory, settings and skills endpoints', async () => {
  const s = await start();
  try {
    // Asking for a command is the authorization to run exactly that command.
    const asked = await s.call('POST', '/api/chat', { message: 'run `echo asked-for`' });
    assert.equal(asked.status, 200);
    const askedId = asked.json.actions[0].taskId;
    await waitFor(() => s.app.tasks.get(askedId)!.status === 'completed', 5000, 'requested command runs');
    const askedEvents = (await s.call('GET', `/api/tasks/${askedId}`)).json.events;
    assert.ok(askedEvents.some((e: { type: string }) => e.type === 'approved_by_request'));

    // With "do what I ask" turned off, every consequential step asks.
    assert.equal((await s.call('PATCH', '/api/settings', { permissions: { followRequests: false } })).status, 200);
    const chat = await s.call('POST', '/api/chat', { message: 'run `echo api-test`' });
    assert.equal(chat.status, 200);
    const taskId = chat.json.actions[0].taskId;
    await waitFor(() => s.app.tasks.get(taskId)!.status === 'awaiting_approval');

    const approvals = await s.call('GET', '/api/approvals');
    assert.equal(approvals.json.approvals[0].taskTitle, 'Run: echo api-test');
    assert.equal((await s.call('POST', `/api/approvals/${approvals.json.approvals[0].id}/approve`, {})).status, 200);
    await waitFor(() => s.app.tasks.get(taskId)!.status === 'completed');
    const detail = await s.call('GET', `/api/tasks/${taskId}`);
    assert.match(detail.json.task.plan[0].output.stdout, /api-test/);
    assert.ok(detail.json.events.some((e: { type: string }) => e.type === 'approved'));

    assert.equal((await s.call('POST', `/api/tasks/${taskId}/cancel`)).status, 409, 'cannot cancel a completed task');
    assert.equal((await s.call('POST', '/api/tasks', { title: '' })).status, 400);
    const created = await s.call('POST', '/api/tasks', { title: 'Hello', steps: [{ skill: 'notify.user', input: { title: 'hey' } }], delayMinutes: 60 });
    assert.equal(created.json.task.status, 'queued');
    assert.ok(created.json.task.scheduledFor > Date.now() + 59 * 60_000);
    assert.equal((await s.call('POST', `/api/tasks/${created.json.task.id}/pause`)).json.task.status, 'paused');

    const mem = await s.call('POST', '/api/memory', { content: 'Prefers concise answers', kind: 'preference' });
    assert.equal(mem.json.memory.verified, true);
    const search = await s.call('GET', '/api/memory?q=concise');
    assert.equal(search.json.memories[0].id, mem.json.memory.id);
    assert.equal((await s.call('PATCH', `/api/memory/${mem.json.memory.id}`, { kind: 'bogus' })).status, 400);
    assert.equal((await s.call('DELETE', `/api/memory/${mem.json.memory.id}`)).status, 200);

    assert.equal((await s.call('PATCH', '/api/settings', { permissions: { policies: { 'shell.exec': 'allow' } } })).status, 400);
    assert.equal((await s.call('PATCH', '/api/settings', { background: { maxConcurrentTasks: 99 } })).status, 400);
    const ok = await s.call('PATCH', '/api/settings', { voice: { rate: 1.2 }, assistant: { userName: 'Sam' } });
    assert.equal(ok.json.settings.voice.rate, 1.2);

    // Model sign-ins live in Roamies; the only key Jarvis keeps is an optional transcription-server key.
    assert.equal((await s.call('PUT', '/api/integrations/providers/anthropic/key', { apiKey: 'sk-ant-secret-1234567890' })).status, 404);
    const key = await s.call('PUT', '/api/integrations/transcription/key', { apiKey: 'sk-local-secret-1234567890' });
    assert.equal(key.status, 200);
    const integrations = await s.call('GET', '/api/integrations');
    assert.equal(integrations.json.transcription.keySet, true);
    assert.equal(integrations.json.model.ready, false);
    assert.match(integrations.json.model.problem, /Roamies/);
    assert.equal(integrations.json.roamies.installed, true);
    assert.ok(!JSON.stringify(integrations.json).includes('sk-local-secret'), 'keys are never returned');
    assert.ok(!JSON.stringify((await s.call('GET', '/api/settings')).json).includes('sk-local-secret'));

    const skills = await s.call('GET', '/api/skills');
    const shell = skills.json.skills.find((x: { name: string }) => x.name === 'shell.run');
    assert.equal(shell.policy, 'ask');
    assert.equal(shell.scopeLabel, 'Run shell commands');

    const jobs = await s.call('GET', '/api/jobs');
    assert.deepEqual(jobs.json.jobs.map((j: { name: string }) => j.name), ['task-monitor', 'memory-maintenance', 'health-check', 'obsidian-sync']);
    assert.equal(jobs.json.jobs[0].paused, true, 'background paused in tests');
    const ran = await s.call('POST', '/api/jobs/memory-maintenance/run');
    assert.equal(ran.status, 200);
    const audit = await s.call('GET', '/api/audit');
    assert.ok(audit.json.audit.some((a: { skill: string; outcome: string }) => a.skill === 'shell.run' && a.outcome === 'success'));
  } finally {
    await s.stop();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('api: server-sent events stream live state changes', async () => {
  const s = await start();
  try {
    const controller = new AbortController();
    const res = await fetch(`${s.url}/api/events?token=${s.token}`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      let buf = '';
      while (true) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buf += Buffer.from(value!).toString('utf8');
        for (const m of buf.matchAll(/^data: (.*)$/gm)) seen.push(JSON.parse(m[1]).type);
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    })();
    await s.call('POST', '/api/chat', { message: 'remember that SSE works' });
    await waitFor(() => seen.includes('memory.changed') && seen.includes('assistant.state') && seen.includes('conversation.updated'));
    assert.equal(seen[0], 'hello');
    controller.abort();
    await pump;
  } finally {
    await s.stop();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('api: only one Jarvis runs per data folder; a stale lock is recovered', async () => {
  const { writeFileSync: write } = await import('node:fs');
  const dir = tempDir();
  const first = await startJarvis({ dataDir: dir, port: 0, quiet: true, webDir: dir });
  try {
    await assert.rejects(startJarvis({ dataDir: dir, port: 0, quiet: true, webDir: dir }), (err: Error & { url?: string }) => {
      assert.match(err.message, /already running/);
      assert.equal(err.url, first.url, 'points at the running instance');
      return true;
    });
  } finally {
    await first.stop();
  }
  write(join(dir, 'jarvis.lock'), JSON.stringify({ pid: 999_999_999, url: 'http://127.0.0.1:1' }));
  const again = await startJarvis({ dataDir: dir, port: 0, quiet: true, webDir: dir });
  await again.stop();
  rmSync(dir, { recursive: true, force: true });
});
