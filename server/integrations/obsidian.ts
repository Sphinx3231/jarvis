import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { JarvisApp } from '../app.ts';
import { AGENTS } from '../agents/agents.ts';
import { errorMessage, sha256, truncate } from '../core/util.ts';
import { MEMORY_KINDS, type Memory, type MemoryKind } from '../memory/store.ts';
import type { Task } from '../tasks/store.ts';
import type { Skill } from '../skills/types.ts';

/**
 * Keeps Jarvis's documentation and knowledge in an Obsidian vault, automatically.
 *
 * Everything is written under <vault>/<folder>/ (default "Jarvis") as plain Markdown with YAML
 * frontmatter, tags and [[wikilinks]]: a live manual (skills, agents, permissions, integrations,
 * background jobs, architecture docs), memories, task history and a daily journal.
 *
 * Safety rules:
 *  - Nothing outside that folder is ever written or deleted.
 *  - Jarvis remembers the hash of every file it wrote. If a file on disk no longer matches, the
 *    user edited it: Jarvis never overwrites or deletes it. Edits to memory notes are imported
 *    back into Jarvis as corrections.
 *  - Credentials, API keys and calendar feed URLs are never written.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(here, '..', '..', 'docs');
const README = join(here, '..', '..', 'README.md');

const KIND_FOLDER: Record<MemoryKind, string> = {
  preference: 'Preferences',
  project: 'Projects',
  decision: 'Decisions',
  procedure: 'Procedures',
  fact: 'Facts',
  task_history: 'Task history',
  tool_doc: 'Tool docs',
};

const EDIT_HINT = '%% Edit the text above to correct this memory, or set verified: true to confirm it. Jarvis imports your change on the next sync. %%';

export interface SyncReport {
  at: number;
  ok: boolean;
  written: number;
  unchanged: number;
  removed: number;
  keptUserEdits: string[];
  imported: number;
  error: string | null;
  durationMs: number;
}

/** File name safe on Windows, macOS, Linux and in Obsidian links. */
export function safeName(text: string, max = 70): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (cleaned.slice(0, max).trim() || 'Untitled').replace(/[. ]+$/, '');
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(', ')}]`;
  return JSON.stringify(String(v)); // JSON strings are valid YAML double-quoted scalars
}

export function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`)
    .join('\n')}\n---\n`;
}

/** Minimal frontmatter reader for the fields Jarvis writes (scalars and inline arrays). */
export function readFrontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    let value: unknown = raw;
    if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (raw === 'null' || raw === '') value = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw.slice(1, -1);
      }
    } else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1);
    fields[kv[1]] = value;
  }
  return { fields, body: text.slice(m[0].length) };
}

const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null);
const day = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const time = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export class ObsidianSync {
  private app: JarvisApp;
  lastReport: SyncReport | null = null;
  private running: Promise<SyncReport> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(app: JarvisApp) {
    this.app = app;
  }

  cfg() {
    return this.app.settings.get().integrations.obsidian;
  }

  /** Why syncing can't run right now, or null when it can. */
  problem(): string | null {
    const c = this.cfg();
    if (!c.enabled) return 'Obsidian sync is turned off';
    if (!c.vaultPath.trim()) return 'Choose your Obsidian vault folder';
    if (!isAbsolute(c.vaultPath)) return 'The vault path must be a full path';
    if (!existsSync(c.vaultPath) || !statSync(c.vaultPath).isDirectory()) return `Vault folder not found: ${c.vaultPath}`;
    return null;
  }

  looksLikeVault(): boolean {
    const p = this.cfg().vaultPath;
    return Boolean(p) && existsSync(join(p, '.obsidian'));
  }

  vaultRoot(): string {
    return realpathSync(this.cfg().vaultPath);
  }

  /** <vault>/<folder>, guaranteed to be inside the vault even through symlinks. */
  private base(): string {
    const vault = this.vaultRoot();
    const base = resolve(vault, this.cfg().folder);
    if (base === vault || !base.startsWith(vault + sep)) throw new Error('The Jarvis folder must be inside the vault');
    mkdirSync(base, { recursive: true });
    const real = realpathSync(base);
    if (!real.startsWith(vault + sep)) throw new Error('The Jarvis folder resolves outside the vault');
    return real;
  }

  /** Vault-relative link target for a note path inside the Jarvis folder (no .md). */
  private link(rel: string, label?: string): string {
    const target = `${this.cfg().folder}/${rel.replace(/\.md$/, '')}`;
    return label ? `[[${target}|${label}]]` : `[[${target}]]`;
  }

  /** Debounced sync after something changed. */
  schedule(delayMs = 5000): void {
    if (this.problem()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync().catch(() => {}), delayMs);
    this.timer.unref?.();
  }

  cancelScheduled(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  sync(): Promise<SyncReport> {
    this.running ??= this.syncNow().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async syncNow(): Promise<SyncReport> {
    const started = Date.now();
    const report: SyncReport = { at: started, ok: false, written: 0, unchanged: 0, removed: 0, keptUserEdits: [], imported: 0, error: null, durationMs: 0 };
    try {
      const problem = this.problem();
      if (problem) throw new Error(problem);
      const base = this.base();
      const state = new Map(this.app.db.all<{ path: string; hash: string }>('SELECT path, hash FROM obsidian_files').map((r) => [r.path, r.hash]));
      const edited = (rel: string): boolean => {
        const full = join(base, rel);
        const known = state.get(rel);
        return Boolean(known && existsSync(full) && sha256(readFileSync(full)) !== known);
      };

      // 1. Import corrections the user made to memory notes.
      report.imported = this.importMemoryEdits(base, state, edited);

      // 2. Build the full set of notes and write the ones that changed.
      const notes = this.buildNotes();
      for (const [rel, content] of notes) {
        const full = join(base, rel);
        if (!full.startsWith(base + sep)) continue;
        const hash = sha256(content);
        if (existsSync(full)) {
          if (sha256(readFileSync(full)) === hash) {
            report.unchanged++;
            if (state.get(rel) !== hash) this.remember(rel, hash);
            continue;
          }
          // Not written by Jarvis, or edited since: leave the user's version alone.
          if (!state.has(rel) || edited(rel)) {
            report.keptUserEdits.push(rel);
            continue;
          }
        }
        mkdirSync(dirname(full), { recursive: true });
        const tmp = `${full}.jarvis-tmp`;
        writeFileSync(tmp, content);
        renameSync(tmp, full);
        this.remember(rel, hash);
        report.written++;
      }

      // 3. Remove notes Jarvis wrote that no longer exist (deleted memories, pruned tasks),
      //    unless the user edited them.
      for (const rel of state.keys()) {
        if (notes.has(rel)) continue;
        const full = join(base, rel);
        if (!existsSync(full)) {
          this.forget(rel);
          continue;
        }
        if (edited(rel)) {
          report.keptUserEdits.push(rel);
          continue;
        }
        unlinkSync(full);
        this.forget(rel);
        report.removed++;
        this.removeEmptyDirs(dirname(full), base);
      }
      report.ok = true;
    } catch (err) {
      report.error = errorMessage(err);
    }
    report.durationMs = Date.now() - started;
    this.lastReport = report;
    if (report.ok && (report.written || report.removed || report.imported)) {
      this.app.activity.log('info', 'obsidian', `Obsidian vault updated: ${report.written} written, ${report.removed} removed${report.imported ? `, ${report.imported} memory edit(s) imported` : ''}`);
    } else if (!report.ok) {
      this.app.activity.log('error', 'obsidian', `Obsidian sync failed: ${report.error}`);
    }
    this.app.bus.emit('integrations.changed', { obsidian: true });
    return report;
  }

  private remember(rel: string, hash: string): void {
    this.app.db.run('INSERT INTO obsidian_files (path, hash, written_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, written_at = excluded.written_at', rel, hash, Date.now());
  }

  private forget(rel: string): void {
    this.app.db.run('DELETE FROM obsidian_files WHERE path = ?', rel);
  }

  private removeEmptyDirs(dir: string, base: string): void {
    let d = dir;
    while (d.startsWith(base + sep) && existsSync(d) && readdirSync(d).length === 0) {
      rmdirSync(d);
      d = dirname(d);
    }
  }

  private importMemoryEdits(base: string, state: Map<string, string>, edited: (rel: string) => boolean): number {
    let imported = 0;
    for (const rel of state.keys()) {
      if (!rel.startsWith('Memory/') || rel.endsWith('/Memory.md') || !edited(rel)) continue;
      const { fields, body } = readFrontmatter(readFileSync(join(base, rel), 'utf8'));
      const id = typeof fields.jarvis_id === 'string' ? fields.jarvis_id : null;
      const memory = id ? this.app.memory.get(id) : undefined;
      if (!memory) continue;
      const content = body.split(/\n%%/)[0].replace(/^#[^\n]*\n/, '').trim();
      const patch: { content?: string; verified?: boolean; kind?: MemoryKind } = {};
      if (content && content !== memory.content) patch.content = content;
      if (fields.verified === true && !memory.verified) patch.verified = true;
      if (typeof fields.kind === 'string' && fields.kind !== memory.kind && (MEMORY_KINDS as readonly string[]).includes(fields.kind) && fields.kind !== 'tool_doc' && fields.kind !== 'task_history') {
        patch.kind = fields.kind as MemoryKind;
      }
      if (!Object.keys(patch).length) {
        // Only formatting changed: adopt the user's file as the new baseline.
        this.remember(rel, sha256(readFileSync(join(base, rel))));
        continue;
      }
      this.app.memory.update(memory.id, patch);
      imported++;
      this.app.activity.log('info', 'memory', `Imported your Obsidian edit to a ${memory.kind} memory`, { memoryId: memory.id });
      // The note is regenerated from the corrected memory below; the edited file may be replaced.
      this.forgetHashOnly(rel, state);
    }
    return imported;
  }

  /** Treat the file as Jarvis-owned again after importing its content. */
  private forgetHashOnly(rel: string, state: Map<string, string>): void {
    const full = join(this.base(), rel);
    const hash = sha256(readFileSync(full));
    state.set(rel, hash);
    this.remember(rel, hash);
  }

  // ---------------------------------------------------------------- note generation

  buildNotes(): Map<string, string> {
    const inc = this.cfg().include;
    const notes = new Map<string, string>();
    if (inc.manual) this.manualNotes(notes);
    if (inc.memories) this.memoryNotes(notes);
    if (inc.tasks) this.taskNotes(notes);
    if (inc.journal) this.journalNotes(notes);
    if (inc.conversations) this.conversationNotes(notes);
    notes.set('Jarvis.md', this.homeNote(notes));
    return notes;
  }

  private homeNote(notes: Map<string, string>): string {
    const s = this.app.statusSnapshot();
    const inc = this.cfg().include;
    const journalDays = [...notes.keys()].filter((k) => k.startsWith('Journal/')).sort().reverse();
    return [
      frontmatter({ tags: ['jarvis'], jarvis_generated: true, updated: new Date().toISOString().slice(0, 16) }),
      '# Jarvis',
      '',
      '> [!abstract] Live status',
      `> **Model:** ${s.model ? `${s.model.model} via ${s.model.provider}` : 'not configured'}  `,
      `> **Tasks:** ${s.tasks.running} running · ${s.tasks.queued} queued · ${s.tasks.paused} paused · ${s.approvalsPending} awaiting approval · ${s.tasks.completed} completed  `,
      `> **Memory:** ${s.memory.total - (s.memory.byKind.tool_doc ?? 0)} ${s.memory.total - (s.memory.byKind.tool_doc ?? 0) === 1 ? 'memory' : 'memories'} (${s.memory.unverified} unverified)  `,
      `> **Background monitoring:** ${s.background.enabled ? 'on' : 'paused'}`,
      '',
      'This folder is maintained by Jarvis and updated automatically. Notes you edit are never overwritten; edits to memory notes are imported back into Jarvis.',
      '',
      ...(inc.manual
        ? ['## Manual', `- ${this.link('Manual/Skills', 'Skills')}`, `- ${this.link('Manual/Agents', 'Agents')}`, `- ${this.link('Manual/Permissions', 'Permissions')}`, `- ${this.link('Manual/Integrations', 'Integrations')}`, `- ${this.link('Manual/Background jobs', 'Background jobs')}`]
        : []),
      ...[...notes.keys()].filter((k) => k.startsWith('Manual/Docs/')).map((k) => `- ${this.link(k, k.split('/').pop()!.replace(/\.md$/, ''))}`),
      ...(inc.memories ? ['', '## Knowledge', `- ${this.link('Memory/Memory', 'Memory index')}`] : []),
      ...(inc.tasks ? ['', '## Work', `- ${this.link('Tasks/Task log', 'Task log')}`] : []),
      ...(inc.journal && journalDays.length ? ['', '## Journal', ...journalDays.slice(0, 7).map((k) => `- ${this.link(k, k.slice(8, 18))}`)] : []),
      '',
    ].join('\n');
  }

  private manualNotes(notes: Map<string, string>): void {
    const skills = this.app.registry.info();
    const skillObjs = new Map(this.app.registry.all().map((s: Skill) => [s.name, s]));
    const byCat = new Map<string, typeof skills>();
    for (const s of skills) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s]);

    for (const s of skills) {
      const policy = this.app.permissions.policyFor(s.scope);
      const scope = this.app.permissions.scopeDefinition(s.scope);
      const props = (s.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }).properties ?? {};
      const required = new Set((s.inputSchema as { required?: string[] }).required ?? []);
      notes.set(
        `Manual/Skills/${safeName(s.name)}.md`,
        [
          frontmatter({
            type: 'skill',
            skill: s.name,
            category: s.category,
            permission: scope.label,
            policy,
            risk: s.risk,
            repeatable: s.idempotent,
            available: s.available,
            tags: ['jarvis/skill', `jarvis/skill/${s.category}`],
          }),
          `# ${s.title}`,
          '',
          `\`${s.name}\` — ${s.description}`,
          '',
          s.available ? '> [!success] Ready' : `> [!warning] Unavailable\n> ${s.unavailableReason}`,
          '',
          `**Permission:** ${scope.label} — ${policy === 'allow' ? 'runs without asking' : policy === 'deny' ? 'never allowed' : 'asks you first'}  `,
          `**Risk:** ${s.risk} · **Safe to repeat after a crash:** ${s.idempotent ? 'yes' : 'no'}${s.untrustedOutput ? ' · **Output is external content** (treated as data, never as instructions)' : ''}${s.dependsOn ? `  \n**Needs:** ${s.dependsOn}` : ''}`,
          '',
          '## Inputs',
          Object.keys(props).length ? '| Name | Type | Required | Description |\n| --- | --- | --- | --- |' : '_None._',
          ...Object.entries(props).map(([k, v]) => `| \`${k}\` | ${cell(v.type ?? '')} | ${required.has(k) ? 'yes' : ''} | ${cell(v.description ?? '')} |`),
          '',
          '## Returns',
          s.outputDescription,
          ...(skillObjs.get(s.name)?.timeoutMs ? ['', `Time limit: ${Math.round((skillObjs.get(s.name)!.timeoutMs ?? 0) / 1000)} s`] : []),
          '',
          `Back to ${this.link('Manual/Skills', 'Skills')}`,
          '',
        ].join('\n'),
      );
    }

    notes.set(
      'Manual/Skills.md',
      [
        frontmatter({ tags: ['jarvis/manual'], jarvis_generated: true }),
        '# Skills',
        '',
        `${skills.filter((s) => s.available).length} of ${skills.length} skills are ready. Every call goes through the permission engine, is verified, and is written to the audit log.`,
        '',
        ...[...byCat.entries()].flatMap(([cat, list]) => [
          `## ${cat[0].toUpperCase()}${cat.slice(1)}`,
          '| Skill | Permission | Status |',
          '| --- | --- | --- |',
          ...list.map((s) => `| ${this.link(`Manual/Skills/${safeName(s.name)}`, s.title)} | ${cell(this.app.permissions.scopeDefinition(s.scope).label)} (${this.app.permissions.policyFor(s.scope)}) | ${s.available ? 'ready' : `unavailable — ${cell(s.unavailableReason)}`} |`),
          '',
        ]),
      ].join('\n'),
    );

    notes.set(
      'Manual/Agents.md',
      [
        frontmatter({ tags: ['jarvis/manual'], jarvis_generated: true }),
        '# Agents',
        '',
        'Each task step is handed to the least-privileged agent that can run it. Agents can only use the skills their role allows, and every call still passes the permission engine.',
        '',
        ...Object.values(AGENTS).flatMap((a) => [`## ${a.title}`, a.responsibility, '']),
      ].join('\n'),
    );

    const grants = this.app.permissions.listGrants();
    notes.set(
      'Manual/Permissions.md',
      [
        frontmatter({ tags: ['jarvis/manual'], jarvis_generated: true }),
        '# Permissions',
        '',
        '| Permission | Policy | What it covers |',
        '| --- | --- | --- |',
        ...this.app.permissions.scopes().map((s) => `| ${cell(s.label)} | ${s.policy === 'allow' ? 'allow' : s.policy === 'deny' ? 'never' : 'ask first'}${s.allowPermitted ? '' : ' (cannot be auto-allowed)'} | ${cell(s.description)} |`),
        '',
        '## Remembered authorizations',
        grants.length ? grants.map((g) => `- ${g.description} — \`${g.skill}\`, used ${g.uses}×${g.expiresAt ? `, expires ${iso(g.expiresAt)!.slice(0, 10)}` : ''}`).join('\n') : '_None._',
        '',
      ].join('\n'),
    );

    const s = this.app.settings.get();
    const providers = this.app.llm.status();
    const mcp = this.app.mcp.status();
    notes.set(
      'Manual/Integrations.md',
      [
        frontmatter({ tags: ['jarvis/manual'], jarvis_generated: true }),
        '# Integrations',
        '',
        '## Model providers',
        '| Provider | Model | Role | Status |',
        '| --- | --- | --- | --- |',
        ...providers.map((p) => `| ${cell(p.name)} | \`${cell(p.model)}\` | ${p.role} | ${!p.enabled ? 'disabled' : !p.usable ? 'not configured' : p.health ? (p.health.ok ? 'reachable' : `unreachable — ${cell(p.health.detail)}`) : 'not checked'} |`),
        '',
        '## Semantic memory',
        `${s.embeddings.enabled ? `On — ${s.embeddings.providerId === 'builtin' ? `built-in model (${this.app.localModel.state.replace('_', ' ')})` : `${s.embeddings.providerId} · ${s.embeddings.model}`}` : 'Off (keyword search only)'}`,
        '',
        '## Email',
        this.app.email.missing() ? `Not connected — ${this.app.email.missing()}` : `${s.integrations.email.address} via IMAP ${s.integrations.email.imap.host} / SMTP ${s.integrations.email.smtp.host}`,
        '',
        '## Calendar',
        this.app.calendar.caldavMissing() ? `CalDAV: not connected — ${this.app.calendar.caldavMissing()}` : `CalDAV: ${s.integrations.calendar.caldav.username} at ${new URL(s.integrations.calendar.caldav.serverUrl).host}`,
        `Feeds: ${s.integrations.calendar.feeds.length ? s.integrations.calendar.feeds.map((f) => f.name).join(', ') : 'none'}`,
        '',
        '## MCP servers',
        mcp.length ? mcp.map((m) => `- **${m.name}** — ${m.state}${m.state === 'connected' ? ` (${m.tools.length} tools)` : m.error ? `: ${m.error}` : ''}`).join('\n') : '_None._',
        '',
        '## Local files, web and shell',
        `- Workspace: \`${this.app.workspaceDir()}\``,
        `- Web pages: ${this.app.permissions.policyFor('network.read')}${s.integrations.web.allowPrivateNetwork ? ' (private network allowed)' : ''}`,
        `- Shell: ${s.integrations.shell.enabled ? 'enabled, always asks' : 'disabled'}`,
        '',
        '## Voice',
        `Input: ${s.voice.inputMode}; transcription via ${s.voice.transcription.providerId} (${s.voice.transcription.model}).`,
        '',
      ].join('\n'),
    );

    notes.set(
      'Manual/Background jobs.md',
      [
        frontmatter({ tags: ['jarvis/manual'], jarvis_generated: true }),
        '# Background jobs',
        '',
        'Internal work Jarvis does on its own. Jobs never take external actions; anything external is a task step that goes through permissions.',
        '',
        ...this.app.scheduler.status().flatMap((j) => [`## ${j.title}`, j.description, '', `Runs every ${Math.round(j.intervalMs / 60_000) || `${Math.round(j.intervalMs / 1000)} s`}${j.intervalMs >= 60_000 ? ' min' : ''}${j.paused ? ' (paused)' : ''}.`, '']),
      ].join('\n'),
    );

    for (const file of [...(existsSync(DOCS_DIR) ? readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).map((f) => join(DOCS_DIR, f)) : []), ...(existsSync(README) ? [README] : [])]) {
      const name = file === README ? 'README' : safeName(file.split(sep).pop()!.replace(/\.md$/, '').replace(/^./, (c) => c.toUpperCase()));
      const text = readFileSync(file, 'utf8').replace(/<p align="center">[\s\S]*?<\/p>\n?/g, '');
      notes.set(`Manual/Docs/${name}.md`, `${frontmatter({ tags: ['jarvis/manual', 'jarvis/docs'], jarvis_generated: true, source: file === README ? 'README.md' : `docs/${file.split(sep).pop()}` })}${text}`);
    }
  }

  private memoryNote(m: Memory): { rel: string; content: string } {
    const title = truncate(m.content.split('\n')[0], 60).replace(/… \[truncated.*$/, '…');
    const rel = `Memory/${KIND_FOLDER[m.kind]}/${safeName(title, 60)} (${m.id.slice(-6)}).md`;
    const taskLink = m.sourceRef?.startsWith('task:') ? this.taskLinkById(m.sourceRef.slice(5)) : null;
    const content = [
      frontmatter({
        jarvis_id: m.id,
        kind: m.kind,
        verified: m.verified,
        confidence: Number(m.confidence.toFixed(2)),
        source: m.source,
        sources: m.sources,
        created: iso(m.createdAt),
        updated: iso(m.updatedAt),
        tags: ['jarvis/memory', `jarvis/memory/${m.kind}`, ...m.tags.map((t) => t.replace(/[^\p{L}\p{N}_/-]/gu, '-'))],
      }),
      m.content,
      '',
      ...(taskLink ? [`Related task: ${taskLink}`, ''] : []),
      m.kind === 'task_history' ? '' : EDIT_HINT,
      '',
    ].join('\n');
    return { rel, content };
  }

  private memoryNotes(notes: Map<string, string>): void {
    const memories = MEMORY_KINDS.filter((k) => k !== 'tool_doc').flatMap((kind) => this.app.memory.list({ kind, limit: 2000 }));
    const index: string[] = [];
    for (const kind of MEMORY_KINDS) {
      if (kind === 'tool_doc') continue;
      const list = memories.filter((m) => m.kind === kind);
      if (!list.length) continue;
      index.push(`## ${KIND_FOLDER[kind]}`);
      for (const m of list) {
        const { rel, content } = this.memoryNote(m);
        notes.set(rel, content);
        index.push(`- ${this.link(rel, truncate(m.content.replace(/\s+/g, ' '), 90))}${m.verified ? '' : ' — *unverified*'}`);
      }
      index.push('');
    }
    notes.set(
      'Memory/Memory.md',
      [
        frontmatter({ tags: ['jarvis/memory'], jarvis_generated: true }),
        '# Memory',
        '',
        'What Jarvis remembers. Unverified memories are assumptions until you confirm them (set `verified: true` in a note, or confirm on the Memory page).',
        '',
        ...(index.length ? index : ['_Nothing stored yet._']),
      ].join('\n'),
    );
  }

  private taskRel(t: Task): string {
    return `Tasks/${day(t.createdAt)} ${safeName(t.title, 60)} (${t.id.slice(-6)}).md`;
  }

  private taskLinkById(id: string): string | null {
    const t = this.app.tasks.get(id);
    return t ? this.link(this.taskRel(t), t.title) : null;
  }

  private taskNotes(notes: Map<string, string>): void {
    const tasks = this.app.tasks.list({ limit: 500 });
    const rows: string[] = [];
    for (const t of tasks) {
      const rel = this.taskRel(t);
      const events = this.app.tasks.events(t.id, 200);
      notes.set(
        rel,
        [
          frontmatter({
            jarvis_id: t.id,
            status: t.status,
            priority: ['', 'low', 'normal', 'high', 'urgent'][t.priority],
            origin: t.origin,
            created: iso(t.createdAt),
            finished: iso(t.finishedAt),
            scheduled: iso(t.scheduledFor),
            tags: ['jarvis/task', `jarvis/task/${t.status}`],
          }),
          `# ${t.title}`,
          '',
          ...(t.description ? [t.description, ''] : []),
          ...(t.attention ? [`> [!warning] Needs your attention\n> ${t.attention}`, ''] : []),
          '## Steps',
          ...(t.plan?.length
            ? t.plan.map(
                (s, i) =>
                  `- [${s.status === 'done' || s.status === 'skipped' ? 'x' : ' '}] **${i + 1}. ${s.description}** — \`${s.skill}\` (${s.agent} agent, ${s.status.replace('_', ' ')})${s.verification ? ` ✓ ${s.verification}` : ''}${s.error ? ` ✗ ${s.error}` : ''}`,
              )
            : ['_Not planned yet._']),
          '',
          ...(t.result ? ['## Result', t.result.verified ? '' : '_Not fully verified._', '```', truncate(t.result.summary, 4000), '```', ''] : []),
          ...(t.error ? ['## Error', t.error, ''] : []),
          '## History',
          ...events.map((e) => `- ${day(e.ts)} ${time(e.ts)} — ${e.message.replace(/\n/g, ' ')}`),
          '',
          `Back to ${this.link('Tasks/Task log', 'Task log')}`,
          '',
        ].join('\n'),
      );
      rows.push(`| ${day(t.createdAt)} | ${this.link(rel, cell(t.title))} | ${t.status.replace('_', ' ')} | ${t.plan ? `${t.plan.filter((s) => s.status === 'done').length}/${t.plan.length}` : '—'} |`);
    }
    notes.set(
      'Tasks/Task log.md',
      [frontmatter({ tags: ['jarvis/task'], jarvis_generated: true }), '# Task log', '', rows.length ? '| Created | Task | Status | Steps |\n| --- | --- | --- | --- |' : '_No tasks yet._', ...rows, ''].join('\n'),
    );
  }

  private journalNotes(notes: Map<string, string>): void {
    const since = Date.now() - 30 * 86_400_000;
    const entries = this.app.db.all<{ ts: number; level: string; category: string; message: string }>('SELECT ts, level, category, message FROM activity WHERE ts > ? ORDER BY ts ASC', since);
    const byDay = new Map<string, typeof entries>();
    for (const e of entries) byDay.set(day(e.ts), [...(byDay.get(day(e.ts)) ?? []), e]);
    const finished = this.app.tasks.list({ limit: 500 }).filter((t) => t.finishedAt && t.finishedAt > since);
    const icon: Record<string, string> = { success: '✅', warning: '⚠️', error: '❌', info: '•' };
    for (const [d, list] of byDay) {
      const done = finished.filter((t) => day(t.finishedAt!) === d);
      notes.set(
        `Journal/${d}.md`,
        [
          frontmatter({ date: d, tags: ['jarvis/journal'], jarvis_generated: true }),
          `# ${new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
          '',
          ...(done.length ? ['## Tasks finished', ...done.map((t) => `- ${t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏹️'} ${this.link(this.taskRel(t), t.title)}`), ''] : []),
          '## Activity',
          ...list.map((e) => `- ${time(e.ts)} ${icon[e.level] ?? '•'} *${e.category}* — ${e.message.replace(/\n/g, ' ')}`),
          '',
        ].join('\n'),
      );
    }
  }

  private conversationNotes(notes: Map<string, string>): void {
    for (const c of this.app.conversations.list(200)) {
      const messages = this.app.conversations.messages(c.id, { limit: 500 });
      notes.set(
        `Conversations/${day(c.createdAt)} ${safeName(c.title, 60)} (${c.id.slice(-6)}).md`,
        [
          frontmatter({ jarvis_id: c.id, created: iso(c.createdAt), updated: iso(c.updatedAt), tags: ['jarvis/conversation'] }),
          `# ${c.title}`,
          '',
          ...(c.summary ? [`> [!summary] Summary\n> ${c.summary.replace(/\n/g, '\n> ')}`, ''] : []),
          ...messages.flatMap((m) => [`**${m.role === 'user' ? 'You' : 'Jarvis'}** · ${time(m.createdAt)}`, m.content, '']),
        ].join('\n'),
      );
    }
  }

  // ---------------------------------------------------------------- vault access for skills

  resolveInVault(requested: string): string {
    const vault = this.vaultRoot();
    const target = resolve(vault, requested.replace(/^\/+/, ''));
    const rel = relative(vault, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`"${requested}" is outside the vault`);
    let probe = target;
    while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== vault && !real.startsWith(vault + sep)) throw new Error(`"${requested}" resolves outside the vault`);
    return target;
  }

  search(query: string, limit: number, signal?: AbortSignal): Array<{ note: string; line: number | null; text: string }> {
    const vault = this.vaultRoot();
    const q = query.toLowerCase();
    const out: Array<{ note: string; line: number | null; text: string }> = [];
    const walk = (dir: string, depth: number) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= limit || signal?.aborted) return;
        if (d.name.startsWith('.')) continue; // .obsidian, .trash, .git
        const full = join(dir, d.name);
        if (d.isDirectory()) {
          if (depth < 12) walk(full, depth + 1);
          continue;
        }
        if (!d.name.endsWith('.md')) continue;
        const note = relative(vault, full).replace(/\\/g, '/').replace(/\.md$/, '');
        if (d.name.toLowerCase().includes(q)) out.push({ note, line: null, text: d.name });
        const lines = readFileSync(full, 'utf8').split('\n');
        for (let i = 0; i < lines.length && out.length < limit; i++) if (lines[i].toLowerCase().includes(q)) out.push({ note, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    };
    walk(vault, 0);
    return out;
  }

  /** A note Jarvis was asked to write. Lives in <folder>/Notes and is tracked like other Jarvis files. */
  writeNote(title: string, body: string, subfolder?: string): { note: string; rel: string; created: boolean; hash: string } {
    const base = this.base();
    const sub = subfolder ? subfolder.split(/[\\/]+/).map((p) => safeName(p, 40)).filter(Boolean).join('/') : '';
    const rel = `Notes/${sub ? `${sub}/` : ''}${safeName(title)}.md`;
    const full = join(base, rel);
    if (!full.startsWith(base + sep)) throw new Error('Invalid note location');
    const content = `${frontmatter({ created: new Date().toISOString(), created_by: 'jarvis', tags: ['jarvis/note'] })}# ${title}\n\n${body.trim()}\n`;
    const hash = sha256(content);
    const exists = existsSync(full);
    if (exists) {
      const current = readFileSync(full);
      const { body: currentBody } = readFrontmatter(current.toString('utf8'));
      if (currentBody.trim() === `# ${title}\n\n${body.trim()}`) return { note: `${this.cfg().folder}/${rel.replace(/\.md$/, '')}`, rel, created: false, hash: sha256(current) };
      throw new Error(`A note named "${title}" already exists — choose another title`);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    // Notes written on request belong to the user from now on: not tracked, never auto-removed.
    return { note: `${this.cfg().folder}/${rel.replace(/\.md$/, '')}`, rel, created: true, hash };
  }

  readNoteFile(rel: string): string {
    return readFileSync(join(this.base(), rel), 'utf8');
  }
}

// ---------------------------------------------------------------- skills

export function obsidianSkills(sync: ObsidianSync): Skill[] {
  const vaultReady = () => {
    const c = sync.cfg();
    if (!c.vaultPath) return { available: false, reason: 'No Obsidian vault configured (Integrations → Obsidian)' };
    if (!existsSync(c.vaultPath)) return { available: false, reason: `Vault folder not found: ${c.vaultPath}` };
    return { available: true };
  };

  const SearchInput = z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() });
  const search: Skill<z.infer<typeof SearchInput>, { matches: Array<{ note: string; line: number | null; text: string }> }> = {
    name: 'obsidian.search',
    title: 'Search Obsidian',
    description: 'Search the notes in your Obsidian vault by title and text.',
    category: 'files',
    scope: 'obsidian.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: SearchInput,
    outputDescription: 'Matching notes (as [[links]]) and lines.',
    dependsOn: 'Obsidian',
    availability: vaultReady,
    summarize: (i) => `Search Obsidian for "${i.query}"`,
    async execute(i, ctx) {
      return { matches: sync.search(i.query, i.limit ?? 30, ctx.signal) };
    },
    async verify(_i, o) {
      return { ok: Array.isArray(o.matches), detail: `${o.matches.length} match(es)` };
    },
    describe: (o) => (o.matches.length ? o.matches.map((m) => `[[${m.note}]]${m.line ? `:${m.line}` : ''}  ${m.text}`).join('\n') : 'No matching notes.'),
  };

  const ReadInput = z.object({ note: z.string().min(1).max(500).describe('Vault-relative path, e.g. "Projects/Roadmap" or "Projects/Roadmap.md"') });
  const read: Skill<z.infer<typeof ReadInput>, { note: string; content: string }> = {
    name: 'obsidian.read',
    title: 'Read Obsidian note',
    description: 'Read one note from your Obsidian vault.',
    category: 'files',
    scope: 'obsidian.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: ReadInput,
    outputDescription: 'The note text.',
    dependsOn: 'Obsidian',
    availability: vaultReady,
    summarize: (i) => `Read Obsidian note "${i.note}"`,
    async execute(i) {
      const path = sync.resolveInVault(i.note.endsWith('.md') ? i.note : `${i.note}.md`);
      return { note: i.note.replace(/\.md$/, ''), content: truncate(readFileSync(path, 'utf8'), 100_000) };
    },
    async verify(_i, o) {
      return { ok: typeof o.content === 'string', detail: `${o.content.length} characters` };
    },
    describe: (o) => `[[${o.note}]]\n\n${o.content}`,
  };

  const WriteInput = z.object({
    title: z.string().min(1).max(120),
    content: z.string().min(1).max(200_000).describe('Markdown body (wikilinks and tags welcome)'),
    folder: z.string().max(120).optional().describe('Optional subfolder under the Jarvis Notes folder'),
  });
  const write: Skill<z.infer<typeof WriteInput>, { note: string; rel: string; created: boolean; hash: string }> = {
    name: 'obsidian.write_note',
    title: 'Write Obsidian note',
    description: 'Create a new note in the Jarvis/Notes folder of your Obsidian vault (meeting notes, summaries, documentation). Never overwrites an existing note.',
    category: 'files',
    scope: 'obsidian.write',
    risk: 'write',
    // Writing the same title and text again is a no-op, so a repeat after a crash is safe.
    idempotent: true,
    inlineSafe: false,
    untrustedOutput: false,
    input: WriteInput,
    outputDescription: 'The new note as a vault link.',
    dependsOn: 'Obsidian',
    availability: vaultReady,
    summarize: (i) => `Create Obsidian note “${i.title}”${i.folder ? ` in Notes/${i.folder}` : ''} (${i.content.length} characters)`,
    lockKey: (i) => `obsidian:${i.title}`,
    async execute(i) {
      return sync.writeNote(i.title, i.content, i.folder);
    },
    async verify(i, o) {
      const text = sync.readNoteFile(o.rel);
      return text.includes(i.content.trim()) ? { ok: true, detail: `Note [[${o.note}]] is in the vault` } : { ok: false, detail: 'The note on disk does not contain the expected text' };
    },
    describe: (o) => `${o.created ? 'Created' : 'Already present:'} [[${o.note}]]`,
  };
  return [search, read, write];
}
