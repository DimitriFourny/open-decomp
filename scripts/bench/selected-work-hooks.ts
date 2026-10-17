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
const passNames: Record<string, readonly string[]> = {
  reconstruction: ['reconstruct'],
  source_plan: ['planSource'],
  source_stack: ['planSourceStack'],
  validation: ['validateReconstruction', 'validateRenderedTransfers'],
  register_ssa: ['constructSSA'],
  simplify_ssa: ['simplifySSA', 'analyzeValues'],
  native_prepare: ['prepareNativeUnit'],
  prepared_calls: ['observePreparedCallInterfaces'],
  result_demands: ['observeCallResultDemands', 'createCallResultDemandIndex'],
  argument_preparation: ['preparedCallArguments'],
  register_types: ['registerTypeSlices', 'registerTypes'],
  stack_recovery: ['recoverStack'],
  ir_verification: ['verifyIR'],
};
declare global {
  // eslint-disable-next-line no-var
  var __openDecompSelectedWorkObservation: Observation | undefined;
}
const probe = (event: string, value = 'undefined'): string =>
  `globalThis.${key}?.(${JSON.stringify(event)}, ${value});`;

export function observeSelectedWork(observation: Observation): () => void {
  const hadPrevious = Object.hasOwn(globalThis, key);
  const previous = globalThis.__openDecompSelectedWorkObservation;
  globalThis.__openDecompSelectedWorkObservation = observation;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const kind = url.endsWith('/src/analysis/discovery/index.ts')
        ? 'discovery'
        : url.endsWith('/src/service/queries/graphs.ts')
          ? 'selected_graph'
          : url.endsWith('/src/service/analysis/source-facts.ts')
            ? 'native_summaries'
            : url.endsWith('/src/service/analysis/native-prepare.ts') ? 'native_prepare'
            : url.endsWith('/src/service/analysis/index.ts') ? 'pipeline'
              : url.endsWith('/src/reconstruction/index.ts') ? 'reconstruction'
                : url.endsWith('/src/reconstruction/source-planner.ts') ? 'source_plan'
                  : url.endsWith('/src/reconstruction/source-stack.ts') ? 'source_stack'
                    : url.endsWith('/src/reconstruction/validate.ts') ? 'validation'
                      : url.endsWith('/src/emitters/renderer.ts') ? 'renderer'
                        : url.endsWith('/src/analysis/ssa/index.ts') ? 'register_ssa'
                          : url.endsWith('/src/analysis/values/index.ts') ? 'simplify_ssa'
                            : url.endsWith('/src/analysis/calls/observed.ts') ? 'prepared_calls'
                              : url.endsWith('/src/analysis/calls/result-demands.ts') ? 'result_demands'
                                : url.endsWith('/src/analysis/calls/argument-preparation.ts') ? 'argument_preparation'
                                  : url.endsWith('/src/reconstruction/source-register-types.ts') ? 'register_types'
                                    : url.endsWith('/src/analysis/stack/index.ts') ? 'stack_recovery'
                                      : url.endsWith('/src/ir/verify.ts') ? 'ir_verification' : null;
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
        replace('const cached = cache.get(key);',
          `const cached = cache.get(key); ${probe('selected_graph_cache', '{ hit: cached !== undefined }')}`);
        replace('    return cached.graph;', `    ${probe('selected_result', 'cached.graph')} return cached.graph;`);
        replace('  return graph;', `  ${probe('selected_result', 'graph')} return graph;`);
      } else if (kind === 'pipeline') {
        replace('const emitted = emit(', `${probe('pipeline_emit_begin', '{}')} const emitted = emit(`);
        replace('const decodeReasons = new Set<string>()', `${probe('pipeline_emit_end', '{}')} const decodeReasons = new Set<string>()`);
        replace('const evidence = closeEvidence(', `${probe('pipeline_evidence_begin', '{}')} const evidence = closeEvidence(`);
        replace('const metadata: ResultMetadata = {', `${probe('pipeline_evidence_end', '{}')} const metadata: ResultMetadata = {`);
        replace('toolSchemas.function_decompile.output.parse(result);',
          `${probe('pipeline_validation_begin', '{}')} toolSchemas.function_decompile.output.parse(result); ${probe('pipeline_validation_end', '{}')}`);
      } else if (kind === 'renderer') {
        replace('this.program = reconstruct(input, context);',
          `${probe('renderer_reconstruct_begin', '{}')} this.program = reconstruct(input, context); ${probe('renderer_reconstruct_end', '{ values: this.program.values.size, live: this.program.live.size, retained: this.program.retained.size, parameters: this.program.parameters.length, unknown_effects: [...this.program.blocks.values()].reduce((n, block) => n + block.statements.filter(node => node.kind === "unknown_effect").length, 0) }')}`);
        replace('validateReconstruction(this.program, context);',
          `${probe('renderer_validation_begin', '{}')} validateReconstruction(this.program, context);`);
        replace('validateRenderedTransfers(input.function, this.gotos, language, context);',
          `validateRenderedTransfers(input.function, this.gotos, language, context); ${probe('renderer_validation_end', '{}')}`);
        replace('const subjects = references.ids;',
          `const subjects = references.ids; ${probe('mapping_shape', '{ key: JSON.stringify([origin.id, ...ids]), subjects_key: JSON.stringify(subjects), subjects: subjects.length, unique_subjects: new Set(subjects).size, inputs: 1 + ids.length + subjects.length, unique_inputs: new Set([origin.id, ...ids, ...subjects]).size }')}`);
      } else if (kind === 'register_ssa') {
        replace('(cellsByRoot.get(descriptor.root) ?? []).filter((cell) => {',
          `(cellsByRoot.get(descriptor.root) ?? []).filter((cell) => { ${probe('ssa_root_scan')}`);
        replace('for (const cell of cellsByRoot.get(descriptor.root) ?? []) {',
          `for (const cell of cellsByRoot.get(descriptor.root) ?? []) { ${probe('ssa_root_write_visit')}`);
        replace('for (const cell of cells) {', `for (const cell of cells) { ${probe('ssa_cell_iteration')}`);
        replace('const identity = (...birth: readonly (string | number)[]): EntityId =>',
          `${probe('ssa_root_inventory', '{ function: input.id, roots: [...cellsByRoot].map(([root, row]) => ({ root, cells: row.length })), actual_read_write_roots: [...new Set(input.blocks.flatMap(block => block.instructions.filter(node => node.kind === "read_register" || node.kind === "write_register").map(node => node.register.root)))] }')} const identity = (...birth: readonly (string | number)[]): EntityId =>`);
        replace('const state = new Map(entry.map((binding) => [key(binding.register), binding.value]));',
          'const state = new Map(entry.map((binding) => [key(binding.register), binding.value])); let __stateVersion = 0, __snapshotVersion = 0;');
        replace('state.set(', '(__stateVersion++, state).set(', 3);
        replace('const snapshot = (): RegisterBinding[] =>\n      cells.map((cell) => {',
          `const snapshot = (): RegisterBinding[] => { ${probe('ssa_snapshot', '{ cells: cells.length, reusable: __snapshotVersion === __stateVersion }')} __snapshotVersion = __stateVersion; return cells.map((cell) => {`);
        replace('return { register: cell, value: state.get(key(cell))! };\n      });',
          'return { register: cell, value: state.get(key(cell))! };\n      }); };');
      } else if (kind === 'ir_verification') {
        replace('const local = new Map<string, IRType>();',
          `const local = new Map<string, IRType>();
          const __referenceArrays = new WeakSet<object>();
          const __frozenData = (value: unknown, seen = new WeakSet<object>()): boolean => {
            if (typeof value === 'function') return false;
            if (value === null || typeof value !== 'object') return true;
            if (seen.has(value)) return true;
            if (!Object.isFrozen(value)) return false;
            const prototype = Object.getPrototypeOf(value);
            if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) return false;
            seen.add(value);
            return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
              'value' in descriptor && __frozenData(descriptor.value, seen));
          };
          const __referenceArray = (array: readonly RegisterBinding[]): void => {
            ${probe('binding_reference_array', '{ cells: array.length, repeated: __referenceArrays.has(array), eligible: __frozenData(array) }')}
            __referenceArrays.add(array);
          };`);
        replace('for (const binding of state.entry) {',
          '__referenceArray(state.entry); for (const binding of state.entry) {');
        replace('for (const binding of instruction.register_inputs) reference(binding.value, instruction.id);',
          '__referenceArray(instruction.register_inputs); for (const binding of instruction.register_inputs) reference(binding.value, instruction.id);');
        replace('for (const binding of state.exit) reference(binding.value, block.id);',
          '__referenceArray(state.exit); for (const binding of state.exit) reference(binding.value, block.id);');
      } else if (kind === 'simplify_ssa') {
        replace('edge.arguments.forEach((argument, index) => {',
          `edge.arguments.forEach((argument, index) => { ${probe('phi_edge_slot')} if (facts.get(blocks.get(edge.target)!.parameters[index]!.id)?.kind === 'varying') { ${probe('phi_edge_saturated')} }`);
        replace('for (const { edge, index } of phiUsers.get(id) ?? []) {',
          `for (const { edge, index } of phiUsers.get(id) ?? []) { ${probe('phi_notification')} if (facts.get(blocks.get(edge.target)!.parameters[index]!.id)?.kind === 'varying') { ${probe('phi_notification_saturated')} }`);
      } else if (kind === 'native_prepare') {
        replace('const graph = loadFunctionGraph({ ...scope, context }, revision, { image, function: fn });',
          `${probe('native_target', '{ function: fn, budget: context.budget }')} const graph = loadFunctionGraph({ ...scope, context }, revision, { image, function: fn });`);
        replace('const evidence: readonly Evidence[] = graph.evidence ?? [];',
          `${probe('native_graph', '{ function: fn, instructions: graph.instructions.length, blocks: graph.blocks.length, edges: graph.blocks.reduce((n, b) => n + b.edges.length, 0), coverage: graph.coverage }')} const evidence: readonly Evidence[] = graph.evidence ?? [];`);
      } else if (kind === 'register_types') {
        replace('return slices;', `${probe('register_type_result', '{ values: values.size, typed_values: slices.size }')} return slices;`, 2);
      } else if (kind === 'stack_recovery') {
        replace('const transfer = (id: EntityId, record: boolean): State => {',
          `const transfer = (id: EntityId, record: boolean): State => { ${probe('stack_transfer_visit', '{ block: id, record }')}`);
        replace("if (node.kind === 'assign') {",
          `${probe('stack_node_visit', '{ record }')} if (node.kind === 'assign') {`);
        replace('for (const edge of pendingBlocks.edges(id)) {',
          `for (const edge of pendingBlocks.edges(id)) { ${probe('stack_successor_edge')}`);
        replace('const barrier = (state: State): void => {',
          `const barrier = (state: State): void => { ${probe('stack_barrier_scan', '{ bytes: state.memory.size, reusable: barrierInvariant.has(state.memory) }')}`);
        replace('for (const [offset, byte] of state.memory) {',
          `for (const [offset, byte] of state.memory) { ${probe('stack_barrier_byte')}`);
        replace('for (const byte of state.memory.values()) {',
          `${probe('stack_escape_scan', '{ bytes: state.memory.size, reusable: state.escaped }')} for (const byte of state.memory.values()) { ${probe('stack_escape_byte')}`);
      }
      const observed = kind === 'discovery'
        ? [
            { name: 'discoverFunctions', phase: 'discovery', details: '{ budget: context.budget }' },
            { name: 'prepareDiscoveryIndex', phase: 'index_preparation', details: '{ revision: input.revision }' },
          ]
        : kind === 'pipeline' || kind === 'renderer' ? []
          : passNames[kind] ? passNames[kind].map((name) => ({ name, phase: name,
            details: kind === 'result_demands' && name === 'observeCallResultDemands'
              ? '{ function: ir.id, roots: additionalRoots.length }'
              : kind === 'result_demands' || name === 'verifyIR' ? '{ function: ir.id }'
              : name === 'recoverStack' || name === 'analyzeValues'
                ? '{ function: input.id, blocks: input.blocks.length }'
                : name === 'registerTypeSlices'
                  ? '{ values: values.size, non_integer: [...values.values()].filter(value => value.type.kind !== "integer").length }' : '{}' }))
          : [{ name: kind === 'selected_graph' ? 'reconstructFunctionGraph' : 'recoverSourceEvidence',
            phase: kind, details: kind === 'selected_graph' ? '{ function: input.function, budget: context.budget }' : '{}' }];
      for (const { name, phase, details } of observed) {
        const parsed = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
        const fn = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name);
        assert.ok(fn?.body, `Missing observed function ${name}`);
        const start = fn.body.getStart(parsed) + 1, end = fn.body.end - 1;
        source = source.slice(0, start) + probe(`${phase}_enter`, details) + 'try {' +
          source.slice(start, end) + `} finally { ${probe(`${phase}_exit`)} }` + source.slice(end);
      }
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    },
  });
  return () => {
    hooks.deregister();
    if (hadPrevious) globalThis.__openDecompSelectedWorkObservation = previous;
    else Reflect.deleteProperty(globalThis, key);
  };
}
