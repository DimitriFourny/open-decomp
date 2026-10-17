import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Trusted developer-only observations; no production module or budget is changed.
 * Exact anchors fail closed when the observed implementation changes. Counters are
 * instruction/edge visits, not timings or semantic-equivalence measurements. */
export type Observation = (event: string, value?: unknown) => void;
const key = '__openDecompSelectedWorkObservation';
declare global {
  // eslint-disable-next-line no-var
  var __openDecompSelectedWorkObservation: Observation | undefined;
}
const probe = (event: string, value = 'undefined'): string =>
  `globalThis.${key}?.(${JSON.stringify(event)}, ${value});`;

export function observeSelectedWork(observation: Observation): () => void {
  globalThis.__openDecompSelectedWorkObservation = observation;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const kind = url.endsWith('/src/analysis/discovery/index.ts')
        ? 'discovery'
        : url.endsWith('/src/service/queries/graphs.ts')
          ? 'selected_graph'
          : url.endsWith('/src/service/analysis/source-facts.ts')
            ? 'native_summaries'
            : null;
      if (!kind) return nextLoad(url, context);
      let source = readFileSync(fileURLToPath(url), 'utf8');
      function replace(anchor: string, replacement: string, expected = 1): void {
        assert.equal(source.split(anchor).length - 1, expected, `Observation anchor changed: ${anchor}`);
        source = source.replaceAll(anchor, replacement);
      }
      if (kind === 'discovery') {
        replace('const result = decoder.decode(', `${probe('decode_attempt')} const result = decoder.decode(`);
        replace('decoded.set(address.value, instruction);', `${probe('decoded_instruction')} decoded.set(address.value, instruction);`);
        replace('for (const successor of instructionSuccessors(instruction)) enqueue(successor);',
          `for (const successor of instructionSuccessors(instruction)) { ${probe('image_successor_edge')} enqueue(successor); }`);
        replace('if (visited.has(address.value)) continue;', `${probe('ownership_queue_visit')} if (visited.has(address.value)) continue;`);
        replace('members.push(instruction);', `${probe('ownership_instruction_visit')} members.push(instruction);`);
        replace('for (const successor of instructionSuccessors(instruction)) {',
          `for (const successor of instructionSuccessors(instruction)) { ${probe('ownership_successor_edge')}`, 2);
        // The first loop is image traversal, not ownership traversal.
        replace(`${probe('ownership_successor_edge')} ${probe('image_successor_edge')}`, probe('image_successor_edge'));
        replace("context.progress('discovery', finalGraphs.length, finalGraphs.length);",
          `${probe('discovery_result', '{ graphs: finalGraphs, decoded: decoded.size, overlaps, boundary_claims: boundaryClaims, coverage_reasons: reasons }')} context.progress('discovery', finalGraphs.length, finalGraphs.length);`);
      } else if (kind === 'selected_graph') {
        replace('const source = graphs.find((graph) => graph.function.id === fn.id);',
          `${probe('image_graph_cache', '{ graphs: graphs.length, units: graphs.reduce((n, g) => n + g.instructions.length + g.gaps.length + g.blocks.length, 0) }')} const source = graphs.find((graph) => graph.function.id === fn.id);`);
        replace('  return {\n    ...source,', `${probe('selected_result', '{ function: fn, instructions, blocks, gaps }')}\n  return {\n    ...source,`);
      } else {
        replace('for (const { fn, call_ids } of targets.values()) {',
          `for (const { fn, call_ids } of targets.values()) { ${probe('native_target', '{ function: fn, call_ids, remainingInstructions, remainingBlocks, remainingNodes }')}`);
        replace('remainingInstructions -= graph.instructions.length;',
          `${probe('native_graph', '{ function: fn, instructions: graph.instructions.length, blocks: graph.blocks.length, edges: graph.blocks.reduce((n, b) => n + b.edges.length, 0), coverage: graph.coverage }')} remainingInstructions -= graph.instructions.length;`);
      }
      const name = kind === 'discovery' ? 'discoverFunctions' : kind === 'selected_graph' ? 'reconstructFunctionGraph' : 'recoverSourceEvidence';
      const parsed = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
      const fn = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name);
      assert.ok(fn?.body, `Missing observed function ${name}`);
      const start = fn.body.getStart(parsed) + 1, end = fn.body.end - 1;
      const details = kind === 'selected_graph'
        ? '{ function: input.function, budget: context.budget }'
        : kind === 'discovery' ? '{ budget: context.budget }' : '{}';
      source = source.slice(0, start) + probe(`${kind}_enter`, details) + 'try {' +
        source.slice(start, end) + `} finally { ${probe(`${kind}_exit`)} }` + source.slice(end);
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    },
  });
  return () => { hooks.deregister(); delete globalThis.__openDecompSelectedWorkObservation; };
}
