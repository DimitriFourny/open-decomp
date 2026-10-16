import { entityIdentity, entityIdSchema, sliceIdSchema } from '../core/index.js';
import type { Address, CallClobbers, CanonicalValue, EntityId, OperationContext, RegisterDescriptor } from '../core/index.js';
import { effectType, integer, bitWidth } from './model.js';
import type { ArithmeticFlag, BasicBlock, CallTarget, CastOp, DataType, Edge, Effect, Expression, FloatOp, FloatPredicate, FunctionIR, Instruction, IntegerOp, IntegerPredicate, IntegerUnaryOp, MemoryAccess, Provenance, RegisterIR, SSAForm, Terminator, Value, VectorType } from './model.js';
import { mergeProvenanceSources } from './provenance.js';
import { assertValidIR, expressionProblems } from './verify.js';
import { IRConstructionBudget } from './budget.js';

/** Birth keys, not array positions, determine block identity. Preserve IDs through rewrites. */
export class IRBuilder<Form extends FunctionIR['form'] = 'register'> {
  readonly #blocks: BlockBuilder[] = [];
  readonly #blockIds = new Set<EntityId>();
  readonly #budget: IRConstructionBudget;
  constructor(readonly slice_id: string, readonly function_id: EntityId, readonly provenance: Provenance, readonly form: Form = 'register' as Form, readonly context?: OperationContext) {
    this.#budget = new IRConstructionBudget(context ? { max_ir_nodes: context.budget.ir_nodes, max_blocks: context.budget.blocks, checkpoint: work => context.checkpoint(work) } : {});
    context?.checkpoint(0);
    sliceIdSchema.parse(slice_id); entityIdSchema.parse(function_id);
  }
  block(birth: CanonicalValue, parameters: readonly DataType[] = [], provenance: Provenance = this.provenance): BlockBuilder {
    this.#budget.block(parameters.length);
    const id = entityIdentity(this.slice_id, 'ir.block', [this.function_id, birth]);
    if (this.#blockIds.has(id)) throw new TypeError('Duplicate block birth key');
    this.#blockIds.add(id);
    const block = new BlockBuilder(this.slice_id, id, parameters, provenance, this.#budget);
    this.#blocks.push(block);
    return block;
  }
  finish(entry: BlockBuilder, returns: readonly DataType[] = []): Form extends 'ssa' ? SSAForm : RegisterIR {
    const blocks = this.#blocks.map(block => block.finish());
    const body = { id: this.function_id, provenance: mergeProvenanceSources([this.provenance, ...blocks.map(block => block.provenance)], this.#budget.limits.checkpoint), entry: entry.id, returns, blocks };
    const ir: FunctionIR = this.form === 'ssa'
      ? { ...body, form: 'ssa', register_states: blocks.map(block => ({ block: block.id, entry: [], exit: [] })) }
      : { ...body, form: 'register' };
    assertValidIR(ir, this.#budget.limits.checkpoint);
    return ir as Form extends 'ssa' ? SSAForm : RegisterIR;
  }
}
export class BlockBuilder {
  readonly parameters: readonly Value[];
  readonly effect_parameter: Effect;
  readonly #instructions: Instruction[] = [];
  #effect: Effect;
  #terminator: Terminator | undefined;
  #sequence = 0;
  #source: Provenance;
  constructor(readonly slice_id: string, readonly id: EntityId, parameterTypes: readonly DataType[], readonly provenance: Provenance, readonly budget?: IRConstructionBudget) {
    this.#source = provenance;
    this.parameters = parameterTypes.map((type, index) => ({ id: entityIdentity(slice_id, 'ir.parameter', [id, index]), type }));
    this.effect_parameter = { id: entityIdentity(slice_id, 'ir.effect_parameter', id), type: effectType };
    this.#effect = this.effect_parameter;
  }
  /** Change current instruction origin before emitting its semantic nodes. */
  source(provenance: Provenance): this { this.#source = provenance; return this; }
  get effect(): Effect { return this.#effect; }
  #identity(kind: string): EntityId {
    if (this.#terminator) throw new TypeError('Cannot append after a terminator');
    return entityIdentity(this.slice_id, `ir.${kind}`, [this.id, this.#sequence++]);
  }
  #order(): { effect_in: Effect; effect_out: Effect } {
    const effect_in = this.#effect;
    const effect_out: Effect = { id: this.#identity('effect'), type: effectType };
    this.#effect = effect_out;
    return { effect_in, effect_out };
  }
  assign(type: DataType, expression: Expression): Value {
    this.budget?.nodes();
    const errors = expressionProblems(type, expression);
    if (errors.length > 0) throw new TypeError(errors.join('; '));
    const result: Value = { id: this.#identity('value'), type };
    this.#instructions.push({ kind: 'assign', id: this.#identity('instruction'), provenance: this.#source, result, expression });
    return result;
  }
  constant(type: DataType, bits: bigint): Value { return this.assign(type, { kind: 'constant', bits: BigInt.asUintN(bitWidth(type), bits) }); }
  address(address: Address): Value { return this.assign(integer(64), { kind: 'address', address }); }
  int(op: IntegerOp, left: Value, right: Value): Value { return this.assign(left.type, { kind: 'integer', op, left, right }); }
  unary(op: IntegerUnaryOp, value: Value): Value { return this.assign(value.type, { kind: 'integer_unary', op, value }); }
  compare(op: IntegerPredicate, left: Value, right: Value): Value { return this.assign(integer(1), { kind: 'compare', op, left, right }); }
  cast(op: CastOp, type: DataType, value: Value): Value { return this.assign(type, { kind: 'cast', op, value }); }
  extract(value: Value, offset: number, bits: number): Value { return this.assign(integer(bits), { kind: 'extract', value, offset }); }
  insert(base: Value, value: Value, offset: number): Value { return this.assign(base.type, { kind: 'insert', base, value, offset }); }
  concat(values: readonly Value[]): Value { return this.assign(integer(values.reduce((sum, value) => sum + bitWidth(value.type), 0)), { kind: 'concat', values }); }
  select(condition: Value, when_true: Value, when_false: Value): Value { return this.assign(when_true.type, { kind: 'select', condition, when_true, when_false }); }
  flag(op: 'add' | 'sub', flag: ArithmeticFlag, left: Value, right: Value, carry: Value): Value { return this.assign(integer(1), { kind: 'flag', op, flag, left, right, carry }); }
  fp(op: FloatOp, left: Value, right: Value): Value { return this.assign(left.type, { kind: 'float', op, left, right }); }
  fpCompare(op: FloatPredicate, left: Value, right: Value): Value { return this.assign(integer(1), { kind: 'float_compare', op, left, right }); }
  pack(type: VectorType, lanes: readonly Value[]): Value { return this.assign(type, { kind: 'vector', lanes }); }
  lane(value: Value, lane: number): Value {
    if (value.type.kind !== 'vector') throw new TypeError('Lane extraction needs a vector');
    return this.assign(value.type.element, { kind: 'vector_lane', vector: value, lane });
  }
  vectorInt(op: IntegerOp, left: Value, right: Value): Value { return this.assign(left.type, { kind: 'vector_integer', op, left, right }); }
  vectorFloat(op: FloatOp, left: Value, right: Value): Value { return this.assign(left.type, { kind: 'vector_float', op, left, right }); }
  indeterminate(type: DataType, state: 'unknown' | 'undefined', reason: string): Value { return this.assign(type, { kind: 'indeterminate', state, reason }); }
  readRegister(register: RegisterDescriptor, type: DataType = integer(register.width_bits)): Value {
    this.budget?.nodes();
    const result: Value = { id: this.#identity('value'), type };
    this.#instructions.push({ kind: 'read_register', id: this.#identity('instruction'), provenance: this.#source, result, register, ...this.#order() });
    return result;
  }
  writeRegister(register: RegisterDescriptor, value: Value): void {
    this.budget?.nodes();
    this.#instructions.push({ kind: 'write_register', id: this.#identity('instruction'), provenance: this.#source, register, value, ...this.#order() });
  }
  load(type: DataType, address: Value, access: MemoryAccess = { endian: 'little', alignment: 1, volatile: false }): Value {
    this.budget?.nodes();
    const result: Value = { id: this.#identity('value'), type };
    this.#instructions.push({ kind: 'load', id: this.#identity('instruction'), provenance: this.#source, result, address, access, register_inputs: [], ...this.#order() });
    return result;
  }
  store(address: Value, value: Value, access: MemoryAccess = { endian: 'little', alignment: 1, volatile: false }): void {
    this.budget?.nodes();
    this.#instructions.push({ kind: 'store', id: this.#identity('instruction'), provenance: this.#source, address, value, access, register_inputs: [], ...this.#order() });
  }
  call(target: CallTarget, args: readonly Value[], returns: readonly DataType[], clobbers: CallClobbers, contract_evidence: readonly string[] = []): readonly Value[] {
    this.budget?.nodes();
    const results = returns.map(type => ({ id: this.#identity('value'), type }));
    this.#instructions.push({ kind: 'call', id: this.#identity('instruction'), provenance: this.#source, target, arguments: args, results, clobbers, contract_evidence, register_inputs: [], register_outputs: [], ...this.#order() });
    return results;
  }
  unknown(reason: string, clobbers: CallClobbers): void {
    this.budget?.nodes();
    this.#instructions.push({ kind: 'unknown_effect', id: this.#identity('instruction'), provenance: this.#source, reason, clobbers, register_inputs: [], register_outputs: [], ...this.#order() });
  }
  edge(target: BlockBuilder | EntityId, args: readonly Value[] = []): Edge { return { target: typeof target === 'string' ? target : target.id, arguments: args, effect: this.#effect }; }
  /** Raw typed terminator API supports switches and unresolved/indirect boundaries as well. */
  terminate(terminator: TerminatorBody): void {
    this.budget?.limits.checkpoint?.(0);
    this.#terminator = { ...terminator, id: this.#identity('terminator'), provenance: this.#source, effect: this.#effect };
  }
  jump(target: BlockBuilder | EntityId, args: readonly Value[] = []): void { this.terminate({ kind: 'jump', edge: this.edge(target, args) }); }
  branch(condition: Value, when_true: Edge, when_false: Edge): void { this.terminate({ kind: 'branch', condition, when_true, when_false }); }
  return(values: readonly Value[] = []): void { this.terminate({ kind: 'return', values }); }
  finish(): BasicBlock {
    if (!this.#terminator) throw new TypeError('Block has no terminator');
    return { id: this.id, provenance: mergeProvenanceSources([this.provenance, ...this.#instructions.map(node => node.provenance), this.#terminator.provenance], this.budget?.limits.checkpoint), parameters: this.parameters, effect_parameter: this.effect_parameter, instructions: [...this.#instructions], terminator: this.#terminator };
  }
}
type TerminatorBody = Terminator extends infer T ? T extends Terminator ? Omit<T, 'id' | 'provenance' | 'effect'> : never : never;
