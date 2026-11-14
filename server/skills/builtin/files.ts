import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../../core/util.ts';
import type { Skill, SkillServices } from '../types.ts';

/**
 * Resolve a user/model supplied path inside the workspace. Rejects absolute paths outside it,
 * ".." traversal and symlinks that escape the workspace.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, isAbsolute(requested) ? requested : `./${requested}`);
  const rel = relative(realRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path "${requested}" is outside the Jarvis workspace`);
  // Follow symlinks on the deepest existing ancestor and make sure it stays inside.
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new Error(`Path "${requested}" resolves outside the Jarvis workspace`);
  return target;
}

const workspaceAvailable = (s: SkillServices) => {
  const dir = s.workspaceDir();
  return existsSync(dir) ? { available: true } : { available: false, reason: `Workspace folder ${dir} does not exist` };
};

const rel = (s: SkillServices, p: string) => relative(realpathSync(s.workspaceDir()), p) || '.';

const ListInput = z.object({
  path: z.string().max(1000).optional().describe('Folder relative to the workspace (default: workspace root)'),
  recursive: z.boolean().optional(),
});
type Entry = { path: string; type: 'file' | 'dir'; size: number; modified: number };

export const filesList: Skill<z.infer<typeof ListInput>, { root: string; entries: Entry[]; truncated: boolean }> = {
  name: 'files.list',
  title: 'List files',
  description: 'List files and folders in the Jarvis workspace folder.',
  category: 'files',
  scope: 'files.read',
  risk: 'read',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: false,
  input: ListInput,
  outputDescription: 'Entries with relative path, type, size and modification time.',
  dependsOn: 'Local files',
  availability: workspaceAvailable,
  summarize: (i) => `List files in workspace/${i.path ?? ''}`,
  async execute(input, ctx) {
    const base = resolveInWorkspace(ctx.services.workspaceDir(), input.path ?? '.');
    const entries: Entry[] = [];
    const LIMIT = 500;
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        if (entries.length >= LIMIT) return;
        if (d.name.startsWith('.')) continue;
        const full = join(dir, d.name);
        const st = await stat(full);
        entries.push({ path: rel(ctx.services, full), type: d.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtimeMs });
        if (d.isDirectory() && input.recursive && depth < 6) await walk(full, depth + 1);
      }
    };
    await walk(base, 0);
    return { root: rel(ctx.services, base), entries, truncated: entries.length >= LIMIT };
  },
  async verify(_i, out) {
    return { ok: Array.isArray(out.entries), detail: `${out.entries.length} entries` };
  },
  describe: (o) => (o.entries.length ? o.entries.map((e) => `${e.type === 'dir' ? '[dir] ' : ''}${e.path}${e.type === 'file' ? ` (${e.size} B)` : ''}`).join('\n') : 'Folder is empty.'),
};

const ReadInput = z.object({
  path: z.string().min(1).max(1000),
  maxBytes: z.number().int().min(1).max(2_000_000).optional(),
});

export const filesRead: Skill<z.infer<typeof ReadInput>, { path: string; content: string; bytes: number; truncated: boolean; sha256: string }> = {
  name: 'files.read',
  title: 'Read file',
  description: 'Read a text file from the Jarvis workspace folder.',
  category: 'files',
  scope: 'files.read',
  risk: 'read',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: true,
  input: ReadInput,
  outputDescription: 'File content (text), size and SHA-256.',
  dependsOn: 'Local files',
  availability: workspaceAvailable,
  summarize: (i) => `Read workspace/${i.path}`,
  async execute(input, ctx) {
    const full = resolveInWorkspace(ctx.services.workspaceDir(), input.path);
    const st = await stat(full);
    if (!st.isFile()) throw new Error(`${input.path} is not a file`);
    const max = input.maxBytes ?? 200_000;
    const buf = await readFile(full);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${input.path} looks like a binary file`);
    return { path: rel(ctx.services, full), content: buf.subarray(0, max).toString('utf8'), bytes: buf.length, truncated: buf.length > max, sha256: sha256(buf) };
  },
  async verify(_i, out) {
    return { ok: typeof out.content === 'string', detail: `${out.bytes} bytes read` };
  },
  describe: (o) => `${o.path} (${o.bytes} bytes${o.truncated ? ', truncated' : ''}):\n${o.content}`,
};

const SearchInput = z.object({
  query: z.string().min(1).max(200).describe('Text to find in file names and contents (case-insensitive)'),
  path: z.string().max(1000).optional(),
});
type Match = { path: string; line: number | null; text: string };

export const filesSearch: Skill<z.infer<typeof SearchInput>, { matches: Match[]; filesScanned: number; truncated: boolean }> = {
  name: 'files.search',
  title: 'Search files',
  description: 'Find files in the workspace whose name or text content contains a query.',
  category: 'files',
  scope: 'files.read',
  risk: 'read',
  idempotent: true,
  inlineSafe: true,
  untrustedOutput: true,
  input: SearchInput,
  outputDescription: 'Matching file paths and lines.',
  dependsOn: 'Local files',
  availability: workspaceAvailable,
  summarize: (i) => `Search workspace files for "${i.query}"`,
  async execute(input, ctx) {
    const base = resolveInWorkspace(ctx.services.workspaceDir(), input.path ?? '.');
    const q = input.query.toLowerCase();
    const matches: Match[] = [];
    let filesScanned = 0;
    const LIMIT = 100;
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        if (matches.length >= LIMIT || ctx.signal.aborted) return;
        if (d.name.startsWith('.') || d.name === 'node_modules') continue;
        const full = join(dir, d.name);
        if (d.isDirectory()) {
          if (depth < 8) await walk(full, depth + 1);
          continue;
        }
        filesScanned++;
        if (d.name.toLowerCase().includes(q)) matches.push({ path: rel(ctx.services, full), line: null, text: d.name });
        const st = await stat(full);
        if (st.size > 1_000_000) continue;
        const buf = await readFile(full);
        if (buf.subarray(0, 8000).includes(0)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && matches.length < LIMIT; i++) {
          if (lines[i].toLowerCase().includes(q)) matches.push({ path: rel(ctx.services, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    };
    await walk(base, 0);
    return { matches, filesScanned, truncated: matches.length >= LIMIT };
  },
  async verify(_i, out) {
    return { ok: Array.isArray(out.matches), detail: `${out.matches.length} matches in ${out.filesScanned} files` };
  },
  describe: (o) => (o.matches.length ? o.matches.map((m) => `${m.path}${m.line ? `:${m.line}` : ''}  ${m.text}`).join('\n') : `No matches (${o.filesScanned} files scanned).`),
};

const WriteInput = z.object({
  path: z.string().min(1).max(1000),
  content: z.string().max(5_000_000),
  mode: z.enum(['create', 'overwrite', 'append']).describe('create fails if the file exists'),
});

function hashFile(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

export const filesWrite: Skill<z.infer<typeof WriteInput>, { path: string; bytesWritten: number; sha256: string; mode: string }> = {
  name: 'files.write',
  title: 'Write file',
  description: 'Create, overwrite or append to a text file inside the Jarvis workspace folder. Requires approval by default.',
  category: 'files',
  scope: 'files.write',
  risk: 'write',
  idempotent: false,
  inlineSafe: false,
  untrustedOutput: false,
  input: WriteInput,
  outputDescription: 'Path, bytes written and the SHA-256 of the file after writing.',
  dependsOn: 'Local files',
  availability: workspaceAvailable,
  summarize: (i) => `${i.mode === 'append' ? 'Append to' : i.mode === 'overwrite' ? 'Overwrite' : 'Create'} workspace/${i.path} (${Buffer.byteLength(i.content)} bytes)`,
  lockKey: (i) => `file:${i.path}`,
  async execute(input, ctx) {
    const full = resolveInWorkspace(ctx.services.workspaceDir(), input.path);
    await mkdir(dirname(full), { recursive: true });
    if (input.mode === 'append') await appendFile(full, input.content, 'utf8');
    else await writeFile(full, input.content, { encoding: 'utf8', flag: input.mode === 'create' ? 'wx' : 'w' });
    return { path: rel(ctx.services, full), bytesWritten: Buffer.byteLength(input.content), sha256: await hashFile(full), mode: input.mode };
  },
  async verify(input, out, ctx) {
    const full = resolveInWorkspace(ctx.services.workspaceDir(), input.path);
    if (!existsSync(full)) return { ok: false, detail: 'File does not exist after writing' };
    const buf = await readFile(full);
    if (input.mode === 'append') {
      return buf.subarray(buf.length - Buffer.byteLength(input.content)).toString('utf8') === input.content
        ? { ok: true, detail: 'Appended content present at end of file' }
        : { ok: false, detail: 'Appended content not found at end of file' };
    }
    const expected = sha256(Buffer.from(input.content, 'utf8'));
    return sha256(buf) === expected && out.sha256 === expected ? { ok: true, detail: 'File content matches (SHA-256)' } : { ok: false, detail: 'File content does not match what was written' };
  },
  describe: (o) => `Wrote ${o.bytesWritten} bytes to ${o.path} (${o.mode})`,
};
