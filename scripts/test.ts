#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { glob } from 'node:fs/promises';

/**
 * Integration tests spawn clang, python3, the source CLI, MCP servers or real child
 * processes, extract evidence tarballs, or wait on long real timers. Everything else is a
 * unit test; a new `*.test.ts` file is a unit test unless it is listed here.
 */
const INTEGRATION = [
  'test/cli/commands.test.ts',
  'test/cli/export.test.ts',
  'test/cli/settings.test.ts',
  'test/cli/slices.test.ts',
  'test/cli/source-quality.test.ts',
  'test/mcp/executable.test.ts',
  'test/mcp/stdio.test.ts',
  'test/reconstruction/float-source.test.ts',
  'test/reconstruction/fp-vector-source.test.ts',
  'test/reconstruction/image-types-source.test.ts',
  'test/reconstruction/integer-conversion-source.test.ts',
  'test/reconstruction/memory-shapes-source.test.ts',
  'test/reconstruction/source-names-executable.test.ts',
  'test/reconstruction/source-names.test.ts',
  'test/reconstruction/sqlite-interfaces.test.ts',
  'test/service/analysis/native-summary.test.ts',
  'test/workers/protocol.test.ts',
];

const [suite, ...passthrough] = process.argv.slice(2);
if (suite !== 'unit' && suite !== 'integration' && suite !== 'all') {
  console.error('Usage: scripts/test.ts unit|integration|all [node --test flags...]');
  process.exit(2);
}

const all: string[] = [];
for await (const file of glob('test/**/*.test.ts')) all.push(file);
all.sort();
const integration = new Set(INTEGRATION);
const stale = INTEGRATION.filter((file) => !all.includes(file));
if (stale.length > 0) {
  console.error(`Integration list names missing test files: ${stale.join(', ')}`);
  process.exit(2);
}
const files =
  suite === 'all' ? all : all.filter((file) => (suite === 'integration') === integration.has(file));

console.error(`test:${suite}: ${files.length} files`);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...passthrough, ...files],
  { stdio: 'inherit' },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
