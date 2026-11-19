import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { JarvisApp } from '../app.ts';
import { AGENTS } from '../agents/agents.ts';
import { SUB_AGENTS } from '../agents/subagents.ts';
import { errorMessage, sha256, truncate } from '../core/util.ts';
import { MEMORY_KINDS, type Memory, type MemoryKind } from '../memory/store.ts';
import { CATEGORY_LABEL, DIGEST_CATEGORIES, type Digest, type DigestCategory } from '../agents/digest.ts';
import type { Task } from '../tasks/store.ts';
import type { Skill } from '../skills/types.ts';

/**
 * Jarvis's own Obsidian vault, kept up to date automatically: everything it learns lives there.
 *
 * Jarvis creates a dedicated vault (default ~/Documents/Jarvis Vault) with Obsidian settings and
 * writes plain Markdown with YAML frontmatter, tags and [[wikilinks]]: a live manual (skills,
 * agents, permissions, integrations, background jobs, architecture docs), memories, task
 * history, conversations and a daily journal.
 *
 * Safety rules:
 *  - Jarvis only uses a vault it created (marked by .jarvis-vault.json); it refuses to write
 *    into a folder that already holds other content, such as the user's personal vault.
 *  - Nothing outside the vault is ever written; .obsidian settings are only written on creation.
 *  - Jarvis remembers the hash of every file it wrote. If a file on disk no longer matches, the
 *    user edited it: Jarvis never overwrites or deletes it. Edits to memory notes are imported
 *    back into Jarvis as corrections.
 *  - Credentials, API keys and calendar feed URLs are never written.
 *  - Conversations/ and Digests/ are an archive: every conversation and every digest Jarvis made of
 *    it stays in the vault for good, even after the conversation itself is deleted from Jarvis.
 */

/** Vault folders the sync only ever adds to: nothing in them is removed when it leaves Jarvis's database. */
const ARCHIVE_PREFIXES = ['Conversations/', 'Digests/'];

const here = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(here, '..', '..', 'docs');
const README = join(here, '..', '..', 'README.md');

const KIND_FOLDER: Record<MemoryKind, string> = {
  rule: 'Rules',
  plan: 'Plans',
  schedule: 'Schedules',
  idea: 'Ideas',
  preference: 'Preferences',
  project: 'Projects',
  decision: 'Decisions',
  procedure: 'Procedures',
  fact: 'Facts',
  task_history: 'Task history',
  tool_doc: 'Tool docs',
};

const KNOWLEDGE_INTRO: Record<DigestCategory, string> = {
  rule: 'Standing instructions you gave Jarvis. Every one is in Jarvis’s context on every turn, until you change it (edit or delete it on the Memory page, or edit its note).',
  preference: 'How you like things. Always in Jarvis’s context.',
  plan: 'What you (or you and Jarvis) plan to do. In Jarvis’s context on every turn.',
  schedule: 'Anything with a time or a date: appointments, deadlines, recurring things. In Jarvis’s context on every turn.',
  idea: 'Ideas from your conversations.',
  decision: 'Decisions you made.',
  project: 'Your projects and what Jarvis knows about them.',
  procedure: 'How to do things, step by step.',
  fact: 'Facts about you, your work and your world.',
  request: 'What you asked Jarvis to do in the last 90 days.',
  question: 'Questions you asked in the last 90 days.',
};

const EDIT_HINT = '%% Edit the text above to correct this memory, or set verified: true to confirm it. Jarvis imports your change on the next sync. %%';

const VAULT_MARKER = '.jarvis-vault.json';

export function isJarvisVault(path: string): boolean {
  return existsSync(join(path, VAULT_MARKER));
}

export function defaultVaultPath(): string {
  const docs = join(homedir(), 'Documents');
  return join(existsSync(docs) ? docs : homedir(), 'Jarvis Vault');
}

const rgb = (hex: string) => parseInt(hex.slice(1), 16);

/** Obsidian settings written once when Jarvis creates its vault. */
const OBSIDIAN_CONFIG: Record<string, unknown> = {
  'app.json': { alwaysUpdateLinks: true, newFileLocation: 'folder', newFileFolderPath: 'Inbox', attachmentFolderPath: 'Attachments', showFrontmatter: true },
  'appearance.json': { theme: 'obsidian', accentColor: '#8b5cf6' },
  'core-plugins.json': {
    'file-explorer': true,
    'global-search': true,
    switcher: true,
    graph: true,
    backlink: true,
    'outgoing-link': true,
    'tag-pane': true,
    properties: true,
    'page-preview': true,
    'daily-notes': true,
    'note-composer': true,
    'command-palette': true,
    bookmarks: true,
    outline: true,
    'word-count': true,
    'file-recovery': true,
  },
  'daily-notes.json': { folder: 'Journal', format: 'YYYY-MM-DD' },
  'graph.json': {
    colorGroups: [
      { query: 'tag:#jarvis/memory', color: { a: 1, rgb: rgb('#8b5cf6') } },
      { query: 'tag:#jarvis/task', color: { a: 1, rgb: rgb('#34d399') } },
      { query: 'tag:#jarvis/skill', color: { a: 1, rgb: rgb('#7dd3fc') } },
      { query: 'tag:#jarvis/journal', color: { a: 1, rgb: rgb('#fbbf24') } },
      { query: 'tag:#jarvis/conversation', color: { a: 1, rgb: rgb('#f0abfc') } },
    ],
  },
};

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
  private known: Set<string> = new Set();

  constructor(app: JarvisApp) {
    this.app = app;
  }

  cfg() {
    return this.app.settings.get().integrations.obsidian;
  }

  /** Where Jarvis's own vault lives: the configured path, JARVIS_VAULT_DIR, or ~/Documents/Jarvis Vault. */
  vaultPath(): string {
    const configured = this.cfg().vaultPath.trim() || process.env.JARVIS_VAULT_DIR || defaultVaultPath();
    return resolve(configured);
  }

  /** Why syncing can't run right now, or null when it can. */
  problem(): string | null {
    const c = this.cfg();
    if (!c.enabled) return 'The Jarvis vault is turned off';
    const p = this.vaultPath();
    if (c.vaultPath.trim() && !isAbsolute(c.vaultPath.trim())) return 'The vault location must be a full path';
    if (existsSync(p)) {
      if (!statSync(p).isDirectory()) return `${p} is a file, not a folder`;
      if (!isJarvisVault(p) && readdirSync(p).some((f) => f !== '.DS_Store')) {
        return `${p} already contains other files. Jarvis keeps its own separate vault — choose a new or empty folder.`;
      }
    }
    return null;
  }

  /** True once the vault exists with Obsidian settings (it can be opened in Obsidian). */
  vaultReady(): boolean {
    const p = this.vaultPath();
    return isJarvisVault(p) && existsSync(join(p, '.obsidian'));
  }

  vaultRoot(): string {
    return realpathSync(this.vaultPath());
  }

  /**
   * Create Jarvis's vault the first time: the folder, Obsidian settings tuned for it, and a
   * marker file so Jarvis never mistakes someone else's vault for its own. Existing settings
   * are never touched afterwards.
   */
  ensureVault(): { root: string; created: boolean } {
    const p = this.vaultPath();
    const problem = this.problem();
    if (problem) throw new Error(problem);
    const created = !isJarvisVault(p);
    if (created) {
      mkdirSync(join(p, '.obsidian'), { recursive: true });
      for (const [file, value] of Object.entries(OBSIDIAN_CONFIG)) {
        const target = join(p, '.obsidian', file);
        if (!existsSync(target)) writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
      }
      writeFileSync(join(p, VAULT_MARKER), `${JSON.stringify({ app: 'jarvis', createdAt: new Date().toISOString(), note: 'This vault is maintained by Jarvis.' }, null, 2)}\n`);
      this.app.activity.log('success', 'obsidian', `Created the Jarvis vault at ${p}`);
    }
    return { root: realpathSync(p), created };
  }

  private base(): string {
    return this.ensureVault().root;
  }

  /** Vault-relative wikilink (no .md). */
  private link(rel: string, label?: string): string {
    const target = rel.replace(/\.md$/, '');
    return label ? `[[${target}|${label}]]` : `[[${target}]]`;
  }

  /** obsidian:// link that opens the vault's home note (once the vault is known to Obsidian). */
  openUri(): string {
    return `obsidian://open?path=${encodeURIComponent(join(this.vaultPath(), 'Jarvis.md'))}`;
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
      const state = new Map(this.app.db.all<{ path: string; hash: string }>('SELECT path, hash FROM obsidian_files WHERE vault = ?', base).map((r) => [r.path, r.hash]));
      const edited = (rel: string): boolean => {
        const full = join(base, rel);
        const known = state.get(rel);
        return Boolean(known && existsSync(full) && sha256(readFileSync(full)) !== known);
      };

      // 1. Import corrections the user made to memory notes.
      report.imported = this.importMemoryEdits(base, state, edited);

      // 2. Build the full set of notes and write the ones that changed.
      const notes = this.buildNotes(new Set(state.keys()));
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
        if (notes.has(rel) || ARCHIVE_PREFIXES.some((p) => rel.startsWith(p))) continue;
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
    this.app.db.run(
      'INSERT INTO obsidian_files (vault, path, hash, written_at) VALUES (?, ?, ?, ?) ON CONFLICT(vault, path) DO UPDATE SET hash = excluded.hash, written_at = excluded.written_at',
      this.vaultRoot(),
      rel,
      hash,
      Date.now(),
    );
  }

  private forget(rel: string): void {
    this.app.db.run('DELETE FROM obsidian_files WHERE vault = ? AND path = ?', this.vaultRoot(), rel);
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

  /**
   * @param known notes already in the vault: archive notes (conversations, digests) that haven't
   * changed since the last sync are skipped instead of rebuilt, so years of conversations stay cheap.
   */
  buildNotes(known: Set<string> = new Set()): Map<string, string> {
    const inc = this.cfg().include;
    const notes = new Map<string, string>();
    this.known = known;
    if (inc.manual) this.manualNotes(notes);
    if (inc.memories) this.memoryNotes(notes);
    if (inc.memories) this.agentNotes(notes);
    if (inc.tasks) this.taskNotes(notes);
    if (inc.journal) this.journalNotes(notes);
    if (inc.conversations) this.conversationNotes(notes);
    if (inc.conversations) this.digestNotes(notes);
    if (inc.memories || inc.conversations) this.knowledgeNotes(notes);
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
      'This is Jarvis’s own vault: everything it learns is kept here and updated automatically. Notes you edit are never overwritten, edits to memory notes are imported back into Jarvis, and notes you add yourself are left alone.',
      '',
      ...(inc.manual
        ? ['## Manual', `- ${this.link('Manual/Skills', 'Skills')}`, `- ${this.link('Manual/Agents', 'Agents')}`, `- ${this.link('Manual/Permissions', 'Permissions')}`, `- ${this.link('Manual/Integrations', 'Integrations')}`, `- ${this.link('Manual/Background jobs', 'Background jobs')}`]
        : []),
      ...[...notes.keys()].filter((k) => k.startsWith('Manual/Docs/')).map((k) => `- ${this.link(k, k.split('/').pop()!.replace(/\.md$/, ''))}`),
      ...(inc.memories || inc.conversations
        ? [
            '',
            '## Knowledge',
            `- ${this.link('Knowledge/Knowledge', 'Everything Jarvis knows, by category')} — ${DIGEST_CATEGORIES.map((c) => this.link(`Knowledge/${CATEGORY_LABEL[c]}`, CATEGORY_LABEL[c])).join(' · ')}`,
            ...(inc.memories ? [`- ${this.link('Memory/Memory', 'Memory index')}`, `- ${this.link('Agents/Agents', 'Agents — the shared mind')}`] : []),
          ]
        : []),
      ...(inc.conversations ? ['', '## Conversations', `- ${this.link('Digests/Digests', 'Conversation digests')} — what was new, what was repeated, day by day`] : []),
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
    const engine = this.app.llm.status();
    const roamies = this.app.gate.detection();
    const mcp = this.app.mcp.status();
    notes.set(
      'Manual/Integrations.md',
      [
        frontmatter({ tags: ['jarvis/manual'], jarvis_generated: true }),
        '# Integrations',
        '',
        '## Model (Roamies engine)',
        'Jarvis is built on [Roamies](https://github.com/KenKaiii/Roamies) and thinks with its engine (the GG framework), using the model and sign-ins chosen in Roamies.',
        '',
        `- Roamies: ${roamies.installed ? `installed${roamies.version ? ` (${roamies.version})` : ''}` : 'not found'}`,
        `- Model: ${engine.model ? `${engine.model.name} (\`${engine.model.id}\`)` : 'none'}${engine.provider ? ` from ${engine.provider.name}` : ''}${engine.source === 'jarvis' ? ' — chosen in Jarvis settings' : engine.source === 'auto' ? ' — Roamies has none picked; using the first sign-in' : ''}`,
        `- Route: ${engine.route === 'claude-code' ? 'Claude sign-in through Claude Code' : engine.route === 'api' ? 'direct to the provider' : '—'}`,
        `- Signed in: ${engine.signedIn.length ? engine.signedIn.map((p) => p.name).join(', ') : 'nothing yet'}`,
        `- Status: ${engine.ready ? (engine.health ? (engine.health.ok ? 'working' : `problem — ${engine.health.detail}`) : 'ready') : (engine.problem ?? 'unavailable')}`,
        '',
        '## Semantic memory',
        `${s.embeddings.enabled ? `On — built-in model (${this.app.localModel.state.replace('_', ' ')})` : 'Off (keyword search only)'}`,
        '',
        '## Email',
        this.app.email.missing() ? `Not connected — ${this.app.email.missing()}` : `${s.integrations.email.address} via IMAP ${s.integrations.email.imap.host} / SMTP ${s.integrations.email.smtp.host}`,
        '',
        '## Calendar',
        this.app.calendar.caldavMissing() ? `CalDAV: not connected — ${this.app.calendar.caldavMissing()}` : `CalDAV: ${s.integrations.calendar.caldav.username} at ${new URL(s.integrations.calendar.caldav.serverUrl).host}`,
        `Feeds: ${s.integrations.calendar.feeds.length ? s.integrations.calendar.feeds.map((f) => f.name).join(', ') : 'none'}`,
                `Feeds: ${s.integrations.calendar.feeds.length ? s.integrations.calendar.feeds.map((f) => f.name).join(', ') : 'none'}`,
        '',
        '## Bug-bounty pipeline (HackerOne)',
        this.app.pipeline.missing() ? `Not connected — ${this.app.pipeline.missing()}` : `Connected as ${s.integrations.hackerone.username}; ${s.integrations.hackerone.autoRun ? `running every ${s.integrations.hackerone.intervalMin} min` : 'not auto-running'}. Read-only: earnings, reports and program discovery.`,
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
        `Input: ${s.voice.inputMode}; transcription: ${s.voice.transcription.service === 'openai' ? 'OpenAI (key from Roamies)' : s.voice.transcription.service === 'custom' ? 'own server' : 'none'} (${s.voice.transcription.model}).`,
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

  /**
   * One shared knowledge mind: each sub-agent gets a note holding everything it has learned (its
   * memories, tagged `agent:<id>`), plus an index across the whole team. The memories themselves
   * also live under Memory/ and are searchable by Jarvis and by every other agent — this is the
   * navigable, per-agent view of that one mind.
   */
  private agentNotes(notes: Map<string, string>): void {
    const index: string[] = [];
    let total = 0;
    for (const a of SUB_AGENTS) {
      const rows = this.app.db.all<{ content: string; created_at: number; verified: number }>(
        'SELECT content, created_at, verified FROM memories WHERE source = ? ORDER BY created_at DESC LIMIT 200',
        `agent:${a.id}`,
      );
      total += rows.length;
      const rel = `Agents/${safeName(a.name)}.md`;
      notes.set(
        rel,
        [
          frontmatter({ type: 'agent', agent: a.id, color: a.color, memories: rows.length, tags: ['jarvis/agent', `jarvis/agent/${a.id}`], jarvis_generated: true }),
          `# ${a.name}`,
          '',
          `> [!info] ${a.name}\n> ${a.role}`,
          '',
          `**${rows.length}** ${rows.length === 1 ? 'memory' : 'memories'} in ${a.name}'s mind. Everything here is part of one shared knowledge mind: Jarvis and every other agent can recall it too.`,
          '',
          '## What it has learned',
          ...(rows.length
            ? rows.map((r) => `- **${day(r.created_at)} ${time(r.created_at)}** — ${truncate(r.content.replace(/\s+/g, ' '), 300)}${r.verified ? '' : ' *(unverified)*'}`)
            : ['_Nothing learned yet. This agent writes here as it runs._']),
          '',
          `Part of the ${this.link('Agents/Agents', 'shared knowledge mind')} · back to ${this.link('Jarvis', 'Jarvis')}.`,
          '',
        ].join('\n'),
      );
      index.push(`### ${this.link(rel, a.name)}`, a.role, `${rows.length} ${rows.length === 1 ? 'memory' : 'memories'}.`, '');
    }
    notes.set(
      'Agents/Agents.md',
      [
        frontmatter({ tags: ['jarvis/agent'], jarvis_generated: true }),
        '# Agents — the shared mind',
        '',
        `Jarvis runs a team of ${SUB_AGENTS.length} sub-agents. Each keeps its own memory, but it is all **one mind**: every finding is stored in Jarvis's memory (tagged \`agent:<name>\`), so Jarvis — the harness — and every other agent can recall all of it. Right now the team holds **${total}** ${total === 1 ? 'memory' : 'memories'}.`,
        '',
        ...index,
        `Each agent's memories also appear in ${this.link('Memory/Memory', 'the Memory index')} and are searchable from anywhere in Jarvis.`,
        '',
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
    const entries = this.app.db.all<{ ts: number; level: string; category: string; message: string }>("SELECT ts, level, category, message FROM activity WHERE ts > ? AND category != 'obsidian' ORDER BY ts ASC", since);
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

  private convRel(c: { id: string; createdAt: number; title: string }): string {
    return `Conversations/${day(c.createdAt)} ${safeName(c.title, 60)} (${c.id.slice(-6)}).md`;
  }

  /** Changed since the last successful sync (or not in the vault yet), so worth (re)building. */
  private stale(rel: string, changedAt: number): boolean {
    const last = this.lastReport?.ok ? this.lastReport.at : 0;
    return !this.known.has(rel) || changedAt >= last - 5000;
  }

  private digestBlock(d: Digest, linkConversation: boolean): string[] {
    const conv = this.app.conversations.get(d.conversationId);
    const head = linkConversation && conv ? this.link(this.convRel(conv), d.conversationTitle) : d.conversationTitle;
    const line = (it: Digest['items'][number]) => `- **${CATEGORY_LABEL[it.category].replace(/s$/, '')}:** ${it.text.replace(/\n/g, ' ')}`;
    const fresh = d.items.filter((i) => i.status === 'new');
    const again = d.items.filter((i) => i.status === 'repeated');
    return [
      `### ${time(d.toTs)} · ${head}`,
      `*${d.messages} message${d.messages === 1 ? '' : 's'} · ${d.newCount} new · ${d.repeatedCount} repeated · ${d.method === 'model' ? 'digested by Jarvis’s model' : 'quick digest (no model was available; redone by the model later)'}*`,
      '',
      `> ${d.summary.replace(/\n/g, '\n> ')}`,
      '',
      ...(fresh.length ? ['**New**', ...fresh.map(line), ''] : []),
      ...(again.length ? ['**Repeated**', ...again.map(line), ''] : []),
    ];
  }

  private conversationNotes(notes: Map<string, string>): void {
    const convs = this.app.db
      .all<Record<string, unknown>>('SELECT id, title, summary, created_at, updated_at, (SELECT MAX(created_at) FROM conversation_digests d WHERE d.conversation_id = c.id) AS digested_at FROM conversations c ORDER BY updated_at DESC')
      .map((r) => ({ id: String(r.id), title: String(r.title), summary: (r.summary as string | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), digestedAt: Number(r.digested_at ?? 0) }));
    for (const c of convs) {
      const rel = this.convRel(c);
      if (!this.stale(rel, Math.max(c.updatedAt, c.digestedAt))) continue;
      const messages = this.app.conversations.messages(c.id, { limit: 5000 });
      const digests = this.app.digester.list({ conversationId: c.id, limit: 500 }).reverse();
      notes.set(
        rel,
        [
          frontmatter({ jarvis_id: c.id, created: iso(c.createdAt), updated: iso(c.updatedAt), messages: messages.length, digests: digests.length, tags: ['jarvis/conversation'] }),
          `# ${c.title}`,
          '',
          ...(digests.length ? ['## Jarvis’s digest', '', ...digests.flatMap((d) => this.digestBlock(d, false))] : c.summary ? [`> [!summary] Summary\n> ${c.summary.replace(/\n/g, '\n> ')}`, ''] : ['*Not digested yet — Jarvis digests a conversation once it has been quiet for a minute.*', '']),
          '## Transcript',
          '',
          ...messages.flatMap((m) => [`**${m.role === 'user' ? 'You' : 'Jarvis'}** · ${day(m.createdAt)} ${time(m.createdAt)}`, m.content, '']),
        ].join('\n'),
      );
    }
  }

  /** One note per day with every digest Jarvis made that day, plus an index. */
  private digestNotes(notes: Map<string, string>): void {
    const all = this.app.digester.list({ limit: 100_000 });
    const byDay = new Map<string, Digest[]>();
    for (const d of all) byDay.set(day(d.toTs), [...(byDay.get(day(d.toTs)) ?? []), d]);
    const days = [...byDay.keys()].sort().reverse();
    for (const dd of days) {
      const list = byDay.get(dd)!.sort((a, b) => a.toTs - b.toTs);
      const rel = `Digests/${dd}.md`;
      if (!this.stale(rel, Math.max(...list.map((d) => d.createdAt)))) continue;
      const n = list.reduce((a, d) => a + d.newCount, 0);
      const r = list.reduce((a, d) => a + d.repeatedCount, 0);
      notes.set(
        rel,
        [
          frontmatter({ date: dd, digests: list.length, new: n, repeated: r, tags: ['jarvis/digest'] }),
          `# Conversations on ${new Date(`${dd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
          '',
          `${list.length} digest${list.length === 1 ? '' : 's'} · ${n} new · ${r} repeated`,
          '',
          ...list.flatMap((d) => this.digestBlock(d, true)),
        ].join('\n'),
      );
    }
    const stats = this.app.digester.stats();
    notes.set(
      'Digests/Digests.md',
      [
        frontmatter({ tags: ['jarvis/digest'], jarvis_generated: true }),
        '# Conversation digests',
        '',
        'After every conversation (once it has been quiet for a minute) Jarvis writes itself a digest: a summary, then everything worth keeping — marked **new** or **repeated** and filed by category (see [[Knowledge/Knowledge|Knowledge]]). Conversations from before a restart are digested on the next start. These notes are an archive: they stay even if the conversation is deleted from Jarvis.',
        '',
        `${stats.digests} digest${stats.digests === 1 ? '' : 's'}${stats.pendingConversations ? ` · ${stats.pendingConversations} conversation${stats.pendingConversations === 1 ? '' : 's'} waiting to be digested` : ''}`,
        '',
        ...(days.length ? days.slice(0, 120).map((d) => `- ${this.link(`Digests/${d}`, d)} — ${byDay.get(d)!.map((x) => x.conversationTitle).slice(0, 4).join(' · ')}`) : ['_No conversations digested yet._']),
        '',
      ].join('\n'),
    );
  }

  /** Everything Jarvis knows, one note per category: rules, preferences, plans, schedules, ideas, … */
  private knowledgeNotes(notes: Map<string, string>): void {
    const counts: string[] = [];
    const fromDigests = this.app.digester.list({ since: Date.now() - 90 * 86_400_000, limit: 2000 });
    for (const cat of DIGEST_CATEGORIES) {
      const label = CATEGORY_LABEL[cat];
      const lines: string[] = [];
      let n = 0;
      if (cat === 'request' || cat === 'question') {
        for (const d of fromDigests) {
          const conv = this.app.conversations.get(d.conversationId);
          for (const it of d.items.filter((i) => i.category === cat)) {
            n++;
            lines.push(`- ${day(d.toTs)} · ${it.text.replace(/\n/g, ' ')}${it.status === 'repeated' ? ' *(repeated)*' : ''} — ${conv ? this.link(this.convRel(conv), d.conversationTitle) : d.conversationTitle}`);
          }
        }
      } else {
        for (const m of this.app.memory.list({ kind: cat as MemoryKind, limit: 2000 })) {
          n++;
          const { rel } = this.memoryNote(m);
          const times = m.mergedCount > 1 ? ` · mentioned ${m.mergedCount}×` : '';
          lines.push(`- ${m.content.replace(/\n/g, ' ')} — *${day(m.createdAt)}${times}${m.verified ? '' : ' · as Jarvis understood it'}* ${this.link(rel, '↗')}`);
        }
      }
      counts.push(`- ${this.link(`Knowledge/${label}`, label)} — ${n}`);
      notes.set(
        `Knowledge/${label}.md`,
        [
          frontmatter({ tags: ['jarvis/knowledge', `jarvis/knowledge/${cat}`], jarvis_generated: true, count: n }),
          `# ${label}`,
          '',
          KNOWLEDGE_INTRO[cat],
          '',
          ...(lines.length ? lines : ['_Nothing yet._']),
          '',
        ].join('\n'),
      );
    }
    notes.set(
      'Knowledge/Knowledge.md',
      [
        frontmatter({ tags: ['jarvis/knowledge'], jarvis_generated: true }),
        '# Knowledge',
        '',
        'Everything Jarvis has learned from your conversations, by category. Rules, preferences, plans and schedules are in Jarvis’s context on every turn; the rest is searched when relevant.',
        '',
        ...counts,
        '',
        `Day by day: ${this.link('Digests/Digests', 'conversation digests')}.`,
        '',
      ].join('\n'),
    );
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
      if (currentBody.trim() === `# ${title}\n\n${body.trim()}`) return { note: rel.replace(/\.md$/, ''), rel, created: false, hash: sha256(current) };
      throw new Error(`A note named "${title}" already exists — choose another title`);
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    // Notes written on request belong to the user from now on: not tracked, never auto-removed.
    return { note: rel.replace(/\.md$/, ''), rel, created: true, hash };
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
    title: 'Search Jarvis vault',
    description: 'Search the notes in the Jarvis Obsidian vault (everything Jarvis has learned, plus notes you added) by title and text.',
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
    title: 'Read vault note',
    description: 'Read one note from the Jarvis Obsidian vault.',
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
    description: 'Create a new note in the Notes folder of the Jarvis vault (meeting notes, summaries, documentation). Never overwrites an existing note.',
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
