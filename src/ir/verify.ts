import {
  entityIdSchema,
  evidenceIdSchema,
  machineAddressSchema,
  machineRangeSchema,
  registerSchema,
} from '../core/index.js';
import type { CallClobbers, RegisterDescriptor } from '../core/index.js';
import { bitWidth, expressionOperands, sameType, successors, validType } from './model.js';
import { computeDominance } from './dominance.js';
import type {
  DataType,
  Effect,
  Expression,
  FunctionIR,
  IRType,
  Origin,
  RegisterBinding,
  Value,
} from './model.js';

export interface IRProblem {
  readonly code:
    | 'identity'
    | 'type'
    | 'reference'
    | 'control_flow'
    | 'effect_order'
    | 'provenance'
    | 'register'
    | 'semantic';
  readonly node: string;
  readonly message: string;
}
export class IRValidationError extends Error {
  constructor(readonly problems: readonly IRProblem[]) {
    super(problems.map((p) => `${p.code}: ${p.message}`).join('\n'));
    this.name = 'IRValidationError';
  }
}
/** Shared by builders and whole-function validation. No implicit extension or signedness conversion. */
export function expressionProblems(type: DataType, e: Expression): readonly string[] {
  const errors: string[] = [];
  const require = (condition: boolean, message: string): void => {
    if (!condition) errors.push(message);
  };
  const integer = (t: DataType): boolean => t.kind === 'integer';
  const boolean = (t: DataType): boolean => t.kind === 'integer' && t.bits === 1;
  const equal = (a: DataType, b: DataType): void => {
    require(sameType(a, b), 'Operand/result types differ');
  };
  require(validType(type), 'Invalid result type');
  for (const operand of expressionOperands(e))
    require(validType(operand.type), 'Invalid operand type');
  if (errors.length > 0) return errors;
  switch (e.kind) {
    case 'constant':
      require(e.bits >= 0n &&
        e.bits < 1n << BigInt(bitWidth(type)), 'Constant is not canonical for width');
      break;
    case 'address':
      require(type.kind === 'integer' &&
        type.bits === 64 &&
        machineAddressSchema.safeParse(e.address).success &&
        e.address.space !== 'file', 'Address constant requires a memory coordinate and i64');
      break;
    case 'integer':
      require(integer(type) &&
        integer(e.left.type) &&
        integer(e.right.type), 'Integer operation requires integer types');
      equal(type, e.left.type);
      if (!['shl', 'lshr', 'ashr', 'rol', 'ror'].includes(e.op)) equal(type, e.right.type);
      break;
    case 'integer_unary':
      require(integer(type), 'Integer unary requires integer type');
      equal(type, e.value.type);
      break;
    case 'compare':
      require(boolean(type) &&
        integer(e.left.type), 'Integer comparison requires i1 result and integer operands');
      equal(e.left.type, e.right.type);
      break;
    case 'cast': {
      const input = e.value.type;
      switch (e.op) {
        case 'bitcast':
          require(bitWidth(type) === bitWidth(input), 'Bitcast changes bit width');
          break;
        case 'truncate':
        case 'zero_extend':
        case 'sign_extend':
          require(integer(type) && integer(input), 'Integer cast requires integer types');
          require(e.op === 'truncate'
            ? bitWidth(type) < bitWidth(input)
            : bitWidth(type) > bitWidth(input), 'Cast has invalid width direction');
          break;
        case 'signed_to_float':
        case 'unsigned_to_float':
          require(input.kind === 'integer' &&
            type.kind === 'float', 'Integer-to-float types invalid');
          break;
        case 'float_to_signed':
        case 'float_to_unsigned':
          require(input.kind === 'float' &&
            type.kind === 'integer', 'Float-to-integer types invalid');
          break;
        case 'float_convert':
          require(input.kind === 'float' &&
            type.kind === 'float' &&
            input.bits !== type.bits, 'Float conversion types invalid');
          break;
      }
      break;
    }
    case 'extract':
      require(integer(type) &&
        integer(e.value.type) &&
        Number.isInteger(e.offset) &&
        e.offset >= 0 &&
        e.offset + bitWidth(type) <= bitWidth(e.value.type), 'Invalid bit extraction');
      break;
    case 'insert':
      equal(type, e.base.type);
      require(integer(type) &&
        integer(e.value.type) &&
        Number.isInteger(e.offset) &&
        e.offset >= 0 &&
        e.offset + bitWidth(e.value.type) <= bitWidth(type), 'Invalid bit insertion');
      break;
    case 'concat':
      require(integer(type) &&
        e.values.length > 0 &&
        e.values.every((value) => integer(value.type)) &&
        e.values.reduce((sum, value) => sum + bitWidth(value.type), 0) ===
          bitWidth(type), 'Concatenation requires nonempty integer slices with exact total width');
      break;
    case 'select':
      require(boolean(e.condition.type), 'Select condition is not i1');
      equal(type, e.when_true.type);
      equal(type, e.when_false.type);
      break;
    case 'flag':
      require(boolean(type) &&
        boolean(e.carry.type) &&
        integer(e.left.type), 'Flag requires integer inputs and i1 carry/result');
      equal(e.left.type, e.right.type);
      break;
    case 'float':
      require(type.kind === 'float', 'Float operation requires float type');
      equal(type, e.left.type);
      equal(type, e.right.type);
      break;
    case 'float_unary':
      require(type.kind === 'float', 'Float unary requires float type');
      equal(type, e.value.type);
      break;
    case 'float_compare':
      require(boolean(type) &&
        e.left.type.kind === 'float', 'Float comparison requires i1 result and float operands');
      equal(e.left.type, e.right.type);
      break;
    case 'vector':
      require(type.kind === 'vector' &&
        e.lanes.length === type.lanes, 'Vector lane arity mismatch');
      if (type.kind === 'vector') for (const lane of e.lanes) equal(type.element, lane.type);
      break;
    case 'vector_lane':
    case 'vector_insert': {
      const input = e.vector.type;
      require(input.kind === 'vector' &&
        Number.isInteger(e.lane) &&
        e.lane >= 0 &&
        e.lane < input.lanes, 'Invalid vector lane');
      if (input.kind === 'vector') {
        if (e.kind === 'vector_lane') equal(type, input.element);
        else {
          equal(type, input);
          equal(e.value.type, input.element);
        }
      }
      break;
    }
    case 'vector_integer':
    case 'vector_float':
      require(type.kind === 'vector' &&
        type.element.kind ===
          (e.kind === 'vector_integer' ? 'integer' : 'float'), 'Vector element type mismatch');
      equal(type, e.left.type);
      equal(type, e.right.type);
      break;
    case 'indeterminate':
      require(e.reason.trim().length > 0, 'Indeterminate value needs a reason');
      break;
  }
  return errors;
}

/**
 * Dominance SSA: a data value is available after its definition in its own
 * block and in every block its block strictly dominates. Dominance includes
 * unreachable components (each rooted separately), so no component reads
 * another's values. Joins/loops merge only through simultaneous edge arguments.
 * Effect tokens remain block-local: a single linear effect chain orders
 * registers, memory and calls; forks occur only at terminators.
 */
export function verifyIR(
  ir: FunctionIR,
  checkpoint?: (work: number) => void,
): readonly IRProblem[] {
  checkpoint?.(
    ir.blocks.length + ir.returns.length + (ir.form === 'ssa' ? ir.register_states.length : 0),
  );
  const problems: IRProblem[] = [];
  const report = (code: IRProblem['code'], node: string, message: string): void => {
    problems.push({ code, node, message });
  };
  const identities = new Set<string>();
  const identify = (id: string): void => {
    checkpoint?.(1);
    if (!entityIdSchema.safeParse(id).success || identities.has(id))
      report('identity', id, 'Malformed or duplicate entity identity');
    identities.add(id);
  };
  // Generated nodes deliberately share immutable provenance. Validate that
  // payload once per invocation, but retain every node-specific diagnostic.
  const provenanceFacts = new WeakMap<Origin['provenance'], {
    readonly missing: boolean;
    readonly invalid: boolean;
    readonly missing_range: boolean;
  }>();
  const origin = (node: Origin): void => {
    identify(node.id);
    const p = node.provenance;
    let facts = provenanceFacts.get(p);
    if (!facts) {
      checkpoint?.(
        p.instruction_ids.length + p.evidence_ids.length + p.synthetic.length + p.ranges.length,
      );
      facts = {
        missing: p.instruction_ids.length === 0 && p.synthetic.length === 0,
        invalid:
          p.instruction_ids.some((id) => !entityIdSchema.safeParse(id).success) ||
          p.evidence_ids.some((id) => !evidenceIdSchema.safeParse(id).success) ||
          p.synthetic.some((reason) => reason.trim().length === 0) ||
          p.ranges.some((range) => !machineRangeSchema.safeParse(range).success || range.size === 0n),
        missing_range: p.instruction_ids.length > 0 && p.ranges.length === 0,
      };
      provenanceFacts.set(p, facts);
    } else checkpoint?.(0);
    if (facts.missing) report('provenance', node.id, 'Missing instruction or synthetic origin');
    if (facts.invalid) report('provenance', node.id, 'Invalid source identity, range, evidence or justification');
    if (facts.missing_range) report('provenance', node.id, 'Instruction origin needs a source range');
  };
  const registerRoots = new Map<string, number>();
  const registers = new Map<string, RegisterDescriptor>();
  const registerFacts = new WeakMap<RegisterDescriptor, readonly string[]>();
  const register = (r: RegisterDescriptor, node: string): boolean => {
    let facts = registerFacts.get(r);
    if (facts && registers.get(r.id) === r && registerRoots.get(r.root) === r.root_width_bits) {
      checkpoint?.(0);
      for (const message of facts) report('register', node, message);
      return true;
    }
    checkpoint?.(1);
    if (!facts) {
      const parsed = registerSchema.safeParse(r);
      if (!parsed.success) {
        report('register', node, 'Invalid core register descriptor');
        return false;
      }
      const errors: string[] = [];
      if (r.write_rule === 'replace_root' &&
        (r.offset_bits !== 0 || r.width_bits !== r.root_width_bits))
        errors.push('replace_root must cover the root');
      if (r.write_rule === 'zero_extend_root' && r.offset_bits !== 0)
        errors.push('zero_extend_root must start at bit zero');
      facts = errors;
      if (Object.isFrozen(r)) {
        const fields = Object.getOwnPropertyDescriptors(r);
        // Frozen accessors/inherited fields are not immutable descriptor data.
        const flat = Reflect.ownKeys(fields).every((key) => {
          const field = fields[key as keyof typeof fields]!;
          return 'value' in field &&
            (typeof field.value === 'string' || typeof field.value === 'number');
        }) && Object.keys(parsed.data).every((key) => {
          const field = fields[key];
          return field !== undefined && 'value' in field;
        });
        if (flat) registerFacts.set(r, facts);
      }
    }
    for (const message of facts) report('register', node, message);
    if (registerRoots.has(r.root) && registerRoots.get(r.root) !== r.root_width_bits)
      report('register', node, 'Conflicting root widths');
    registerRoots.set(r.root, r.root_width_bits);
    const previous = registers.get(r.id);
    if (
      previous &&
      (Object.keys(r) as (keyof RegisterDescriptor)[]).some((key) => previous[key] !== r[key])
    )
      report('register', node, 'Conflicting register descriptors');
    registers.set(r.id, r);
    return true;
  };
  const clobbers = (c: CallClobbers, node: string): void => {
    for (const r of [...c.registers, ...c.flags]) register(r, node);
  };
  origin(ir);
  const blocks = new Map(ir.blocks.map((block) => [block.id, block]));
  if (!blocks.has(ir.entry)) report('control_flow', ir.id, 'Entry block does not exist');
  for (const type of ir.returns) if (!validType(type)) report('type', ir.id, 'Invalid return type');
  const stateRows = ir.form === 'ssa' ? ir.register_states : [];
  const states = new Map(stateRows.map((state) => [state.block, state]));
  if (
    ir.form === 'ssa' &&
    (states.size !== stateRows.length ||
      states.size !== blocks.size ||
      stateRows.some((state) => !blocks.has(state.block)))
  )
    report('register', ir.id, 'SSA requires exactly one architectural-state row per block');
  const layout = states.get(ir.entry)?.entry ?? [];
  let tracked: Map<string, bigint> | undefined;
  const layoutOverlaps: number[] = [];
  const layoutDescriptors: RegisterDescriptor[] = [];
  const masks = (bindings: readonly RegisterBinding[], node: string): Map<string, bigint> => {
    const initial = tracked === undefined ? new Map<string, bigint>() : undefined;
    let canonical = tracked !== undefined && bindings.length === layoutDescriptors.length;
    let invalid: Set<number> | undefined;
    for (let index = 0; index < bindings.length; index++) {
      const binding = bindings[index]!, r = binding.register;
      if (initial) layoutDescriptors.push(r);
      if (!register(r, node)) {
        canonical = false;
        (invalid ??= new Set()).add(index);
        continue;
      }
      canonical &&= r === layoutDescriptors[index] && registerFacts.has(r);
      if (r.write_rule !== 'preserve_other_bits' || r.role === 'zero')
        report('register', node, 'SSA bindings must preserve disjoint physical register slices');
      if (binding.value.type.kind !== 'integer' || bitWidth(binding.value.type) !== r.width_bits)
        report('type', node, 'SSA register binding requires an equal-width integer value');
      if (initial) {
        const mask = ((1n << BigInt(r.width_bits)) - 1n) << BigInt(r.offset_bits),
          previous = initial.get(r.root) ?? 0n;
        if ((previous & mask) !== 0n) {
          report('register', node, 'Overlapping SSA register bindings');
          layoutOverlaps.push(index);
        }
        initial.set(r.root, previous | mask);
      }
    }
    if (initial) return initial;
    if (canonical) {
      checkpoint?.(layoutOverlaps.length);
      for (let index = 0; index < layoutOverlaps.length; index++)
        report('register', node, 'Overlapping SSA register bindings');
      return tracked!;
    }
    // Descriptor identity/order differs: recompute the actual mask after the
    // mandatory per-binding checks above. Never reuse a merely similar layout.
    const result = new Map<string, bigint>();
    for (let index = 0; index < bindings.length; index++) {
      checkpoint?.(1);
      if (invalid?.has(index)) continue;
      const r = bindings[index]!.register,
        mask = ((1n << BigInt(r.width_bits)) - 1n) << BigInt(r.offset_bits),
        previous = result.get(r.root) ?? 0n;
      if ((previous & mask) !== 0n) report('register', node, 'Overlapping SSA register bindings');
      result.set(r.root, previous | mask);
    }
    return result;
  };
  const sameMasks = (
    actual: ReadonlyMap<string, bigint>,
    expected: ReadonlyMap<string, bigint>,
    node: string,
  ): void => {
    if (actual === expected) { checkpoint?.(0); return; }
    checkpoint?.(expected.size);
    if (
      actual.size !== expected.size ||
      [...expected].some(([root, mask]) => actual.get(root) !== mask)
    )
      report('register', node, 'SSA architectural-state coverage mismatch');
  };
  tracked = masks(layout, ir.id);
  const trackedCells = new Set(
    layoutDescriptors.map((r) => `${r.root}:${r.offset_bits}:${r.width_bits}`),
  );
  // Sparse rows (merge entries and rebound exits) bind distinct tracked cells.
  const partialRow = (bindings: readonly RegisterBinding[], node: string): void => {
    const seen = new Set<string>();
    for (const binding of bindings) {
      checkpoint?.(1);
      const r = binding.register;
      if (!register(r, node)) continue;
      const cell = `${r.root}:${r.offset_bits}:${r.width_bits}`;
      if (r.write_rule !== 'preserve_other_bits' || r.role === 'zero' || !trackedCells.has(cell))
        report('register', node, 'SSA state rows bind only tracked disjoint register cells');
      if (seen.has(cell)) report('register', node, 'Overlapping SSA register bindings');
      seen.add(cell);
      if (binding.value.type.kind !== 'integer' || bitWidth(binding.value.type) !== r.width_bits)
        report('type', node, 'SSA register binding requires an equal-width integer value');
    }
  };
  const dominance = computeDominance(ir, checkpoint);
  // Cross-block references are resolved after every definition is known.
  const definedIn = new Map<string, { readonly block: string; readonly type: IRType }>();
  const remote: { readonly value: Value; readonly block: string; readonly node: string }[] = [];
  for (const block of ir.blocks) {
    origin(block);
    const local = new Map<string, IRType>();
    const define = (v: Value | Effect): void => {
      identify(v.id);
      if (!validType(v.type)) report('type', v.id, 'Invalid definition type');
      local.set(v.id, v.type);
      if (v.type.kind !== 'effect' && !definedIn.has(v.id))
        definedIn.set(v.id, { block: block.id, type: v.type });
    };
    const reference = (v: Value | Effect, node: string): void => {
      checkpoint?.(1);
      const type = local.get(v.id);
      if (!type && v.type.kind !== 'effect') remote.push({ value: v as Value, block: block.id, node });
      else if (!type) report('reference', node, `Undefined, forward or nondominating value ${v.id}`);
      else if (!sameType(type, v.type))
        report('type', node, 'Reference type differs from its definition');
    };
    const condition = (v: Value, node: string): void => {
      reference(v, node);
      if (v.type.kind !== 'integer' || v.type.bits !== 1)
        report('type', node, 'Condition must be i1');
    };
    const pointer = (v: Value, node: string): void => {
      reference(v, node);
      if (v.type.kind !== 'integer' || v.type.bits !== 64)
        report('type', node, 'Memory/indirect address must be i64');
    };
    for (const parameter of block.parameters) define(parameter);
    define(block.effect_parameter);
    if (block.effect_parameter.type.kind !== 'effect')
      report('effect_order', block.id, 'Block needs an effect parameter');
    let effect = block.effect_parameter;
    const state = states.get(block.id);
    if (state) {
      if (dominance.idom(block.id) === null) {
        // Roots (and joins of separately rooted components) define every cell.
        sameMasks(masks(state.entry, block.id), tracked, block.id);
        const parameters = new Set(block.parameters.map((parameter) => parameter.id)),
          assigned = new Set<string>();
        for (const binding of state.entry) {
          reference(binding.value, block.id);
          if (!parameters.has(binding.value.id) || assigned.has(binding.value.id))
            report('register', block.id, 'SSA entry bindings require distinct block parameters');
          assigned.add(binding.value.id);
        }
      } else {
        partialRow(state.entry, block.id);
        for (const binding of state.entry) reference(binding.value, block.id);
      }
    }
    for (const instruction of block.instructions) {
      origin(instruction);
      if ('effect_in' in instruction) {
        reference(instruction.effect_in, instruction.id);
        if (
          instruction.effect_in.id !== effect.id ||
          instruction.effect_in.type.kind !== 'effect' ||
          instruction.effect_out.type.kind !== 'effect'
        )
          report(
            'effect_order',
            instruction.id,
            'State access must consume current effect and produce a new effect',
          );
      }
      if ('register_inputs' in instruction) {
        if (
          ir.form === 'register' &&
          (instruction.register_inputs.length ||
            ('register_outputs' in instruction && instruction.register_outputs.length))
        )
          report(
            'register',
            instruction.id,
            'Register-form boundaries cannot contain SSA bindings',
          );
        const inputMasks = masks(instruction.register_inputs, instruction.id);
        if (ir.form === 'ssa') sameMasks(inputMasks, tracked, instruction.id);
        for (const binding of instruction.register_inputs) reference(binding.value, instruction.id);
      }
      switch (instruction.kind) {
        case 'assign':
          for (const operand of expressionOperands(instruction.expression))
            reference(operand, instruction.id);
          for (const message of expressionProblems(instruction.result.type, instruction.expression))
            report('type', instruction.id, message);
          define(instruction.result);
          break;
        case 'read_register':
        case 'write_register': {
          if (ir.form === 'ssa')
            report(
              'register',
              instruction.id,
              'SSA form cannot contain architectural register operations',
            );
          register(instruction.register, instruction.id);
          const v = instruction.kind === 'read_register' ? instruction.result : instruction.value;
          if (bitWidth(v.type) !== instruction.register.width_bits)
            report('type', instruction.id, 'Register access width differs from value');
          if (instruction.kind === 'read_register') define(v);
          else reference(v, instruction.id);
          break;
        }
        case 'load':
        case 'store': {
          pointer(instruction.address, instruction.id);
          const type =
            instruction.kind === 'load' ? instruction.result.type : instruction.value.type;
          const a = instruction.access.alignment;
          if (
            bitWidth(type) % 8 !== 0 ||
            !Number.isSafeInteger(a) ||
            a < 1 ||
            a > 4096 ||
            (a & (a - 1)) !== 0
          )
            report(
              'type',
              instruction.id,
              'Memory access requires byte width and power-of-two alignment <=4096',
            );
          if (instruction.kind === 'load') define(instruction.result);
          else reference(instruction.value, instruction.id);
          break;
        }
        case 'memory_fence':
          if (
            instruction.scope !== 'inner_shareable' ||
            instruction.ordering !== 'acquire_release' ||
            instruction.accesses !== 'reads_writes'
          )
            report('semantic', instruction.id, 'Unsupported memory fence semantics');
          break;
        case 'call':
          if (instruction.target.kind === 'indirect')
            pointer(instruction.target.value, instruction.id);
          else if (
            !machineAddressSchema.safeParse(instruction.target.address).success ||
            instruction.target.address.space === 'file'
          )
            report('semantic', instruction.id, 'Call requires a memory address');
          for (const arg of instruction.arguments) reference(arg, instruction.id);
          for (const result of instruction.results) define(result);
          clobbers(instruction.clobbers, instruction.id);
          if (instruction.contract_evidence.some((id) => !evidenceIdSchema.safeParse(id).success))
            report('provenance', instruction.id, 'Invalid call contract evidence');
          if (
            instruction.contract_evidence.length === 0 &&
            instruction.clobbers.memory !== 'unknown_read_write'
          )
            report(
              'semantic',
              instruction.id,
              'Restricted call memory effects need contract evidence',
            );
          break;
        case 'unknown_effect':
          if (instruction.reason.trim().length === 0)
            report('semantic', instruction.id, 'Unknown effect needs a reason');
          clobbers(instruction.clobbers, instruction.id);
          break;
      }
      if (instruction.kind === 'call' || instruction.kind === 'unknown_effect') {
        const outputMasks = masks(instruction.register_outputs, instruction.id),
          expected = new Map<string, bigint>();
        if (ir.form === 'ssa')
          for (const r of [...instruction.clobbers.registers, ...instruction.clobbers.flags]) {
            checkpoint?.(1);
            if (!registerSchema.safeParse(r).success) continue;
            const mask =
              (((1n << BigInt(r.width_bits)) - 1n) << BigInt(r.offset_bits)) &
              (tracked.get(r.root) ?? 0n);
            if (mask) expected.set(r.root, (expected.get(r.root) ?? 0n) | mask);
          }
        sameMasks(outputMasks, expected, instruction.id);
        for (const binding of instruction.register_outputs) define(binding.value);
      }
      if ('effect_out' in instruction) {
        define(instruction.effect_out);
        effect = instruction.effect_out;
      }
    }
    if (state) {
      // Function exits observe every cell; other blocks list rebound cells.
      if (successors(block.terminator).length === 0)
        sameMasks(masks(state.exit, block.id), tracked, block.id);
      else partialRow(state.exit, block.id);
      for (const binding of state.exit) reference(binding.value, block.id);
    }
    const t = block.terminator;
    origin(t);
    reference(t.effect, t.id);
    if (t.effect.id !== effect.id || t.effect.type.kind !== 'effect')
      report('effect_order', t.id, 'Terminator does not consume final effect');
    if (t.kind === 'branch') condition(t.condition, t.id);
    if (t.kind === 'switch') {
      reference(t.value, t.id);
      if (t.value.type.kind !== 'integer') report('type', t.id, 'Switch selector must be integer');
      const cases = new Set<bigint>();
      for (const item of t.cases) {
        checkpoint?.(1);
        if (
          cases.has(item.bits) ||
          item.bits < 0n ||
          !validType(t.value.type) ||
          item.bits >= 1n << BigInt(bitWidth(t.value.type))
        )
          report('control_flow', t.id, 'Duplicate or out-of-width switch case');
        cases.add(item.bits);
      }
    }
    if (t.kind === 'return') {
      if (t.values.length !== ir.returns.length)
        report('control_flow', t.id, 'Return arity mismatch');
      t.values.forEach((v, index) => {
        reference(v, t.id);
        const expected = ir.returns[index];
        if (expected && !sameType(expected, v.type)) report('type', t.id, 'Return type mismatch');
      });
    }
    if (t.kind === 'indirect') pointer(t.target, t.id);
    if (
      (t.kind === 'trap' || t.kind === 'unknown' || t.kind === 'indirect') &&
      t.reason.trim().length === 0
    )
      report('semantic', t.id, 'Boundary needs a reason');
    checkpoint?.(t.kind === 'switch' ? t.cases.length + 1 : 1);
    for (const edge of successors(t)) {
      reference(edge.effect, t.id);
      if (edge.effect.id !== effect.id || edge.effect.type.kind !== 'effect')
        report('effect_order', t.id, 'Edge does not carry final effect');
      const target = blocks.get(edge.target);
      if (!target) report('control_flow', t.id, 'Edge target does not exist');
      else if (edge.arguments.length !== target.parameters.length)
        report('control_flow', t.id, 'Edge argument arity mismatch');
      edge.arguments.forEach((v, index) => {
        reference(v, t.id);
        const expected = target?.parameters[index];
        if (expected && !sameType(expected.type, v.type))
          report('type', t.id, 'Edge argument type mismatch');
      });
    }
  }
  for (const { value, block, node } of remote) {
    const definition = definedIn.get(value.id);
    if (!definition || definition.block === block || !dominance.dominates(definition.block, block))
      report('reference', node, `Undefined, forward or nondominating value ${value.id}`);
    else if (!sameType(definition.type, value.type))
      report('type', node, 'Reference type differs from its definition');
  }
  return problems;
}
export function assertValidIR(ir: FunctionIR, checkpoint?: (work: number) => void): void {
  const problems = verifyIR(ir, checkpoint);
  if (problems.length > 0) throw new IRValidationError(problems);
}
