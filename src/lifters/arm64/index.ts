import type {
  AbiProfile,
  Address,
  DecodedInstruction,
  Diagnostic,
  FunctionGraph,
  Lifter,
  OperationContext,
  RegisterDescriptor,
} from '../../core/index.js';
import { OperationError } from '../../core/index.js';
import {
  IRBuilder,
  instructionProvenance,
  integer,
  mergeProvenanceSources,
  type BlockBuilder,
  type RegisterIR,
  type Value,
} from '../../ir/index.js';
import {
  ArmSemantics,
  Unsupported,
  boundedUnknownClobbers,
  fpEnvironmentGuard,
  gp,
  needsFpGuard,
  stateRegister,
  unknownClobbers,
} from './semantics.js';

export interface Arm64LiftResult {
  readonly ir: RegisterIR;
  readonly coverage: FunctionGraph['coverage'];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * ARM64 register-form lifter over discovery-owned FunctionGraph boundaries.
 * Public API: new Arm64Lifter().lift(graph, abi, context); no target execution or
 * sibling checkout imports. Calls carry physical ABI clobbers, not invented
 * signatures; architectural return values remain in registers.
 *
 * Supports baseline A64 add/sub/carry/logical/immediate/bitfield/extract,
 * multiply/long/high/divide, variable shifts, conditional select/compare,
 * count/reverse, PC-relative addresses, direct/indirect transfers, ordinary
 * scalar/SIMD literal/offset/pre/post-index and pair memory, stack and calls.
 * SIMD supports common fixed-lane integer arithmetic/bitwise/MOVI, scalar
 * FP32/64 moves/arithmetic/compare/select/conversion, FCVTZS/FCVTZU (saturating,
 * NaN to zero), fixed-point SCVTF/UCVTF, and vector FP add/sub/mul/div when
 * structured operands exist; DUP (general), CMEQ and AND/ORR (register) read
 * canonical fields. Runtime FPCR guards bound arithmetic
 * to nearest-even, gradual underflow and masked exceptions. Arithmetic NaNs
 * are explicitly canonicalized and FPSR is unknown, never claimed exact.
 *
 * Pointer authentication retains logical addresses with explicit diagnostics,
 * not hardware authentication/security semantics. The observed DMB ISH orders
 * reads/writes in the inner-shareable domain. Other barriers, SVE/SME, atomics,
 * privileged/system state, fused FP, FP16, other rounding conversions and
 * unimplemented SIMD remain unknown effect boundaries. Unsupported operations
 * clobber the entire modeled state and memory, never disappear or become
 * invented guaranteed traps. Decode gaps/unresolved exits remain boundaries.
 */
export class Arm64Lifter implements Lifter<RegisterIR> {
  readonly name = 'ARM64 typed semantic lifter';
  readonly version = '1.0.7';
  readonly architecture = 'arm64' as const;
  lift(graph: FunctionGraph, abi: AbiProfile, context: OperationContext): Arm64LiftResult {
    if (abi.architecture !== 'arm64') throw new TypeError('ARM64 lifter requires an ARM64 ABI');
    context.checkpoint(0);
    if (graph.instructions.length > context.budget.instructions)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Lift input exceeds the instruction budget',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'instructions',
          limit: context.budget.instructions,
          consumed: graph.instructions.length,
        },
      });
    if (graph.blocks.length > context.budget.blocks)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Lift input exceeds the block budget',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'blocks',
          limit: context.budget.blocks,
          consumed: graph.blocks.length,
        },
      });
    if (graph.blocks.length * 3 > context.budget.ir_nodes)
      throw new OperationError({
        code: 'resource_limit',
        severity: 'error',
        message: 'Lift input exceeds the minimum IR node budget',
        evidence_ids: [],
        details: {
          kind: 'limit',
          resource: 'ir_nodes',
          limit: context.budget.ir_nodes,
          consumed: graph.blocks.length * 3,
        },
      });
    context.checkpoint(graph.instructions.length + graph.blocks.length);
    let returnRegisters: readonly RegisterDescriptor[] | undefined;
    const instructions = new Map(
      graph.instructions.map((instruction) => [instruction.id, instruction]),
    );
    const provenance = graph.instructions.length
      ? mergeProvenanceSources(graph.instructions.map(instructionProvenance), (work) =>
          context.checkpoint(work),
        )
      : {
          instruction_ids: [],
          ranges: graph.function.ranges,
          evidence_ids: graph.function.evidence_ids,
          synthetic: ['Discovered function with no decoded instructions'],
        };
    const build = new IRBuilder(graph.slice_id, graph.function.id, provenance, 'register', context);
    const blocks = new Map<string, BlockBuilder>();
    const byAddress = new Map<bigint, BlockBuilder>();
    for (const block of graph.blocks) {
      const sources = block.instructions
        .map((id) => instructions.get(id))
        .filter((value): value is DecodedInstruction => value !== undefined);
      const result = build.block(
        ['discovered', block.id],
        [],
        sources.length
          ? mergeProvenanceSources(sources.map(instructionProvenance), (work) =>
              context.checkpoint(work),
            )
          : provenance,
      );
      blocks.set(block.id, result);
      if (sources[0]) byAddress.set(sources[0].address.value, result);
    }
    let entry = byAddress.get(graph.function.entry.value);
    const diagnostics: Diagnostic[] = [...graph.diagnostics];
    const reasons = new Set(graph.coverage.reasons);
    let completed = 0;
    // A proven table's index, read just before its selecting load executes.
    const tablesBySelector = new Map(
      (graph.jump_tables ?? []).map((table) => [table.selector.instruction, table]),
    );
    const tablesByBranch = new Map((graph.jump_tables ?? []).map((table) => [table.branch, table]));
    const selectors = new Map<string, { block: BlockBuilder; value: Value }>();
    const report = (instruction: DecodedInstruction, message: string): void => {
      reasons.add(message);
      diagnostics.push({
        code: 'unavailable_semantics',
        severity: 'warning',
        message,
        address: instruction.address,
        evidence_ids: [...instruction.evidence_ids],
      });
    };
    const unknown = (block: BlockBuilder, reason: string): void => {
      block.unknown(reason, unknownClobbers);
      reasons.add(reason);
    };
    for (const discovered of graph.blocks) {
      let block = blocks.get(discovered.id)!;
      let terminated = false;
      for (const id of discovered.instructions) {
        context.checkpoint(1);
        const instruction = instructions.get(id);
        if (!instruction) {
          unknown(block, 'Discovery references a missing instruction');
          block.terminate({ kind: 'unknown', reason: 'Missing discovered instruction' });
          terminated = true;
          break;
        }
        const source = instructionProvenance(instruction);
        block.source(source);
        const payload = instruction.payload;
        try {
          if (
            instruction.validity !== 'valid' ||
            payload?.architecture !== 'arm64' ||
            payload.behavior === 'unknown' ||
            payload.behavior === 'undefined'
          )
            throw new Unsupported('Instruction is invalid, unavailable or lacks ARM64 semantics');
          if (needsFpGuard(payload)) {
            const supported = build.block(['fp-supported', instruction.id], [], source);
            const unsupported = build.block(['fp-unsupported', instruction.id], [], source);
            const control = block.readRegister(stateRegister('fpcr'));
            const masked = block.int(
              'and',
              control,
              block.constant(integer(32), fpEnvironmentGuard.mask),
            );
            block.branch(
              block.compare('eq', masked, block.constant(integer(32), 0n)),
              block.edge(supported),
              block.edge(unsupported),
            );
            unsupported.unknown(fpEnvironmentGuard.unsupported_effect, unknownClobbers);
            unsupported.terminate({ kind: 'unknown', reason: fpEnvironmentGuard.unsupported_exit });
            block = supported;
          }
          const selecting = tablesBySelector.get(instruction.id);
          if (selecting) {
            const raw = block.readRegister(selecting.selector.register);
            selectors.set(selecting.branch, {
              block,
              value:
                selecting.selector.register.width_bits === 64
                  ? raw
                  : block.cast('zero_extend', integer(64), raw),
            });
          }
          const semantic = new ArmSemantics(block, instruction, payload, (message) =>
            report(instruction, message),
          );
          const name = semantic.name,
            flow = instruction.flow;
          const authenticated = /^(BRAA|BRAB|BLRAA|BLRAB|RETAA|RETAB)/.test(name);
          if (authenticated) semantic.authentication();
          if (
            flow.kind === 'call' &&
            ['BL', 'BLR', 'BLRAA', 'BLRAB', 'BLRAAZ', 'BLRABZ'].includes(name)
          ) {
            const target = flow.target
              ? { kind: 'direct' as const, address: flow.target }
              : { kind: 'indirect' as const, value: semantic.read('Rn', 64) };
            block.writeRegister(gp(30), block.address(flow.fallthrough));
            block.call(target, [], [], abi.unknown_call_clobbers);
          } else if (flow.kind === 'return' && (name === 'RET' || authenticated)) {
            if (name === 'RET' && semantic.field('Rn') !== 30)
              block.terminate({
                kind: 'indirect',
                target: semantic.read('Rn', 64),
                reason: 'Return through non-link register',
              });
            else {
              if (!returnRegisters) {
                const registers: RegisterDescriptor[] = [];
                for (const returns of [{ kind: 'pointer' }, { kind: 'float', bits: 64 }] as const)
                  for (const location of abi.classifyCall({
                    returns,
                    parameters: [],
                    variadic: false,
                    fixed_parameter_count: 0,
                  }).returns)
                    if (location.kind === 'register') registers.push(location.register);
                returnRegisters = registers;
              }
              // Capacity only: unchanged entry cells are not inferred results
              // unless an actual caller consumes that preserved return slice.
              for (const register of returnRegisters) block.readRegister(register);
              block.return();
            }
            terminated = true;
          } else if (flow.kind === 'indirect_branch' && (name === 'BR' || authenticated)) {
            const table = authenticated ? undefined : tablesByBranch.get(instruction.id);
            const selector = table ? selectors.get(table.branch) : undefined;
            const otherwise = table ? byAddress.get(table.otherwise.value) : undefined;
            const cases = table?.targets.map((target) => byAddress.get(target.value));
            if (
              table &&
              selector?.block === block &&
              otherwise &&
              cases?.every((target) => target !== undefined)
            )
              // Exactly the proven targets; the dominating guard makes `otherwise` unreachable.
              block.terminate({
                kind: 'switch',
                value: selector.value,
                cases: cases.map((target, index) => ({
                  bits: BigInt(index),
                  edge: block.edge(target!),
                })),
                otherwise: block.edge(otherwise),
                jump_table: {
                  load_instruction: table.selector.instruction,
                  ...(table.guard_exact ? { exact_guard_instruction: table.guard } : {}),
                },
              });
            else
              block.terminate({
                kind: 'indirect',
                target: semantic.read('Rn', 64),
                reason: authenticated
                  ? 'Authenticated logical-pointer transfer'
                  : 'Indirect branch target is unresolved',
              });
            terminated = true;
          } else if (flow.kind === 'branch' && ['B', 'CBZ', 'CBNZ', 'TBZ', 'TBNZ'].includes(name)) {
            const targetBlock = (address: Address): BlockBuilder => {
              const found = byAddress.get(address.value);
              if (found) return found;
              const exit = build.block(
                ['external-exit', instruction.id, address.value],
                [],
                source,
              );
              byAddress.set(address.value, exit);
              const tail = discovered.edges.some(
                (edge) => edge.kind === 'tail_call' && edge.target?.value === address.value,
              );
              if (tail) {
                // A tail may forward untouched argument cells that this body
                // never reads. Keep their physical entry/exit identities for
                // the bounded callee observer; do not invent source arguments.
                for (const register of abi.unknown_call_clobbers.registers)
                  exit.readRegister(register);
                exit.readRegister(abi.stack_pointer);
              }
              exit.terminate({
                kind: 'indirect',
                target: exit.address(address),
                ...(tail ? { tail_call: true as const } : {}),
                reason: tail ? 'Discovered tail-call exit' : 'Branch leaves discovered function',
              });
              return exit;
            };
            const target = targetBlock(flow.target);
            if (flow.conditional && flow.fallthrough)
              block.branch(
                semantic.transferCondition(),
                block.edge(target),
                block.edge(targetBlock(flow.fallthrough)),
              );
            else block.jump(target);
            terminated = true;
          } else if (flow.kind === 'trap' && ['BRK', 'HLT', 'UDF'].includes(name)) {
            block.terminate({ kind: 'trap', reason: flow.reason });
            terminated = true;
          } else if (!semantic.execute())
            throw new Unsupported(`Unsupported ARM64 encoding ${payload.canonical_encoding}`);
          completed++;
        } catch (error) {
          if (!(error instanceof Unsupported)) throw error;
          report(instruction, error.message);
          // A valid SIMD&FP data-processing instruction that falls through has
          // an ISA-bounded effect; anything else stays fully unknown.
          const bounded =
            instruction.validity === 'valid' &&
            instruction.flow.kind === 'fallthrough' &&
            payload?.architecture === 'arm64' &&
            payload.behavior === 'instruction'
              ? boundedUnknownClobbers(payload)
              : undefined;
          if (bounded) {
            block.unknown(error.message, bounded);
            reasons.add(error.message);
          } else unknown(block, error.message);
          if (instruction.flow.kind !== 'fallthrough' && instruction.flow.kind !== 'call') {
            block.terminate({ kind: 'unknown', reason: error.message });
            terminated = true;
          }
        }
        if (terminated) break;
      }
      if (!terminated) {
        const edges = discovered.edges.filter((edge) => edge.kind !== 'call');
        const successor =
          edges.length === 1 && edges[0]!.to !== null ? blocks.get(edges[0]!.to!) : undefined;
        if (successor) block.jump(successor);
        else if (
          edges.length === 1 &&
          edges[0]!.kind === 'trap' &&
          instructions.get(discovered.instructions.at(-1) ?? '')?.flow.kind === 'call'
        )
          // Discovery ends a block at a call to a proven noreturn callee.
          block.terminate({ kind: 'trap', reason: 'Call to a noreturn callee does not return' });
        else {
          unknown(block, 'Discovered block has an unresolved exit or decode gap');
          block.terminate({ kind: 'unknown', reason: 'Unresolved discovered continuation' });
        }
      }
    }
    if (!entry) {
      entry = build.block(['missing-entry'], [], provenance);
      unknown(entry, 'Function entry has no discovered block');
      entry.terminate({ kind: 'unknown', reason: 'Missing discovered entry' });
    }
    const ir = build.finish(entry);
    if (graph.gaps.length) reasons.add('Discovery contains undecoded byte gaps');
    return {
      ir,
      diagnostics,
      coverage: {
        layer: 'lift',
        state: reasons.size ? 'partial' : 'complete',
        completed_units: completed,
        total_units: graph.instructions.length,
        reasons: [...reasons],
      },
    };
  }
}
