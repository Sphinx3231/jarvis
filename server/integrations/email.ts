import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { SecretStore } from '../core/secrets.ts';
import type { Settings, SettingsStore } from '../core/settings.ts';
import { errorMessage, truncate } from '../core/util.ts';
import { htmlToText } from '../skills/builtin/web.ts';
import type { Skill, SkillServices } from '../skills/types.ts';

/**
 * Email over standard protocols: IMAP to search and read, SMTP to send. Works with any provider
 * that offers app passwords (Gmail, iCloud, Fastmail, Yahoo, most hosts). The password is stored
 * encrypted; sending always requires the user's approval.
 */

export const EMAIL_SECRET = 'email:password';

export interface EmailSummary {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  unread: boolean;
  snippet: string;
}

export interface EmailMessage extends Omit<EmailSummary, 'snippet'> {
  cc: string;
  text: string;
  truncated: boolean;
  attachments: Array<{ filename: string; size: number }>;
  messageId: string | null;
}

type EmailConfig = Settings['integrations']['email'];

const addr = (list?: Array<{ name?: string; address?: string }> | null) =>
  (list ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ''))).join(', ');

export class EmailService {
  private settings: SettingsStore;
  private secrets: SecretStore;
  lastCheck: { ok: boolean; detail: string; at: number } | null = null;

  constructor(settings: SettingsStore, secrets: SecretStore) {
    this.settings = settings;
    this.secrets = secrets;
  }

  config(): EmailConfig {
    return this.settings.get().integrations.email;
  }

  missing(): string | null {
    const c = this.config();
    if (!c.enabled) return 'Email is turned off (Integrations → Email)';
    if (!c.address || !c.imap.host || !c.smtp.host) return 'Email account is not fully configured';
    if (!this.secrets.has(EMAIL_SECRET)) return 'Email password is not set';
    return null;
  }

  private user(): string {
    const c = this.config();
    return c.username || c.address;
  }

  private async imap<T>(fn: (client: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const c = this.config();
    const client = new ImapFlow({
      host: c.imap.host,
      port: c.imap.port,
      secure: c.imap.security === 'tls',
      doSTARTTLS: c.imap.security === 'starttls' ? true : c.imap.security === 'none' ? false : undefined,
      auth: { user: this.user(), pass: this.secrets.get(EMAIL_SECRET) ?? '' },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
    });
    client.on('error', () => {}); // surfaced through the awaited calls instead
    const onAbort = () => void client.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await client.logout().catch(() => client.close());
    }
  }

  private transport() {
    const c = this.config();
    return nodemailer.createTransport({
      host: c.smtp.host,
      port: c.smtp.port,
      secure: c.smtp.security === 'tls',
      requireTLS: c.smtp.security === 'starttls',
      ignoreTLS: c.smtp.security === 'none',
      auth: { user: this.user(), pass: this.secrets.get(EMAIL_SECRET) ?? '' },
      connectionTimeout: 20_000,
    });
  }

  /** Log in to both servers without reading or sending anything. */
  async test(): Promise<{ ok: boolean; detail: string }> {
    const missing = this.missing();
    if (missing) return this.record(false, missing);
    try {
      const mailboxes = await this.imap(async (client) => (await client.list()).length);
      await this.transport().verify();
      return this.record(true, `Signed in to IMAP (${mailboxes} folders) and SMTP`);
    } catch (err) {
      return this.record(false, errorMessage(err));
    }
  }

  private record(ok: boolean, detail: string) {
    this.lastCheck = { ok, detail, at: Date.now() };
    return { ok, detail };
  }

  async search(opts: { query?: string; from?: string; unreadOnly?: boolean; sinceDays?: number; mailbox?: string; limit?: number }, signal?: AbortSignal): Promise<{ mailbox: string; total: number; messages: EmailSummary[] }> {
    const mailbox = opts.mailbox ?? 'INBOX';
    return this.imap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const criteria: SearchObject = {};
        if (opts.unreadOnly) criteria.seen = false;
        if (opts.from) criteria.from = opts.from;
        if (opts.sinceDays) criteria.since = new Date(Date.now() - opts.sinceDays * 86_400_000);
        if (opts.query) criteria.or = [{ subject: opts.query }, { body: opts.query }, { from: opts.query }];
        if (!Object.keys(criteria).length) criteria.all = true;
        const uids = ((await client.search(criteria, { uid: true })) || []).sort((a, b) => b - a);
        const pick = uids.slice(0, opts.limit ?? 10);
        const messages: EmailSummary[] = [];
        if (pick.length) {
          for await (const m of client.fetch(pick, { uid: true, envelope: true, flags: true, source: { maxLength: 20_000 } }, { uid: true })) {
            const parsed = m.source ? await simpleParser(m.source).catch(() => null) : null;
            const text = parsed?.text ?? (parsed?.html ? htmlToText(parsed.html).text : '');
            messages.push({
              uid: m.uid,
              from: addr(m.envelope?.from),
              to: addr(m.envelope?.to),
              subject: m.envelope?.subject ?? '(no subject)',
              date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
              unread: !m.flags?.has('\\Seen'),
              snippet: truncate(text.replace(/\s+/g, ' ').trim(), 240),
            });
          }
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { mailbox, total: uids.length, messages };
      } finally {
        lock.release();
      }
    }, signal);
  }

  async read(uid: number, mailbox = 'INBOX', signal?: AbortSignal): Promise<EmailMessage> {
    return this.imap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        // Reading through BODY.PEEK keeps the message unread on the server.
        const m = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, source: true }, { uid: true });
        if (!m || !m.source) throw new Error(`No message with id ${uid} in ${mailbox}`);
        const parsed = await simpleParser(m.source);
        const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html).text : '');
        return {
          uid,
          from: addr(m.envelope?.from),
          to: addr(m.envelope?.to),
          cc: addr(m.envelope?.cc),
          subject: m.envelope?.subject ?? '(no subject)',
          date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
          unread: !m.flags?.has('\\Seen'),
          text: truncate(text.trim(), 30_000),
          truncated: text.length > 30_000,
          attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? 'attachment', size: a.size })),
          messageId: parsed.messageId ?? null,
        };
      } finally {
        lock.release();
      }
    }, signal);
  }

  async send(msg: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string }): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    const c = this.config();
    const info = await this.transport().sendMail({
      from: c.displayName ? { name: c.displayName, address: c.address } : c.address,
      to: msg.to,
      cc: msg.cc,
      subject: msg.subject,
      text: msg.body,
      inReplyTo: msg.inReplyTo,
      references: msg.inReplyTo,
    });
    const norm = (list: unknown[]) => list.map((a) => (typeof a === 'string' ? a : String((a as { address?: string }).address ?? a)));
    return { messageId: info.messageId, accepted: norm(info.accepted ?? []), rejected: norm(info.rejected ?? []) };
  }
}

// ---------------------------------------------------------------- skills

const available = (email: EmailService) => () => {
  const missing = email.missing();
  return missing ? { available: false, reason: missing } : { available: true };
};

export function emailSkills(email: EmailService): Skill[] {
  const SearchInput = z.object({
    query: z.string().max(200).optional().describe('Words to find in subject, body or sender'),
    from: z.string().max(200).optional(),
    unreadOnly: z.boolean().optional(),
    sinceDays: z.number().int().min(1).max(3650).optional(),
    mailbox: z.string().max(200).optional().describe('Folder, default INBOX'),
    limit: z.number().int().min(1).max(25).optional(),
  });
  const search: Skill<z.infer<typeof SearchInput>, Awaited<ReturnType<EmailService['search']>>> = {
    name: 'email.search',
    title: 'Search email',
    description: 'Search your mailbox and list matching messages (sender, subject, date, snippet). Does not mark anything as read.',
    category: 'email',
    scope: 'email.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: SearchInput,
    outputDescription: 'Matching messages with uid, sender, subject, date and a short snippet.',
    timeoutMs: 60_000,
    dependsOn: 'Email',
    availability: available(email),
    summarize: (i) => `Search email${i.query ? ` for "${i.query}"` : ''}${i.from ? ` from ${i.from}` : ''}${i.unreadOnly ? ' (unread)' : ''}`,
    execute: (i, ctx) => email.search(i, ctx.signal),
    async verify(_i, out) {
      return { ok: Array.isArray(out.messages), detail: `${out.messages.length} of ${out.total} matching message(s)` };
    },
    describe: (o) =>
      o.messages.length
        ? o.messages.map((m) => `[uid ${m.uid}] ${m.unread ? '(unread) ' : ''}${m.date?.slice(0, 16).replace('T', ' ') ?? ''} — ${m.from}: ${m.subject}\n  ${m.snippet}`).join('\n')
        : 'No matching messages.',
  };

  const ReadInput = z.object({ uid: z.number().int().positive().describe('Message uid from email.search'), mailbox: z.string().max(200).optional() });
  const read: Skill<z.infer<typeof ReadInput>, EmailMessage> = {
    name: 'email.read',
    title: 'Read email',
    description: 'Read one email message in full (text, recipients, attachment names). Does not mark it as read.',
    category: 'email',
    scope: 'email.read',
    risk: 'read',
    idempotent: true,
    inlineSafe: true,
    untrustedOutput: true,
    input: ReadInput,
    outputDescription: 'The message headers, plain text body and attachment names.',
    timeoutMs: 60_000,
    dependsOn: 'Email',
    availability: available(email),
    summarize: (i) => `Read email ${i.uid}${i.mailbox ? ` in ${i.mailbox}` : ''}`,
    execute: (i, ctx) => email.read(i.uid, i.mailbox, ctx.signal),
    async verify(i, out) {
      return { ok: out.uid === i.uid, detail: `Read “${out.subject}”` };
    },
    describe: (m) =>
      `From: ${m.from}\nTo: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ''}\nDate: ${m.date ?? ''}\nSubject: ${m.subject}${m.attachments.length ? `\nAttachments: ${m.attachments.map((a) => a.filename).join(', ')}` : ''}\n\n${m.text}`,
  };

  const SendInput = z.object({
    to: z.array(z.string().email()).min(1).max(20),
    cc: z.array(z.string().email()).max(20).optional(),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(50_000),
    inReplyTo: z.string().max(500).optional().describe('Message-ID being replied to'),
  });
  const send: Skill<z.infer<typeof SendInput>, Awaited<ReturnType<EmailService['send']>>> = {
    name: 'email.send',
    title: 'Send email',
    description: 'Send an email from your account. Always requires your approval of the exact message.',
    category: 'email',
    scope: 'email.send',
    risk: 'consequential',
    idempotent: false,
    inlineSafe: false,
    untrustedOutput: false,
    input: SendInput,
    outputDescription: 'Message-ID and which recipients the server accepted.',
    timeoutMs: 60_000,
    dependsOn: 'Email',
    availability: available(email),
    summarize: (i) => `Send email to ${[...i.to, ...(i.cc ?? [])].join(', ')}: “${i.subject}” — ${truncate(i.body.replace(/\s+/g, ' '), 160)}`,
    execute: (i) => email.send(i),
    async verify(i, out) {
      const wanted = [...i.to, ...(i.cc ?? [])].map((a) => a.toLowerCase());
      const accepted = out.accepted.map((a) => a.toLowerCase());
      const missing = wanted.filter((a) => !accepted.includes(a));
      if (out.rejected.length || missing.length) return { ok: false, detail: `Server did not accept: ${[...out.rejected, ...missing].join(', ')}` };
      return out.messageId ? { ok: true, detail: `Accepted for delivery to ${accepted.length} recipient(s)` } : { ok: false, detail: 'No message id returned' };
    },
    describe: (o) => `Sent (${o.messageId}) to ${o.accepted.join(', ')}`,
  };
  return [search, read, send];
}


