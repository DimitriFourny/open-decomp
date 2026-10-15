import type { Address, AddressRange, CallClobbers, DecodedInstruction, EntityId, Evidence, RegisterDescriptor } from '../core/index.js';

/** Machine types, not recovered source/ABI types. Integers are signless bit vectors. */
export interface IntegerType { readonly kind: 'integer'; readonly bits: number }
export interface FloatType { readonly kind: 'float'; readonly bits: 32 | 64 }
export interface VectorType { readonly kind: 'vector'; readonly element: IntegerType | FloatType; readonly lanes: number }
export type DataType = IntegerType | FloatType | VectorType;
export type IRType = DataType | { readonly kind: 'effect' };
export interface Value { readonly id: EntityId; readonly type: DataType }
export interface Effect { readonly id: EntityId; readonly type: { readonly kind: 'effect' } }
export interface Provenance {
  readonly instruction_ids: readonly DecodedInstruction['id'][];
  readonly ranges: readonly AddressRange[];
  readonly evidence_ids: readonly Evidence['id'][];
  /** A nonempty justification is required for nodes without machine instruction origins. */
  readonly synthetic: readonly string[];
}
export interface Origin { readonly id: EntityId; readonly provenance: Provenance }
export type IntegerOp = 'add' | 'sub' | 'mul' | 'udiv' | 'sdiv' | 'urem' | 'srem' | 'and' | 'or' | 'xor' | 'shl' | 'lshr' | 'ashr' | 'rol' | 'ror';
export type IntegerUnaryOp = 'not' | 'neg' | 'clz' | 'ctz' | 'popcount';
export type IntegerPredicate = 'eq' | 'ne' | 'ult' | 'ule' | 'ugt' | 'uge' | 'slt' | 'sle' | 'sgt' | 'sge';
export type FloatOp = 'add' | 'sub' | 'mul' | 'div';
export type FloatPredicate = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'ordered' | 'unordered';
export type CastOp = 'truncate' | 'zero_extend' | 'sign_extend' | 'bitcast' | 'signed_to_float' | 'unsigned_to_float' | 'float_to_signed' | 'float_to_unsigned' | 'float_convert';
export type ArithmeticFlag = 'carry' | 'borrow' | 'overflow' | 'zero' | 'negative' | 'parity';
/** Operands refer to preceding local definitions, never expression text or nested code. */
export type Expression =
  | { readonly kind: 'constant'; readonly bits: bigint }
  | { readonly kind: 'address'; readonly address: Address }
  | { readonly kind: 'integer'; readonly op: IntegerOp; readonly left: Value; readonly right: Value }
  | { readonly kind: 'integer_unary'; readonly op: IntegerUnaryOp; readonly value: Value }
  | { readonly kind: 'compare'; readonly op: IntegerPredicate; readonly left: Value; readonly right: Value }
  | { readonly kind: 'cast'; readonly op: CastOp; readonly value: Value }
  | { readonly kind: 'extract'; readonly value: Value; readonly offset: number }
  | { readonly kind: 'insert'; readonly base: Value; readonly value: Value; readonly offset: number }
  | { readonly kind: 'select'; readonly condition: Value; readonly when_true: Value; readonly when_false: Value }
  | { readonly kind: 'flag'; readonly op: 'add' | 'sub'; readonly flag: ArithmeticFlag; readonly left: Value; readonly right: Value; readonly carry: Value }
  | { readonly kind: 'float'; readonly op: FloatOp; readonly left: Value; readonly right: Value }
  | { readonly kind: 'float_unary'; readonly op: 'neg' | 'abs' | 'sqrt'; readonly value: Value }
  | { readonly kind: 'float_compare'; readonly op: FloatPredicate; readonly left: Value; readonly right: Value }
  | { readonly kind: 'vector'; readonly lanes: readonly Value[] }
  | { readonly kind: 'vector_lane'; readonly vector: Value; readonly lane: number }
  | { readonly kind: 'vector_insert'; readonly vector: Value; readonly value: Value; readonly lane: number }
  | { readonly kind: 'vector_integer'; readonly op: IntegerOp; readonly left: Value; readonly right: Value }
  | { readonly kind: 'vector_float'; readonly op: FloatOp; readonly left: Value; readonly right: Value }
  | { readonly kind: 'indeterminate'; readonly state: 'undefined' | 'unknown'; readonly reason: string };
export interface EffectOrder { readonly effect_in: Effect; readonly effect_out: Effect }
export interface MemoryAccess { readonly endian: 'little' | 'big'; readonly alignment: number; readonly volatile: boolean }
export type CallTarget = { readonly kind: 'direct'; readonly address: Address } | { readonly kind: 'indirect'; readonly value: Value };
export type Instruction =
  | (Origin & { readonly kind: 'assign'; readonly result: Value; readonly expression: Expression })
  | (Origin & EffectOrder & { readonly kind: 'read_register'; readonly result: Value; readonly register: RegisterDescriptor })
  | (Origin & EffectOrder & { readonly kind: 'write_register'; readonly register: RegisterDescriptor; readonly value: Value })
  | (Origin & EffectOrder & { readonly kind: 'load'; readonly result: Value; readonly address: Value; readonly access: MemoryAccess })
  | (Origin & EffectOrder & { readonly kind: 'store'; readonly address: Value; readonly value: Value; readonly access: MemoryAccess })
  | (Origin & EffectOrder & { readonly kind: 'call'; readonly target: CallTarget; readonly arguments: readonly Value[]; readonly results: readonly Value[]; readonly clobbers: CallClobbers; readonly contract_evidence: readonly Evidence['id'][] })
  | (Origin & EffectOrder & { readonly kind: 'unknown_effect'; readonly reason: string; readonly clobbers: CallClobbers });
/** Each edge passes all data parameters simultaneously and the final effect token. */
export interface Edge { readonly target: EntityId; readonly arguments: readonly Value[]; readonly effect: Effect }
export type Terminator = Origin & { readonly effect: Effect } & (
  | { readonly kind: 'jump'; readonly edge: Edge }
  | { readonly kind: 'branch'; readonly condition: Value; readonly when_true: Edge; readonly when_false: Edge }
  | { readonly kind: 'switch'; readonly value: Value; readonly cases: readonly { readonly bits: bigint; readonly edge: Edge }[]; readonly otherwise: Edge }
  | { readonly kind: 'return'; readonly values: readonly Value[] }
  | { readonly kind: 'indirect'; readonly target: Value; readonly reason: string }
  | { readonly kind: 'trap'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string }
);
export interface BasicBlock extends Origin {
  readonly parameters: readonly Value[];
  readonly effect_parameter: Effect;
  readonly instructions: readonly Instruction[];
  readonly terminator: Terminator;
}
export interface FunctionIR extends Origin {
  readonly form: 'register' | 'ssa';
  readonly entry: EntityId;
  readonly returns: readonly DataType[];
  readonly blocks: readonly BasicBlock[];
}
/** Lifter<RegisterIR> is the core integration boundary. */
export interface RegisterIR extends FunctionIR { readonly form: 'register' }
export interface SSAForm extends FunctionIR { readonly form: 'ssa' }
/** T16 supplies construction/optimization; no SSA algorithm is hidden in the lifter. */
export interface SSAConstruction {
  construct(input: RegisterIR, checkpoint: (work: number) => void): SSAForm;
}
export interface RewriteResult<T> { readonly value: T; readonly replaced_ids: readonly EntityId[] }

export const effectType = Object.freeze({ kind: 'effect' } as const);
export function integer(bits: number): IntegerType {
  if (!Number.isInteger(bits) || bits < 1 || bits > 2048) throw new RangeError('Integer width must be 1..2048');
  return { kind: 'integer', bits };
}
export function floating(bits: 32 | 64): FloatType { return { kind: 'float', bits }; }
export function vector(element: IntegerType | FloatType, lanes: number): VectorType {
  const type: VectorType = { kind: 'vector', element, lanes };
  if (!validType(type)) throw new RangeError('Vector must have 1..256 lanes and at most 2048 bits');
  return type;
}
export function bitWidth(type: DataType): number { return type.kind === 'vector' ? type.element.bits * type.lanes : type.bits; }
export function validType(type: IRType): boolean {
  switch (type.kind) {
    case 'effect': return true;
    case 'integer': return Number.isInteger(type.bits) && type.bits >= 1 && type.bits <= 2048;
    case 'float': return type.bits === 32 || type.bits === 64;
    case 'vector': return (type.element.kind === 'integer' || type.element.kind === 'float') && validType(type.element) && Number.isInteger(type.lanes) && type.lanes >= 1 && type.lanes <= 256 && bitWidth(type) <= 2048;
  }
}
export function sameType(a: IRType, b: IRType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'effect') return true;
  if (a.kind === 'vector') return b.kind === 'vector' && a.lanes === b.lanes && sameType(a.element, b.element);
  return b.kind !== 'effect' && b.kind !== 'vector' && a.bits === b.bits;
}
export function expressionOperands(expression: Expression): readonly Value[] {
  switch (expression.kind) {
    case 'constant': case 'address': case 'indeterminate': return [];
    case 'integer': case 'compare': case 'float': case 'float_compare': case 'vector_integer': case 'vector_float': return [expression.left, expression.right];
    case 'integer_unary': case 'cast': case 'extract': case 'float_unary': return [expression.value];
    case 'insert': return [expression.base, expression.value];
    case 'select': return [expression.condition, expression.when_true, expression.when_false];
    case 'flag': return [expression.left, expression.right, expression.carry];
    case 'vector': return expression.lanes;
    case 'vector_lane': return [expression.vector];
    case 'vector_insert': return [expression.vector, expression.value];
  }
}
export function successors(terminator: Terminator): readonly Edge[] {
  switch (terminator.kind) {
    case 'jump': return [terminator.edge];
    case 'branch': return [terminator.when_true, terminator.when_false];
    case 'switch': return [...terminator.cases.map(item => item.edge), terminator.otherwise];
    default: return [];
  }
}
