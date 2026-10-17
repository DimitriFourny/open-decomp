import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  DEFAULT_BUDGET,
  entityIdentity,
  validateToolRequest,
  validateToolResponse,
  type FunctionRecord,
} from '../../src/core/index.js';
import { createMcpServer, MCP_MAX_RESULT_BYTES } from '../../src/mcp/server.js';
import { decodeNavigationText } from '../../src/mcp/navigation.js';
import { SqliteProjectStore } from '../../src/project/store/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import { fixtureImage } from '../metadata/fixture.js';

for (const limit of [20, 1000])
  test(
    `escaped MCP function pages shrink at the transport ceiling and retain cursor coverage (limit ${limit})`,
    { timeout: 60000 },
    async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-navigation-')));
      const projectPath = join(root, 'project');
      const store = SqliteProjectStore.open(projectPath, 'create');
      const image = fixtureImage('metadata.dll');
      await store.importImage({
        bytes: image.bytes,
        sha256: image.sha256,
        selected_slice_id: image.selected_slice_id,
      });
      const entry = image.exports.find((record) => record.address !== null)!.address!;
      const functions: FunctionRecord[] = Array.from({ length: 20 }, (_, index) => ({
        id: entityIdentity(image.selected_slice_id, 'function', `escaped-${index}`),
        entry: { ...entry, value: entry.value + BigInt(index) },
        ranges: [{ start: { ...entry, value: entry.value + BigInt(index) }, size: 1n }],
        boundary: 'candidate',
        original_name: `${index}:` + '"\\'.repeat(10000),
        display_name: null,
        evidence_ids: [],
        signature: null,
        analysis: 'not_analyzed',
      }));
      assert.equal(
        store.transaction(1, (tx) => {
          tx.putImage(image);
          for (const fn of functions) tx.putRecord(image.id, 'function', fn);
          tx.setIndexState(image.id, 'function', 'complete');
        }).state,
        'committed',
      );
      const project_id = store.project_id;
      await store.close();
      const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
      const handler = createMcpHandler(() => createMcpServer(service));
      const client = new Client({ name: 'navigation-pages', version: '1.0.0' });
      t.after(async () => {
        await client.close();
        await handler.close();
        await service.close('cancel');
        await rm(root, { recursive: true, force: true });
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://navigation.test/mcp'), {
          fetch: (url, init) => handler.fetch(new Request(url, init)),
        }),
      );
      await client.callTool({
        name: 'project_open',
        arguments: { source: { kind: 'resume', project_path: projectPath } },
      });
      const ids: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const input = {
          project_id,
          revision: 2,
          image_id: image.id,
          page: { limit, ...(cursor ? { cursor } : {}) },
        };
        const response = await client.callTool({ name: 'functions_find', arguments: input });
        assert.notEqual(
          response.isError,
          true,
          'ordinary pages must not become unstructured wrapper errors',
        );
        assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MCP_MAX_RESULT_BYTES);
        const result = validateToolResponse(
          'functions_find',
          response.structuredContent,
          validateToolRequest('functions_find', input),
        );
        assert.deepEqual(
          result.budget,
          DEFAULT_BUDGET,
          'transport sizing must not rewrite the requested budget',
        );
        assert.ok('data' in result);
        assert.ok(result.data.items.length > 0);
        const text = response.content.find((item) => item.type === 'text');
        assert.ok(text?.type === 'text');
        assert.deepEqual(decodeNavigationText(text.text), result);
        ids.push(...result.data.items.map((fn) => fn.id));
        cursor = result.data.page.next_cursor ?? undefined;
        if (cursor) {
          assert.equal(result.state, 'partial');
          assert.ok(result.state === 'partial');
          assert.equal(result.reason, 'output_limit');
          assert.equal(result.continuation, cursor);
        }
        assert.ok(++pages <= functions.length);
      } while (cursor);
      assert.ok(
        pages > 1,
        'the valid requested page must shrink instead of failing at the wrapper',
      );
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(ids.toSorted(), functions.map((fn) => fn.id).toSorted());
    },
  );
