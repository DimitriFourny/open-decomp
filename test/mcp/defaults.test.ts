import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolSchemas } from '../../src/core/index.js';
import type { ToolResult } from '../../src/core/index.js';
import { applyDefaults, projectDefaults } from '../../src/mcp/defaults.js';
import type { McpServerDefaults } from '../../src/mcp/defaults.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { QueryService } from '../../src/service/queries/index.js';

const fixture = resolve('fixtures/bin/macho-arm64-symbols');

// What a client sees of the advertised tool schemas, parsed instead of cast.
const importVariantSchema = z.object({
  properties: z.object({
    source: z.object({
      oneOf: z.array(
        z.object({
          properties: z.object({ kind: z.looseObject({ const: z.string().optional() }) }),
          required: z.array(z.string()),
        }),
      ),
    }),
  }),
});
const optionsSchema = z.object({
  properties: z.object({
    options: z.object({
      default: z.looseObject({ emitter: z.string() }),
      properties: z.object({ emitter: z.looseObject({ default: z.string() }) }),
    }),
  }),
});
function importVariant(schema: unknown): { readonly required: readonly string[] } {
  const variant = importVariantSchema
    .parse(schema)
    .properties.source.oneOf.find((item) => item.properties.kind.const === 'import');
  assert.ok(variant);
  return variant;
}
async function directory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-mcp-defaults-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function connect(t: TestContext, root: string, defaults: McpServerDefaults | undefined) {
  const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
  const handler = createMcpHandler(() =>
    createMcpServer(service, defaults === undefined ? {} : { defaults }),
  );
  const client = new Client({ name: 'defaults-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await handler.close();
    await service.close('cancel');
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://defaults.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

test(
  'function_decompile uses the settings language when the request omits it; an explicit value wins',
  {
    timeout: 120_000,
  },
  async (t) => {
    const root = await directory(t);
    const input = join(root, 'app');
    await copyFile(fixture, input);
    const client = await connect(t, root, {
      decompile: { language: 'python-like', view: 'source' },
    });
    const opened = toolSchemas.project_open.output.parse(
      (
        await client.callTool({
          name: 'project_open',
          arguments: {
            wait: true,
            source: { kind: 'import', input_path: input, project_path: join(root, 'project') },
          },
        })
      ).structuredContent,
    );
    assert.ok('data' in opened && opened.project_id !== null && opened.revision !== null);
    const scope = { project_id: opened.project_id, revision: opened.revision };
    const decompile = async (extra: Record<string, unknown>): Promise<string> => {
      const response = await client.callTool({
        name: 'function_decompile',
        arguments: {
          ...scope,
          function_id: 'fixture_arithmetic',
          wait: true,
          detail: 'full',
          ...extra,
        },
      });
      const result: ToolResult<'function_decompile'> = toolSchemas.function_decompile.output.parse(
        response.structuredContent,
      );
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      return result.data.emission.language;
    };
    assert.equal(await decompile({}), 'python-like', 'omitted options use the file language');
    assert.equal(
      await decompile({ options: { indent: 4 } }),
      'python-like',
      'other options keep it',
    );
    assert.equal(await decompile({ options: { emitter: 'c-like' } }), 'c-like', 'explicit wins');
    assert.equal(
      await decompile({ options: { emitter: 'python-like' } }),
      'python-like',
      'explicit python-like',
    );
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === 'function_decompile',
    )!;
    const options = optionsSchema.parse(advertised.inputSchema).properties.options;
    assert.equal(options.properties.emitter.default, 'python-like');
    assert.equal(options.default.emitter, 'python-like');
  },
);

test('without defaults a request keeps the built-in language', { timeout: 120_000 }, async (t) => {
  const root = await directory(t);
  const input = join(root, 'app');
  await copyFile(fixture, input);
  const client = await connect(t, root, undefined);
  const opened = toolSchemas.project_open.output.parse(
    (
      await client.callTool({
        name: 'project_open',
        arguments: {
          wait: true,
          source: { kind: 'import', input_path: input, project_path: join(root, 'project') },
        },
      })
    ).structuredContent,
  );
  assert.ok('data' in opened && opened.project_id !== null && opened.revision !== null);
  const response = await client.callTool({
    name: 'function_decompile',
    arguments: {
      project_id: opened.project_id,
      revision: opened.revision,
      function_id: 'fixture_arithmetic',
      wait: true,
      detail: 'full',
    },
  });
  const result = toolSchemas.function_decompile.output.parse(response.structuredContent);
  assert.ok('data' in result && result.data.delivery === 'inline');
  assert.equal(result.data.emission.language, 'c-like');
});

test(
  'cache_root lets project_open omit project_path and resumes the same content',
  {
    timeout: 120_000,
  },
  async (t) => {
    const root = await directory(t);
    const cache = join(root, 'cache');
    await mkdir(cache);
    const input = join(root, 'app');
    await copyFile(fixture, input);
    const projects = await projectDefaults(cache, [root]);
    const client = await connect(t, root, { projects });
    const open = async () =>
      toolSchemas.project_open.output.parse(
        (
          await client.callTool({
            name: 'project_open',
            arguments: { wait: true, source: { kind: 'import', input_path: input } },
          })
        ).structuredContent,
      );
    const first = await open();
    assert.ok('data' in first && first.project_id !== null, JSON.stringify(first));
    const created = await readdir(cache);
    assert.equal(created.length, 1);
    assert.match(created[0]!, /^[0-9a-f]{64}\.default$/);
    await client.callTool({
      name: 'project_close',
      arguments: { project_id: first.project_id, revision: first.revision },
    });
    const second = await open();
    assert.ok('data' in second && second.data.image !== null, JSON.stringify(second));
    assert.deepEqual(await readdir(cache), created, 'the same content resumes its project');
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === 'project_open',
    )!;
    const variant = importVariant(advertised.inputSchema);
    assert.ok(!variant.required.includes('project_path'));
    assert.ok(variant.required.includes('input_path'));
  },
);

test(
  'project_open still requires project_path when no cache_root is configured',
  {
    timeout: 60_000,
  },
  async (t) => {
    const root = await directory(t);
    const client = await connect(t, root, undefined);
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === 'project_open',
    )!;
    const variant = importVariant(advertised.inputSchema);
    assert.ok(variant.required.includes('project_path'));
    const response = await client.callTool({
      name: 'project_open',
      arguments: { source: { kind: 'import', input_path: join(root, 'app') } },
    });
    assert.equal(response.isError, true);
  },
);

test('applyDefaults merges decompile options without overriding and leaves other requests alone', async (t) => {
  const defaults: McpServerDefaults = { decompile: { language: 'python-like', view: 'checked' } };
  const base = { project_id: 'p', revision: 1, function_id: 'main' };
  assert.deepEqual(await applyDefaults('function_decompile', base, defaults), {
    input: { ...base, options: { emitter: 'python-like', view: 'checked' } },
  });
  assert.deepEqual(
    await applyDefaults('function_decompile', { ...base, options: { view: 'source' } }, defaults),
    { input: { ...base, options: { emitter: 'python-like', view: 'source' } } },
  );
  const malformed = { ...base, options: 'c-like' };
  assert.deepEqual(await applyDefaults('function_decompile', malformed, defaults), {
    input: malformed,
  });
  assert.deepEqual(await applyDefaults('functions_find', base, defaults), { input: base });
  assert.deepEqual(await applyDefaults('function_decompile', base, undefined), { input: base });
  assert.deepEqual(await applyDefaults('function_decompile', 'text', defaults), { input: 'text' });

  const root = await directory(t);
  const projects = await projectDefaults(root, [root]);
  const explicit = {
    source: { kind: 'import', input_path: '/x', project_path: join(root, 'mine') },
  };
  assert.deepEqual(await applyDefaults('project_open', explicit, { projects }), {
    input: explicit,
  });
  const resume = { source: { kind: 'resume', project_path: join(root, 'mine') } };
  assert.deepEqual(await applyDefaults('project_open', resume, { projects }), { input: resume });
  const relative = { source: { kind: 'import', input_path: 'app' } };
  const problem = await applyDefaults('project_open', relative, { projects });
  assert.ok('path' in problem && problem.path === 'source.input_path');
});

test('a defaulted project path never reads an input outside the authorized roots', async (t) => {
  const root = await directory(t);
  const projects = await projectDefaults(root, [root]);
  const outside = await directory(t);
  await copyFile(fixture, join(outside, 'app'));
  const result = await applyDefaults(
    'project_open',
    { source: { kind: 'import', input_path: join(outside, 'app') } },
    { projects },
  );
  assert.ok('path' in result && result.path === 'source.input_path', JSON.stringify(result));
  assert.match(result.hint, /outside host-authorized roots/);
});

test('projectDefaults rejects a cache_root that is missing, a file or outside every root', async (t) => {
  const root = await directory(t);
  const outside = await directory(t);
  await copyFile(fixture, join(root, 'file'));
  await assert.rejects(
    projectDefaults(join(root, 'absent'), [root]),
    /"cache_root".*existing directory/,
  );
  await assert.rejects(
    projectDefaults(join(root, 'file'), [root]),
    /"cache_root".*existing directory/,
  );
  await assert.rejects(projectDefaults(outside, [root]), /"cache_root".*inside an authorized/);
  const ok = await projectDefaults(root, [root]);
  assert.deepEqual(ok, { cache_root: root, authorized_roots: [root] });
});
