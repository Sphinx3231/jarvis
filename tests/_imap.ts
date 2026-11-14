import { createRequire } from 'node:module';
import { ImapFlow } from 'imapflow';
const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');
const server = hoodiecrow({ plugins: ['IDLE', 'UNSELECT', 'SPECIAL-USE', 'ID', 'ENABLE', 'LITERALPLUS', 'SASL-IR', 'AUTH-PLAIN'], users: { jarvis: { password: 'secret' } },
  storage: { INBOX: { messages: [{ raw: 'From: Ada <ada@example.com>\r\nTo: me@example.com\r\nSubject: Dragon budget\r\nDate: Fri, 13 Nov 2026 10:00:00 +0000\r\nMessage-ID: <1@example.com>\r\n\r\nPlease review the dragon budget by Friday.', flags: [] }] } } });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = server.server ? server.server.address().port : server.address?.().port;
console.log('port', port);
const client = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'jarvis', pass: 'secret' }, logger: false, tls: { rejectUnauthorized: false } });
await client.connect();
const lock = await client.getMailboxLock('INBOX');
for await (const m of client.fetch('1:*', { envelope: true, uid: true, source: true })) console.log(m.uid, m.envelope?.subject, m.envelope?.from?.[0]?.address);
console.log('search', await client.search({ subject: 'dragon' }, { uid: true }));
lock.release(); await client.logout(); server.close?.();
