#!/usr/bin/env node
// Public trusted C fixture -> actual SDK/MCP -> native consumer assertions.
// Never executes either analyzed library. Not a reconstructed-text parser.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolSchemas } from '../../src/core/index.ts';

const [armArg, x86Arg, outputArg] = process.argv.slice(2);
assert.ok(armArg && x86Arg && outputArg, 'usage: node --import tsx investigation-native-sdk-oracle.mjs ARM_LIBRARY X86_LIBRARY NEW_OUTPUT');
const output = resolve(outputArg);
await mkdir(output, { recursive: false });
const client = new Client({ name: 'native-investigation-consumer', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx',
  resolve('src/cli/entry.ts'), 'mcp', 'start', '--root', resolve(armArg, '..'), '--root', resolve(x86Arg, '..'), '--root', output], stderr: 'pipe' });
let stderr = '', checks = 0;
transport.stderr?.on('data', (chunk) => { stderr += chunk; });
const calls = [], observations = [];
const check = (condition, label) => { assert.ok(condition, label); checks++; };
async function call(name, args) {
  const wire = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  calls.push({ name, args, response: wire });
  await writeFile(join(output, 'calls.json'), JSON.stringify(calls, null, 2));
  return { result: wire.structuredContent ? toolSchemas[name].output.parse(wire.structuredContent) : wire,
    model: wire.structuredContent ? JSON.parse(wire.content.find((item) => item.type === 'text').text) : null };
}
const registers = (instruction) => instruction.payload.operands.filter((operand) => operand.kind === 'register').map((operand) => operand.register);
const immediate = (instruction, value) => instruction.payload.operands.some((operand) => operand.kind === 'immediate' &&
  BigInt(typeof operand.value === 'object' ? operand.value.magnitude : operand.value) === BigInt(value));
try {
  await client.connect(transport);
  for (const [architecture, binary] of [['arm64', armArg], ['x86_64', x86Arg]]) {
    const { result: opened } = await call('project_open', { source: { kind: 'import', input_path: resolve(binary),
      project_path: join(output, architecture) }, wait: true });
    check(opened.data?.image.target.architecture === architecture, 'actual imported target architecture');
    const scope = { project_id: opened.project_id, revision: opened.revision };
    const selected = {};
    for (const name of ['signed', 'caller', 'callback']) {
      const { result: found } = await call('functions_find', { ...scope, image_id: opened.data.image.id,
        query: { text: `${architecture === 'arm64' ? '_' : ''}investigation_${name}`, match: 'exact', case_sensitive: true } });
      check(found.data?.items.length === 1, 'source-known function selected exactly');
      const fn = found.data.items[0], args = { ...scope, function_id: fn.id };
      const { result: compact, model } = await call('function_get', { ...args, view: 'disassembly', detail: 'compact', page: { limit: 100 } });
      check(compact.data?.detail === 'compact' && !compact.data.page.next_cursor, 'bounded explicit native delivery');
      check(model.view === 'disassembly' && model.state === compact.state && model.instructions.length === compact.data.items.length,
        'actual native model consumer receives all selected instructions and state');
      check(compact.data.items.every((item) => item.architecture === architecture && item.address.image_id === opened.data.image.id &&
        item.id.startsWith('entity_') && item.size > 0), 'original instruction identity/address/architecture scope');
      check(Array.isArray(model.gaps) && Array.isArray(compact.data.gaps), 'actual decode gaps remain explicit');
      const { result: full } = await call('function_get', { ...args, view: 'disassembly', page: { limit: 100 } });
      check(full.data?.view === 'disassembly' && full.data.detail === undefined && full.data.items.every((item) => 'payload' in item),
        'default native descriptor consumer remains full');
      const originals = new Map(full.data.items.map((item) => [item.id, item]));
      selected[name] = { fn, compact, model, originals, args };
      const malformed = structuredClone(compact);
      malformed.data.items[0].presentation = null;
      check(!toolSchemas.function_get.output.safeParse(malformed).success, 'valid compact instruction cannot lose its canonical presentation');
      if (architecture === 'arm64') {
        const wrongSize = structuredClone(compact); wrongSize.data.items[0].size = 8;
        check(!toolSchemas.function_get.output.safeParse(wrongSize).success, 'compact ARM64 size invariant retained');
      }
    }
    function sourceInstruction(name, mnemonic, predicate = () => true) {
      const selection = selected[name];
      const matches = selection.compact.data.items.filter((item) => item.presentation?.mnemonic.toLowerCase() === mnemonic && predicate(selection.originals.get(item.id)));
      check(matches.length === 1, `source-known ${architecture} ${name} ${mnemonic} native operation`);
      const item = matches[0], original = selection.originals.get(item.id);
      const row = selection.model.instructions.find((candidate) => candidate[0] === `${item.address.space}:${item.address.value}`);
      check(row && row[1] === item.size && row[2].toLowerCase() === mnemonic, 'source-known operation reaches actual compact native client at original address');
      observations.push({ architecture, function: name, instruction_id: item.id, address: item.address,
        size: item.size, presentation: item.presentation, canonical_encoding: original.payload.canonical_encoding ?? original.payload.encoding,
        register_operands: registers(original).map(({ root, width_bits }) => ({ root, width_bits })) });
      return original;
    }
    if (architecture === 'arm64') {
      const divide = sourceInstruction('signed', 'sdiv');
      check(BigInt(divide.address.value) === 0x340n && divide.payload.fields.sf === '0x1' &&
        registers(divide).map((r) => r.root).join(',') === 'arm64:x0,arm64:x0,arm64:x1' && registers(divide).every((r) => r.width_bits === 64),
        'trusted C signed64 divide: actual SDIV64 fields and original address, not reconstructed IR128');
      const indirect = sourceInstruction('callback', 'blr');
      check(BigInt(indirect.address.value) === 0x358n && indirect.flow.kind === 'call' && indirect.flow.indirect &&
        registers(indirect)[0].root === 'arm64:x8' && registers(indirect)[0].width_bits === 64, 'native callback target is actual x8 carrier');
      for (const [address, destination, source] of [[0x350n, 'arm64:x8', 'arm64:x0'], [0x354n, 'arm64:x0', 'arm64:x1']]) {
        const native = selected.callback.compact.data.items.find((item) => BigInt(item.address.value) === address);
        check(native?.presentation.mnemonic.toLowerCase() === 'mov', 'source-known callback MOV reaches native client');
        const actual = selected.callback.originals.get(native.id);
        check(registers(actual).map((r) => r.root).join(',') === `${destination},${source}` && registers(actual).every((r) => r.width_bits === 64),
          'actual decoded MOV proves target/argument forwarding, not contributor intersection');
      }
      const addition = sourceInstruction('caller', 'add', (item) => immediate(item, 3));
      check(BigInt(addition.address.value) === 0x320n && registers(addition).every((r) => r.width_bits === 64) &&
        registers(addition).map((r) => r.root).join(',') === 'arm64:x0,arm64:x0', 'actual native primary call-result ADD64 by 3');
    } else {
      const divide = sourceInstruction('signed', 'idiv');
      check(registers(divide).length === 1 && registers(divide)[0].width_bits === 64, 'trusted C signed division uses actual x86 IDIV64 operand');
      const indirect = sourceInstruction('callback', 'call', (item) => item.flow.kind === 'call' && item.flow.indirect);
      check(registers(indirect).length === 1 && registers(indirect)[0].width_bits === 64, 'actual x86 indirect callback carrier is 64 bits');
      check(registers(indirect)[0].root === 'x86_64:rax', 'Windows x64 callback uses saved first input as target');
      for (const [destination, source] of [['x86_64:rax', 'x86_64:rcx'], ['x86_64:rcx', 'x86_64:rdx']]) {
        const moves = selected.callback.compact.data.items.filter((item) => item.presentation?.mnemonic.toLowerCase() === 'mov' &&
          registers(selected.callback.originals.get(item.id)).map((register) => register.root).join(',') === `${destination},${source}`);
        check(moves.length === 1 && registers(selected.callback.originals.get(moves[0].id)).every((register) => register.width_bits === 64),
          'actual Windows x64 MOV64 proves incoming callback target and argument forwarding');
      }
      const addition = sourceInstruction('caller', 'add', (item) => immediate(item, 3));
      check(registers(addition)[0].root === 'x86_64:rax' && registers(addition)[0].width_bits === 64, 'actual x86 primary result ADD64 by 3');
    }
    const callbackArgs = selected.callback.args;
    const { result: published } = await call('function_decompile', { ...callbackArgs, wait: true, delivery: 'artifact' });
    const { result: facts } = await call('function_get', { ...callbackArgs, view: 'investigation', artifact_id: published.artifacts[0].id,
      kinds: ['call', 'unresolved'], include_quotes: false, page: { limit: 100 } });
    check(facts.data.items.every((item) => item.kind === 'requirement' || (item.kind === 'inference' && item.record.details.kind === 'call')),
      'requesting calls/unknowns adds no parameters/signature/source');
    check(facts.data.analysis_diagnostics.length === published.diagnostics.length && facts.data.analysis_diagnostics.every((diagnostic, index) =>
      diagnostic.artifact_index === index && diagnostic.code === published.diagnostics[index].code && diagnostic.severity === published.diagnostics[index].severity &&
      diagnostic.evidence_count === published.diagnostics[index].evidence_ids.length), 'every original semantic diagnostic remains locatable with code/severity/proof count');
    const { result: limited, model: limitedModel } = await call('function_get', { ...selected.signed.args, view: 'disassembly', detail: 'compact', budget: { instructions: 1 } });
    check(limited.state === 'partial' && limited.data.items.length === 1 && limited.coverage.some((item) => item.state === 'partial'),
      'actual explicit decode ceiling remains visibly partial');
    check(limited.data.gaps.every((gap) => BigInt(gap.range.size) > 0n && gap.range.start.image_id === opened.data.image.id) &&
      limitedModel.gaps.length === limited.data.gaps.length, 'actual bounded native gaps preserve positive original scope');
    observations.push({ architecture, bounded_state: limited.state, gaps: limited.data.gaps, coverage: limited.coverage });
    await call('project_close', { project_id: opened.project_id });
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ checks, target_executed: false, repository_suite_run: false,
    source: 'scripts/bench/investigation-corpus.c', observations }, null, 2));
  console.log(JSON.stringify({ checks, architectures: ['arm64', 'x86_64'], native_consumer_boundary: 'passed', target_executed: false }));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ checks, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally {
  await client.close();
  await writeFile(join(output, 'stderr.txt'), stderr);
}
