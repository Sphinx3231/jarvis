// Minimal MCP server over stdio used by the tests.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'save.note', description: 'Save a note somewhere external', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
  { name: 'crash', description: 'Exit the server', inputSchema: { type: 'object', properties: {} } },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.1.0' } } });
  if (msg.method === 'tools/list') return send({ id: msg.id, result: { tools } });
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'echo') return send({ id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args.text} (token=${process.env.FAKE_TOKEN ?? 'none'})` }] } });
    if (name === 'save.note') return send({ id: msg.id, result: { content: [{ type: 'text', text: 'storage full' }], isError: true } });
    if (name === 'crash') process.exit(3);
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
});
