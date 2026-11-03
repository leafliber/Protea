// A scriptable MCP server for tests. stdio by default; `createFixtureServer()` is also used
// in-process behind Streamable HTTP. Behaviour is chosen with environment variables:
//   MCP_FIXTURE_EXTRA=<n>   adds n generated read-only tools (gen_000 …) for tool-search tests
//   MCP_FIXTURE_NAME=<name> server name (default "fixture")
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ListRootsResultSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required, $schema: 'https://json-schema.org/draft/2020-12/schema' });

export function createFixtureServer(env = process.env) {
  const extra = Number(env.MCP_FIXTURE_EXTRA ?? 0);
  const tools = [
    { name: 'echo', description: 'Echo the text back.', inputSchema: obj({ text: { type: 'string' } }, ['text']), annotations: { readOnlyHint: true } },
    { name: 'add', description: 'Add two numbers.', inputSchema: obj({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']) },
    { name: 'rm', description: 'Delete a file (pretend).', inputSchema: obj({ path: { type: 'string' } }, ['path']), annotations: { destructiveHint: true } },
    { name: 'slow', description: 'Wait for ms milliseconds.', inputSchema: obj({ ms: { type: 'number' } }, ['ms']), annotations: { readOnlyHint: true } },
    { name: 'fail', description: 'Always reports an error.', inputSchema: obj(), annotations: { readOnlyHint: true } },
    { name: 'crash', description: 'Exit the server process.', inputSchema: obj() },
    { name: 'grow', description: 'Add a tool named by the input and announce the change.', inputSchema: obj({ name: { type: 'string' } }, ['name']) },
    { name: 'roots', description: 'Report the client roots.', inputSchema: obj(), annotations: { readOnlyHint: true } },
    { name: 'dotted.name', description: 'A tool whose name needs cleaning.', inputSchema: obj(), annotations: { readOnlyHint: true } },
  ];
  for (let i = 0; i < extra; i++) {
    const n = String(i).padStart(3, '0');
    tools.push({ name: `gen_${n}`, description: `Generated tool number ${n}.`, inputSchema: obj({ q: { type: 'string' } }), annotations: { readOnlyHint: true } });
  }
  const server = new Server(
    { name: env.MCP_FIXTURE_NAME ?? 'fixture', version: '1.2.3' },
    { capabilities: { tools: { listChanged: true }, prompts: {}, resources: {}, logging: {} } },
  );
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extraInfo) => {
    const a = req.params.arguments ?? {};
    switch (req.params.name) {
      case 'echo':
        return text(`echo: ${a.text}`);
      case 'add':
        return { content: [{ type: 'text', text: String(a.a + a.b) }], structuredContent: { sum: a.a + a.b } };
      case 'rm':
        return text(`removed ${a.path}`);
      case 'slow':
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, a.ms);
          extraInfo.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('cancelled'));
          });
        });
        return text(`waited ${a.ms}`);
      case 'fail':
        return { content: [{ type: 'text', text: 'it went wrong' }], isError: true };
      case 'crash':
        setTimeout(() => process.exit(3), 10);
        return text('bye');
      case 'grow':
        tools.push({ name: a.name, description: `Grown tool ${a.name}.`, inputSchema: obj(), annotations: { readOnlyHint: true } });
        await server.sendToolListChanged();
        return text(`grew ${a.name}`);
      case 'roots': {
        const r = await server.request({ method: 'roots/list' }, ListRootsResultSchema);
        return text(r.roots.map((x) => x.uri).join(','));
      }
      case 'dotted.name':
        return { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'resource_link', uri: 'memo://one', name: 'one' }] };
      default:
        if (String(req.params.name).startsWith('gen_') || tools.some((t) => t.name === req.params.name)) return text(`${req.params.name}: ${a.q ?? ''}`);
        throw new Error(`unknown tool ${req.params.name}`);
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'greet', description: 'Greet someone by name.', arguments: [{ name: 'who', description: 'Whom to greet', required: true }] }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
    description: 'A greeting',
    messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${req.params.arguments?.who}.` } }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'memo://one', name: 'one', mimeType: 'text/plain' }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({ contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: `contents of ${req.params.uri}` }] }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stderr.write('fixture MCP server starting\n');
  await createFixtureServer().connect(new StdioServerTransport());
}
