import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveInWorkspace } from './files.ts';
import type { Skill } from '../types.ts';

const Input = z.object({
  command: z.string().min(1).max(4000).describe('Shell command to run'),
  cwd: z.string().max(1000).optional().describe('Working folder relative to the workspace'),
  timeoutSec: z.number().int().min(1).max(1800).optional(),
});
type Out = { command: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; truncated: boolean };

const MAX_OUTPUT = 100_000;

/**
 * Runs a command in the workspace folder. Always consequential: it can never be allowed
 * globally, only approved per action (or remembered for one exact command).
 */
export const shellRun: Skill<z.infer<typeof Input>, Out> = {
  name: 'shell.run',
  title: 'Run command',
  description: 'Run a shell command on this computer inside the Jarvis workspace folder. Always requires explicit approval.',
  category: 'shell',
  scope: 'shell.exec',
  risk: 'consequential',
  idempotent: false,
  inlineSafe: false,
  untrustedOutput: true,
  input: Input,
  outputDescription: 'Exit code, stdout and stderr.',
  timeoutMs: 1_800_000,
  dependsOn: 'Shell',
  availability: (s) => (s.settings.get().integrations.shell.enabled ? { available: true } : { available: false, reason: 'Shell commands are disabled in Settings → Integrations' }),
  summarize: (i) => `Run command: ${i.command}${i.cwd ? ` (in workspace/${i.cwd})` : ''}`,
  async execute(input, ctx) {
    const cwd = resolveInWorkspace(ctx.services.workspaceDir(), input.cwd ?? '.');
    const started = Date.now();
    return await new Promise<Out>((resolvePromise, reject) => {
      const child = spawn(input.command, { cwd, shell: true, env: { ...process.env, JARVIS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const add = (which: 'out' | 'err', chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (which === 'out') stdout += text;
        else stderr += text;
        if (stdout.length + stderr.length > MAX_OUTPUT) {
          truncated = true;
          stdout = stdout.slice(0, MAX_OUTPUT);
          stderr = stderr.slice(0, MAX_OUTPUT / 4);
        }
      };
      child.stdout.on('data', (c: Buffer) => add('out', c));
      child.stderr.on('data', (c: Buffer) => add('err', c));
      const kill = () => child.kill('SIGTERM');
      ctx.signal.addEventListener('abort', kill, { once: true });
      const timer = input.timeoutSec ? setTimeout(kill, input.timeoutSec * 1000) : undefined;
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', kill);
        resolvePromise({ command: input.command, exitCode: code, signal, stdout, stderr, durationMs: Date.now() - started, truncated });
      });
    });
  },
  async verify(_i, out) {
    if (out.signal) return { ok: false, detail: `Command was terminated by ${out.signal}` };
    return out.exitCode === 0 ? { ok: true, detail: 'Exit code 0' } : { ok: false, detail: `Exit code ${out.exitCode}${out.stderr ? `: ${out.stderr.trim().slice(0, 300)}` : ''}` };
  },
  describe: (o) => `$ ${o.command}\nexit ${o.exitCode}${o.stdout ? `\n${o.stdout.trim()}` : ''}${o.stderr ? `\n[stderr]\n${o.stderr.trim()}` : ''}`,
};
