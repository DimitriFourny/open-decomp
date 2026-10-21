import type {
  AbiProfile,
  DecodedInstruction,
  Diagnostic,
  FunctionGraph,
  Lifter,
  OperationContext,
} from '../../core/index.js';
import { OperationError } from '../../core/index.js';
import {
  IRBuilder,
  instructionProvenance,
  integer,
  mergeProvenanceSources,
  syntheticProvenance,
} from '../../ir/index.js';
import type { BlockBuilder, RegisterIR, Value } from '../../ir/index.js';
import { Unsupported, X86Semantics, gpr, unknownClobbers } from './semantics.js';

export interface X86LiftResult {
  readonly ir: RegisterIR;
  readonly coverage: FunctionGraph['coverage'];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Stable API: new X86Lifter().lift(discoveredGraph, abi, operationContext).
 *
 * Supports legacy long-mode corpus integer AL/AH/AX/EAX/RAX slices, MOV/LEA,
 * sign/zero extension, arithmetic and six arithmetic flags, ADC/SBB, MUL/IMUL,
 * DIV/IDIV with explicit #DE paths, count-masked shifts/rotates, conditions,
 * branches/loops, stack, calls, SSE scalar/packed FP and common packed integer
 * moves/add/sub/bitwise operations, legacy SSE PUNPCKLBW and BTS (the memory
 * form with a register bit offset addresses the signed bit string; not under a
 * 32-bit address size). Addresses use decoded RIP targets or explicit
 * address-size wrapping, scale and segment bases (FS/GS base is physical state).
 * Decoder access/flags metadata never defines these instruction semantics.
 *
 * Calls have no fabricated formal signature: arguments/results remain empty and
 * ABI clobbers are explicit. CALL writes the hardware return-address slot and
 * exposes callee-entry RSP to a trusted offline call oracle; returning calls
 * restore caller RSP. RET reads/pops the return slot but its target is represented
 * by the IR return, not a guessed intra-function edge. Tail calls do not push.
 *
 * FP requires MXCSR nearest-even, gradual underflow, DAZ off and all exceptions
 * masked. Other environments terminate at an explicit unknown boundary. Result
 * NaNs are canonical (payload selection is abstracted), and MXCSR exception status
 * is explicitly unknown after FP. No claim of exact FP environment emulation.
 * Legacy scalar writes preserve upper lanes except memory MOVSS/MOVSD and
 * MOVD/MOVQ, which clear bits through 127; bits above XMM remain preserved.
 *
 * Unsupported: x87/MMX, string/REP operations, atomic LOCK/memory XCHG, RCL/RCR,
 * SHLD/SHRD, BT/BTC/BTR, bit scan, BMI/ADX, other unpack/saturating/shuffle/
 * conversion SIMD, AVX and later encodings, crypto, system/privileged/transactional instructions, CET
 * enforcement and precise memory-fault/exception delivery. ENDBR64 is a landing
 * marker abstraction, not CET enforcement. Unknown instructions emit an unknown
 * effect (whole modeled state and memory) and lifting continues with the next
 * instruction when its flow is sequential or a returning call, like ARM64; other
 * flows terminate. Instructions never silently disappear or become invented traps.
 * Explicit UD2/INT3/INT terminate as traps; malformed/reserved encodings remain
 * unknown. Memory alignment is carried by typed loads/stores. This module never
 * executes target code; interpreter use belongs exclusively to trusted tests.
 */
export class X86Lifter implements Lifter<RegisterIR> {
  readonly name = 'x86-64 typed semantic lifter';
  readonly version = '5';
  readonly architecture = 'x86_64';
  lift(graph: FunctionGraph, abi: AbiProfile, context: OperationContext): X86LiftResult {
    if (abi.architecture !== this.architecture)
      throw new TypeError('x86 lifter requires an x86 ABI');
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
    const origins = graph.instructions.map(instructionProvenance);
    const provenance = origins.length
      ? mergeProvenanceSources(origins, (work) => context.checkpoint(work))
      : syntheticProvenance('Discovered x86 function has no decoded instructions');
    const builder = new IRBuilder(
      graph.slice_id,
      graph.function.id,
      provenance,
      'register',
      context,
    );
    const decoded = new Map(graph.instructions.map((instruction) => [instruction.id, instruction]));
    const blocks = new Map(
      graph.blocks.map((block) => [
        block.id,
        builder.block(
          ['discovered', block.id],
          [],
          mergeProvenanceSources(
            block.instructions.map((id) =>
              decoded.has(id) ? instructionProvenance(decoded.get(id)!) : provenance,
            ),
            (work) => context.checkpoint(work),
          ),
        ),
      ]),
    );
    const byAddress = new Map<bigint, BlockBuilder>();
    for (const block of graph.blocks) {
      const first = decoded.get(block.instructions[0] ?? '');
      if (first) byAddress.set(first.address.value, blocks.get(block.id)!);
    }
    const diagnostics: Diagnostic[] = [...graph.diagnostics];
    const reasons = new Set<string>(graph.coverage.reasons);
    let completed = 0;
    // A proven table's index, read just before its selecting load executes.
    const tablesBySelector = new Map(
      (graph.jump_tables ?? []).map((table) => [table.selector.instruction, table]),
    );
    const tablesByBranch = new Map((graph.jump_tables ?? []).map((table) => [table.branch, table]));
    const selectors = new Map<string, { block: BlockBuilder; value: Value }>();
    const fpSeen = new Set<string>();
    const unknownEffect = (
      block: BlockBuilder,
      reason: string,
      instruction?: DecodedInstruction,
    ): void => {
      block.unknown(reason, unknownClobbers);
      reasons.add(reason);
      diagnostics.push({
        code: 'unavailable_semantics',
        severity: 'warning',
        message: reason,
        evidence_ids: instruction?.evidence_ids ? [...instruction.evidence_ids] : [],
      });
    };
    const boundary = (
      block: BlockBuilder,
      reason: string,
      instruction?: DecodedInstruction,
    ): void => {
      unknownEffect(block, reason, instruction);
      block.terminate({ kind: 'unknown', reason });
    };
    for (const source of graph.blocks) {
      let block = blocks.get(source.id)!;
      let terminated = false;
      for (const id of source.instructions) {
        context.checkpoint(1);
        const instruction = decoded.get(id);
        if (!instruction) {
          boundary(block, 'Discovered block references a missing instruction');
          terminated = true;
          break;
        }
        block.source(instructionProvenance(instruction));
        if (instruction.payload?.architecture !== 'x86_64' || instruction.validity !== 'valid') {
          boundary(
            block,
            `Unavailable x86 encoding at 0x${instruction.address.value.toString(16)}`,
            instruction,
          );
          terminated = true;
          break;
        }
        const semantics = new X86Semantics(builder, block, instruction, abi, () => {
          const reason = 'FP uses canonical arithmetic NaNs and abstracted MXCSR exception status';
          reasons.add(reason);
          if (!fpSeen.has(instruction.id)) {
            fpSeen.add(instruction.id);
            diagnostics.push({
              code: 'unavailable_semantics',
              severity: 'warning',
              message: reason,
              evidence_ids: [...instruction.evidence_ids],
            });
          }
        });
        try {
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
          const table = tablesByBranch.get(instruction.id);
          const selector = table ? selectors.get(table.branch) : undefined;
          if (table && selector?.block === block) {
            const otherwise = byAddress.get(table.otherwise.value);
            const cases = table.targets.map((target) => byAddress.get(target.value));
            if (otherwise && cases.every((target) => target !== undefined)) {
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
              completed++;
              terminated = true;
              break;
            }
          }
          semantics.execute();
          block = semantics.block;
          const flow = instruction.flow,
            mnemonic = instruction.payload.mnemonic;
          const targetBlock = (value: bigint): BlockBuilder => {
            const target = byAddress.get(value);
            if (target) return target;
            const exit = builder.block(
              [instruction.id, 'external-exit', value],
              [],
              instructionProvenance(instruction),
            );
            exit.terminate({
              kind: 'indirect',
              target: exit.address({ ...instruction.address, value }),
              reason: 'Transfer outside discovered function',
            });
            return exit;
          };
          if (flow.kind === 'return') {
            block.return();
            terminated = true;
          } else if (flow.kind === 'branch') {
            if (!flow.conditional) {
              const tail = source.edges.some(
                (edge) => edge.kind === 'tail_call' && edge.target?.value === flow.target.value,
              );
              if (tail) {
                semantics.call(true);
                block.return();
              } else block.jump(targetBlock(flow.target.value));
            } else {
              let condition;
              if (mnemonic === 'jrcxz' || mnemonic === 'jecxz' || mnemonic === 'jcxz') {
                const width = mnemonic === 'jrcxz' ? 64 : mnemonic === 'jecxz' ? 32 : 16;
                condition = block.compare(
                  'eq',
                  block.readRegister(gpr('rcx', width)),
                  block.constant(integer(width), 0n),
                );
              } else if (mnemonic === 'loop' || mnemonic === 'loope' || mnemonic === 'loopne') {
                const width = instruction.payload.address_bits,
                  register = gpr('rcx', width);
                const value = block.int(
                  'sub',
                  block.readRegister(register),
                  block.constant(integer(width), 1n),
                );
                block.writeRegister(register, value);
                condition = block.compare('ne', value, block.constant(integer(width), 0n));
                if (mnemonic !== 'loop')
                  condition = block.int(
                    'and',
                    condition,
                    semantics.condition(mnemonic === 'loope' ? 'e' : 'ne'),
                  );
              } else condition = semantics.condition(mnemonic.slice(1));
              if (!flow.fallthrough) throw new Unsupported('Conditional branch lacks fallthrough');
              block.branch(
                condition,
                block.edge(targetBlock(flow.target.value)),
                block.edge(targetBlock(flow.fallthrough.value)),
              );
            }
            terminated = true;
          } else if (flow.kind === 'indirect_branch') {
            const operand = instruction.payload.operands[0];
            if (mnemonic !== 'jmp' || !operand)
              throw new Unsupported('Unsupported indirect control transfer');
            block.terminate({
              kind: 'indirect',
              target: semantics.read(operand, 64),
              reason: 'Indirect x86 branch',
            });
            terminated = true;
          } else if (flow.kind === 'trap') {
            if (!['ud2', 'int3', 'int'].includes(mnemonic) || flow.conditional)
              throw new Unsupported('Unmodeled trap condition');
            block.terminate({ kind: 'trap', reason: flow.reason });
            terminated = true;
          } else if (flow.kind === 'unknown') throw new Unsupported(flow.reason);
          completed++;
        } catch (error) {
          if (!(error instanceof Unsupported)) throw error;
          block = semantics.block;
          // The whole modeled state and memory are unknown after the instruction. Only
          // instructions whose flow is plain sequential execution (or a call that returns
          // here) continue; any other transfer has no modeled successor.
          if (instruction.flow.kind === 'fallthrough' || instruction.flow.kind === 'call')
            unknownEffect(block, error.message, instruction);
          else {
            boundary(block, error.message, instruction);
            terminated = true;
          }
        }
        if (terminated) break;
      }
      if (!terminated) {
        const edges = source.edges.filter(
          (edge) => edge.kind === 'fallthrough' && edge.to !== null,
        );
        const target = edges.length === 1 ? blocks.get(edges[0]!.to!) : undefined;
        if (target) block.jump(target);
        else if (
          source.edges.length === 1 &&
          source.edges[0]!.kind === 'trap' &&
          decoded.get(source.instructions.at(-1) ?? '')?.flow.kind === 'call'
        )
          // Discovery ends a block at a call to a proven noreturn callee.
          block.terminate({ kind: 'trap', reason: 'Call to a noreturn callee does not return' });
        else boundary(block, 'Missing or ambiguous discovered fallthrough');
      }
    }
    let entry = byAddress.get(graph.function.entry.value);
    if (!entry) {
      entry = builder.block(['missing-entry']);
      boundary(entry, 'Function entry is not a discovered instruction');
    }
    return {
      ir: builder.finish(entry),
      diagnostics,
      coverage: {
        layer: 'lift',
        state: reasons.size || graph.coverage.state !== 'complete' ? 'partial' : 'complete',
        completed_units: completed,
        total_units: graph.instructions.length,
        reasons: [...reasons],
      },
    };
  }
}
