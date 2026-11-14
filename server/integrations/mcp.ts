import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { ActivityLog } from '../core/activity.ts';
import type { EventBus } from '../core/events.ts';
import type { SecretStore } from '../core/secrets.ts';
import type { McpServerConfig, SettingsStore } from '../core/settings.ts';
import { errorMessage, truncate } from '../core/util.ts';
import { mcpScope, type PermissionEngine, type ScopeDefinition } from '../permissions/engine.ts';
import type { SkillRegistry } from '../skills/registry.ts';
import type { Skill } from '../skills/types.ts';

export const PROTOCOL_VERSION = '2025-06-18';

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal Model Context Protocol client over stdio (newline-delimited JSON-RPC 2.0). */
export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail = '';
  serverInfo: { name?: string; version?: string } = {};
  onExit: ((reason: string) => void) | null = null;

  async connect(command: string, args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<void> {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    const spawnError = new Promise<never>((_, reject) => this.child!.once('error', (err) => reject(new Error(`Could not start "${command}": ${err.message}`))));
    this.child.on('exit', (code, signal) => {
      const reason = `MCP server exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pending.clear();
      this.child = null;
      this.onExit?.(reason);
    });
    const init = (await Promise.race([
      this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'jarvis', version: '1.0.0' } }, timeoutMs),
      spawnError,
    ])) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init.serverInfo ?? {};
    this.notify('notifications/initialized', {});
  }

  get connected(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number }; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-protocol output
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        const p = this.pending.get(Number(msg.id));
        if (!p) continue;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? `MCP error ${msg.error.code}`));
        else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // Server-initiated requests (sampling, roots...) are not supported: reply with an error.
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Jarvis' } });
      }
    }
  }

  private write(obj: unknown): void {
    if (!this.child?.stdin?.writable) throw new Error('MCP server is not running');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          try {
            this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' });
          } catch {
            /* ignore */
          }
          reject(new Error('Cancelled'));
        },
        { once: true },
      );
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(res.tools ?? []));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ content?: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean; structuredContent?: unknown }> {
    return (await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs, signal)) as never;
  }

  close(): void {
    if (!this.child) return;
    this.onExit = null;
    try {
      this.child.stdin?.end();
      this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}

export interface McpServerStatus {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'connected' | 'error';
  error: string | null;
  serverInfo: { name?: string; version?: string };
  tools: Array<{ name: string; skill: string; description: string; readOnly: boolean }>;
  secretEnv: Array<{ name: string; configured: boolean }>;
  connectedAt: number | null;
}

const sanitizeName = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

/** Keeps configured MCP servers connected and their tools registered as Jarvis skills. */
export class McpManager {
  private settings: SettingsStore;
  private secrets: SecretStore;
  private registry: SkillRegistry;
  private activity: ActivityLog;
  private bus: EventBus;
  private servers = new Map<string, { client: McpClient | null; status: McpServerStatus; sig: string }>();

  constructor(deps: { settings: SettingsStore; secrets: SecretStore; registry: SkillRegistry; activity: ActivityLog; bus: EventBus; permissions: PermissionEngine }) {
    this.settings = deps.settings;
    this.secrets = deps.secrets;
    this.registry = deps.registry;
    this.activity = deps.activity;
    this.bus = deps.bus;
    deps.permissions.setDynamicScopes(() => this.scopes());
  }

  scopes(): ScopeDefinition[] {
    return this.settings.get().integrations.mcpServers.map((s) => ({
      id: mcpScope(s.id),
      label: `MCP: ${s.name}`,
      description: `Use tools provided by the "${s.name}" MCP server`,
      external: true,
      defaultPolicy: 'ask',
      allowPermitted: true,
    }));
  }

  secretName(serverId: string, envName: string): string {
    return `mcp:${serverId}:env:${envName}`;
  }

  /** Reconcile running servers with settings. */
  async sync(): Promise<void> {
    const configs = this.settings.get().integrations.mcpServers;
    const ids = new Set(configs.map((c) => c.id));
    for (const id of [...this.servers.keys()]) if (!ids.has(id)) this.stopServer(id);
    await Promise.all(
      configs.map(async (cfg) => {
        const sig = JSON.stringify([cfg.command, cfg.args, cfg.env, cfg.secretEnv, cfg.enabled]);
        const existing = this.servers.get(cfg.id);
        if (existing && existing.sig === sig && (existing.status.state === 'connected' || !cfg.enabled)) {
          existing.status.name = cfg.name;
          return;
        }
        await this.startServer(cfg, sig);
      }),
    );
  }

  private baseStatus(cfg: McpServerConfig): McpServerStatus {
    return {
      id: cfg.id,
      name: cfg.name,
      command: cfg.command,
      args: cfg.args,
      enabled: cfg.enabled,
      state: cfg.enabled ? 'connecting' : 'disabled',
      error: null,
      serverInfo: {},
      tools: [],
      secretEnv: cfg.secretEnv.map((name) => ({ name, configured: this.secrets.has(this.secretName(cfg.id, name)) })),
      connectedAt: null,
    };
  }

  async startServer(cfg: McpServerConfig, sig = ''): Promise<void> {
    this.stopServer(cfg.id);
    const status = this.baseStatus(cfg);
    const entry = { client: null as McpClient | null, status, sig };
    this.servers.set(cfg.id, entry);
    this.changed();
    if (!cfg.enabled) return;
    const env: Record<string, string> = { ...cfg.env };
    for (const name of cfg.secretEnv) {
      const v = this.secrets.get(this.secretName(cfg.id, name));
      if (v) env[name] = v;
    }
    const client = new McpClient();
    entry.client = client;
    try {
      await client.connect(cfg.command, cfg.args, env);
      const tools = await client.listTools();
      status.serverInfo = client.serverInfo;
      status.state = 'connected';
      status.connectedAt = Date.now();
      status.tools = tools.map((t) => ({ name: t.name, skill: `mcp.${cfg.id}.${sanitizeName(t.name)}`, description: t.description ?? '', readOnly: Boolean(t.annotations?.readOnlyHint) }));
      for (const tool of tools) this.registry.register(this.toolSkill(cfg, tool, client));
      client.onExit = (reason) => {
        status.state = 'error';
        status.error = reason;
        this.registry.unregisterPrefix(`mcp.${cfg.id}.`);
        this.activity.log('warning', 'integrations', `MCP server "${cfg.name}" disconnected: ${reason}`);
        this.changed();
      };
      this.activity.log('success', 'integrations', `Connected MCP server "${cfg.name}" (${tools.length} tools)`);
    } catch (err) {
      client.close();
      entry.client = null;
      status.state = 'error';
      status.error = errorMessage(err);
      this.activity.log('error', 'integrations', `MCP server "${cfg.name}" failed to start: ${status.error}`);
    }
    this.changed();
  }

  stopServer(id: string): void {
    const entry = this.servers.get(id);
    if (!entry) return;
    entry.client?.close();
    this.registry.unregisterPrefix(`mcp.${id}.`);
    this.servers.delete(id);
    this.changed();
  }

  async reconnect(id: string): Promise<void> {
    const cfg = this.settings.get().integrations.mcpServers.find((s) => s.id === id);
    if (!cfg) throw new Error('MCP server not found');
    await this.startServer(cfg, JSON.stringify([cfg.command, cfg.args, cfg.env, cfg.secretEnv, cfg.enabled]));
  }

  status(): McpServerStatus[] {
    return this.settings.get().integrations.mcpServers.map((cfg) => {
      const s = this.servers.get(cfg.id)?.status ?? this.baseStatus(cfg);
      return { ...s, name: cfg.name, secretEnv: cfg.secretEnv.map((name) => ({ name, configured: this.secrets.has(this.secretName(cfg.id, name)) })) };
    });
  }

  /** Health check used by the scheduler: reconnect servers that died. */
  async health(): Promise<string> {
    let restarted = 0;
    for (const cfg of this.settings.get().integrations.mcpServers) {
      const entry = this.servers.get(cfg.id);
      if (cfg.enabled && (!entry || entry.status.state === 'error')) {
        await this.reconnect(cfg.id);
        restarted++;
      }
    }
    return restarted ? `reconnect attempted for ${restarted} MCP server(s)` : 'MCP servers healthy';
  }

  stopAll(): void {
    for (const id of [...this.servers.keys()]) this.stopServer(id);
  }

  private changed(): void {
    this.bus.emit('integrations.changed', {});
  }

  private toolSkill(cfg: McpServerConfig, tool: McpTool, client: McpClient): Skill {
    const readOnly = Boolean(tool.annotations?.readOnlyHint);
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
    return {
      name: `mcp.${cfg.id}.${sanitizeName(tool.name)}`,
      title: tool.title ?? tool.annotations?.title ?? tool.name,
      description: `[MCP: ${cfg.name}] ${truncate(tool.description ?? tool.name, 600)}`,
      category: 'mcp',
      scope: mcpScope(cfg.id),
      risk: readOnly ? 'read' : 'consequential',
      idempotent: Boolean(tool.annotations?.idempotentHint) || readOnly,
      inlineSafe: false,
      untrustedOutput: true,
      input: z.record(z.string(), z.unknown()),
      inputJsonSchema: schema,
      outputDescription: 'Tool result content from the MCP server.',
      timeoutMs: 120_000,
      dependsOn: `MCP: ${cfg.name}`,
      availability: () => (client.connected ? { available: true } : { available: false, reason: `MCP server "${cfg.name}" is not connected` }),
      summarize: (input) => `${cfg.name} → ${tool.name}(${truncate(JSON.stringify(input), 200)})`,
      async execute(input, ctx) {
        const res = await client.callTool(tool.name, input, 120_000, ctx.signal);
        const text = (res.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`)).join('\n');
        return { isError: Boolean(res.isError), text, structured: res.structuredContent ?? null };
      },
      async verify(_i, out: { isError: boolean; text: string }) {
        return out.isError ? { ok: false, detail: `Tool reported an error: ${truncate(out.text, 300)}` } : { ok: true, detail: 'MCP tool returned a successful result' };
      },
      describe: (out: { text: string }) => out.text || '(no text content)',
    };
  }
}
