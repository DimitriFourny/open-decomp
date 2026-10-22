import type {
  Address,
  Arm64Payload,
  DecodedInstruction,
  JumpTableEntryFact,
  LoadedImage,
  OperationContext,
  RegisterDescriptor,
  RegisterFact,
  ResolvedJumpTable,
  X86Payload,
} from '../../core/index.js';
import { recoverDataBytes } from '../strings/source-data.js';

/** Longest single-entry straight-line chain evaluated backward from a branch. */
const MAX_CHAIN = 64;
const U64 = (1n << 64n) - 1n;
const mask = (bits: number): bigint => (1n << BigInt(bits)) - 1n;
/** ARM64 encodings whose only architectural writes are operand 0 and, for the
 * flag-setting (`XS_`) forms, NZCV. */
const DESTINATION_ONLY =
  /^(?:(?:AND|ORR|EOR|BIC|ORN|EON)S?_(?:32|64)S?_log_(?:imm|shift)|(?:ADD|SUB)S?_(?:32|64)S?_addsub_(?:ext|shift)|(?:ADC|SBC)S?_(?:32|64)_addsub_carry|(?:MADD|MSUB)_(?:32|64)A_dp_3src|[SU](?:MADDL|MSUBL|MULH)_64\w*_dp_3src|(?:UDIV|SDIV|LSLV|LSRV|ASRV|RORV)_(?:32|64)_dp_2src|CS(?:EL|INC|INV|NEG)_(?:32|64)_condsel|[SU]?BFM_(?:32|64)M_bitfield|EXTR_(?:32|64)_extract|(?:CLZ|CLS|RBIT|REV|REV16|REV32|ABS|CNT|CTZ)_(?:32|64)_dp_1src|MOVK_(?:32|64)_movewide)$/;

type Node =
  | { readonly k: 'const'; readonly key: string; readonly v: bigint }
  | { readonly k: 'sym'; readonly key: string }
  | { readonly k: 'zext' | 'sext'; readonly key: string; readonly bits: number; readonly a: Node }
  | { readonly k: 'add'; readonly key: string; readonly a: Node; readonly b: Node }
  | { readonly k: 'shl'; readonly key: string; readonly a: Node; readonly n: number }
  | {
      readonly k: 'entry';
      readonly key: string;
      readonly load: DecodedInstruction;
      readonly selector: RegisterDescriptor;
      readonly table: bigint;
      readonly index: Node;
      readonly stride: number;
      readonly bytes: 1 | 2 | 4 | 8;
      readonly signed: boolean;
    };
interface Guard {
  readonly instruction: DecodedInstruction;
  readonly otherwise: Address;
}
interface Bound {
  readonly max: bigint;
  readonly guard: Guard | null;
}
interface Flags {
  readonly width: number;
  readonly lhs: Node;
  readonly rhs: Node;
}
type Relation = '<' | '<=' | '>' | '>=';

/** Hash-consed 64-bit symbolic values over one chain; equal keys are equal values. */
class Values {
  readonly #nodes = new Map<string, Node>();
  #fresh = 0;
  #intern<T extends Node>(node: T): T {
    const known = this.#nodes.get(node.key);
    if (known) return known as T;
    this.#nodes.set(node.key, node);
    return node;
  }

  constant(value: bigint): Node {
    const v = BigInt.asUintN(64, value);
    return this.#intern({ k: 'const', key: `c${v}`, v });
  }

  sym(): Node {
    return this.#intern({ k: 'sym', key: `s${this.#fresh++}` });
  }

  zext(bits: number, a: Node): Node {
    if (bits >= 64) return a;
    if (a.k === 'const') return this.constant(a.v & mask(bits));
    if (a.k === 'zext' && a.bits <= bits) return a;
    if (a.k === 'zext') return this.zext(bits, a.a);
    return this.#intern({ k: 'zext', key: `z${bits}(${a.key})`, bits, a });
  }

  sext(bits: number, a: Node): Node {
    if (bits >= 64) return a;
    if (a.k === 'const') return this.constant(BigInt.asIntN(bits, a.v));
    if ((a.k === 'zext' || a.k === 'sext') && a.bits >= bits) return this.sext(bits, a.a);
    return this.#intern({ k: 'sext', key: `x${bits}(${a.key})`, bits, a });
  }

  add(a: Node, b: Node): Node {
    if (a.k === 'const' && b.k !== 'const') [a, b] = [b, a];
    if (b.k === 'const') {
      if (a.k === 'const') return this.constant(a.v + b.v);
      if (b.v === 0n) return a;
      if (a.k === 'add' && a.b.k === 'const') return this.add(a.a, this.constant(a.b.v + b.v));
    }
    return this.#intern({ k: 'add', key: `+(${a.key},${b.key})`, a, b });
  }

  shl(a: Node, n: number): Node {
    if (n === 0) return a;
    if (n >= 64) return this.constant(0n);
    if (a.k === 'const') return this.constant(a.v << BigInt(n));
    return this.#intern({ k: 'shl', key: `<<(${a.key},${n})`, a, n });
  }

  entry(fields: Omit<Extract<Node, { k: 'entry' }>, 'k' | 'key'>): Node {
    return this.#intern({ k: 'entry', key: `e${fields.load.id}`, ...fields });
  }
}

/** Constant plus shifted variable terms of a modular address sum. */
function affine(node: Node): { c: bigint; terms: { node: Node; shift: number }[] } {
  if (node.k === 'const') return { c: node.v, terms: [] };
  if (node.k === 'add') {
    const a = affine(node.a),
      b = affine(node.b);
    return { c: BigInt.asUintN(64, a.c + b.c), terms: [...a.terms, ...b.terms] };
  }
  if (node.k === 'shl') {
    const a = affine(node.a);
    return {
      c: BigInt.asUintN(64, a.c << BigInt(node.n)),
      terms: a.terms.map((term) => ({ node: term.node, shift: term.shift + node.n })),
    };
  }
  return { c: 0n, terms: [{ node, shift: 0 }] };
}

/** Concrete value of a symbolic target for one table entry; undefined for any unknown input. */
function evaluate(node: Node, entry: bigint): bigint | undefined {
  switch (node.k) {
    case 'const':
      return node.v;
    case 'sym':
      return undefined;
    case 'entry':
      return entry;
    case 'zext': {
      const a = evaluate(node.a, entry);
      return a === undefined ? undefined : a & mask(node.bits);
    }
    case 'sext': {
      const a = evaluate(node.a, entry);
      return a === undefined ? undefined : BigInt.asUintN(64, BigInt.asIntN(node.bits, a));
    }
    case 'add': {
      const a = evaluate(node.a, entry),
        b = evaluate(node.b, entry);
      return a === undefined || b === undefined ? undefined : BigInt.asUintN(64, a + b);
    }
    case 'shl': {
      const a = evaluate(node.a, entry);
      return a === undefined ? undefined : BigInt.asUintN(64, a << BigInt(node.n));
    }
  }
}

/** Distinct table-entry nodes and whether any opaque symbol feeds the value. */
function inputs(node: Node, entries: Map<string, Extract<Node, { k: 'entry' }>>): boolean {
  switch (node.k) {
    case 'const':
      return true;
    case 'sym':
      return false;
    case 'entry':
      entries.set(node.key, node);
      return true;
    case 'zext':
    case 'sext':
    case 'shl':
      return inputs(node.a, entries);
    case 'add':
      return inputs(node.a, entries) && inputs(node.b, entries);
  }
}

export interface JumpTableProofInput {
  readonly image: LoadedImage;
  readonly branch: DecodedInstruction;
  /** Decoded control predecessors (fallthrough and branch edges) by address. */
  readonly incoming: ReadonlyMap<bigint, readonly DecodedInstruction[]>;
  /** Roots have an implicit external predecessor. */
  readonly is_entry: (address: bigint) => boolean;
  readonly executable: (address: bigint) => boolean;
  readonly max_entries: number;
  /** `jumpTableChain` of this same input when the caller already walked it. */
  readonly chain?: readonly DecodedInstruction[];
  /** Register facts at the chain start by root; other roots start opaque. A given state is
   * used as is: no register facts are derived. */
  readonly entry_state?: ReadonlyMap<string, RegisterFact>;
  /** Full-width integer roots every call preserves (the image ABI's callee-saved registers).
   * Without them a call forgets every register fact. */
  readonly preserved_registers?: ReadonlySet<string>;
}
export type JumpTableProof = Omit<ResolvedJumpTable, 'evidence_ids'>;

/** The longest single-entry straight-line chain of decoded instructions ending at the branch:
 * every member after the first has exactly one decoded predecessor, the previous member, and is
 * no root. A proof is a function of this chain alone, so callers re-prove exactly when it
 * changes (a member gains a predecessor or becomes a root, or the first member gains its first
 * predecessor). */
export function jumpTableChain(
  input: Pick<JumpTableProofInput, 'branch' | 'incoming' | 'is_entry'>,
  context: OperationContext,
): DecodedInstruction[] {
  const chain: DecodedInstruction[] = [input.branch];
  for (let current = input.branch; chain.length < MAX_CHAIN;) {
    context.checkpoint(1);
    if (input.is_entry(current.address.value)) break;
    const predecessors = input.incoming.get(current.address.value) ?? [];
    if (predecessors.length !== 1) break;
    const previous = predecessors[0]!;
    if (
      chain.includes(previous) ||
      previous.validity !== 'valid' ||
      (previous.flow.kind !== 'fallthrough' && previous.flow.kind !== 'branch')
    )
      break;
    chain.unshift(previous);
    current = previous;
  }
  return chain;
}

/** ARM64 encodings whose register writes their operands do not name (pointer authentication
 * and other hints writing x16, x17 or x30; exception generation): the register-fact transfer
 * forgets every value there. */
const ARM64_WRITES_UNNAMED = /^(?:PAC|AUT|XPAC|CHKFEAT|HINT_)|_exception$/;
/** An opaque (presentation-only) ARM64 operand naming a general register, such as a
 * post-indexed `[xN], #imm` list address: whatever it writes is unnamed too. Opaque
 * immediates and FP/SIMD registers name no general register. */
const GENERAL_REGISTER_TEXT = /\b(?:[xw](?:\d+|zr)|w?sp)\b/i;

interface Stepper {
  readonly registers: ReadonlyMap<string, Node>;
  /** The value each root had at the start, for roots seeded or read before any write. */
  readonly initial: ReadonlyMap<string, Node>;
  /** Opaque results of indexed loads that selected no table entry, with their address inputs. */
  readonly indexed: ReadonlyMap<string, readonly Node[]>;
  /** Guard bounds by value key. */
  readonly facts: ReadonlyMap<string, Bound>;
  seed(root: string, fact: RegisterFact | undefined): Node;
  read(register: RegisterDescriptor): Node;
  bound(node: Node): Bound;
  /** The register fact a value satisfies, or undefined for an unconstrained one. */
  fact(node: Node): RegisterFact | undefined;
  x86Load(
    instruction: DecodedInstruction,
    memory: X86Payload['memory'][number],
    signed: boolean,
  ): Node | undefined;
  step(instruction: DecodedInstruction, payload: Arm64Payload | X86Payload): void;
  /** The bound a conditional branch establishes on the edge to `next`. */
  guardFact(instruction: DecodedInstruction, next: DecodedInstruction): void;
}

/** The prover's exact evaluators over one symbolic register, slot and flag state.
 *
 * Only exact integer moves, add/sub/shift/extension, PC-relative constants, compare flags and
 * nonvolatile stack/register slot forwarding are modeled; any other instruction forgets every
 * register, flag and slot it may change. An ARM64 payload lists no register accesses: the
 * prover forgets every value there, the register-fact transfer (`precise`) only the registers
 * the instruction names (every register operand and a written-back base). */
function createStepper(precise: boolean): Stepper {
  const values = new Values();
  const registers = new Map<string, Node>();
  const initial = new Map<string, Node>();
  const indexed = new Map<string, readonly Node[]>();
  const slots = new Map<string, { base: string; offset: bigint; size: number; value: Node }>();
  const facts = new Map<string, Bound>();
  const forgotten = new Set<string>();
  let cleared = false;
  let flags: Flags | null = null;

  /** Start a root from a fact (opaque without one). */
  const seed = (root: string, fact: RegisterFact | undefined): Node => {
    const node = !fact
      ? values.sym()
      : fact.kind === 'const'
        ? values.constant(fact.value)
        : values.zext(fact.bits, values.sym());
    registers.set(root, node);
    initial.set(root, node);
    return node;
  };
  const read = (register: RegisterDescriptor): Node => {
    if (register.role === 'zero') return values.constant(0n);
    if (register.offset_bits !== 0) return values.sym();
    let root = registers.get(register.root);
    if (!root) {
      root = values.sym();
      registers.set(register.root, root);
      if (!cleared && !forgotten.has(register.root)) initial.set(register.root, root);
    }
    return values.zext(register.width_bits, root);
  };
  const forget = (root: string): void => {
    registers.delete(root);
    forgotten.add(root);
  };
  const write = (register: RegisterDescriptor, value: Node): void => {
    if (register.role === 'zero' || register.write_rule === 'discard') return;
    if (register.offset_bits === 0 && register.width_bits === register.root_width_bits)
      registers.set(register.root, value);
    else if (register.offset_bits === 0 && register.write_rule === 'zero_extend_root')
      registers.set(register.root, values.zext(register.width_bits, value));
    else forget(register.root);
  };
  const reset = (): void => {
    registers.clear();
    slots.clear();
    flags = null;
    cleared = true;
  };
  const unmodeled = (payload: Arm64Payload): void => {
    if (!precise) return reset();
    for (const operand of payload.operands)
      if (operand.kind === 'register') forget(operand.register.root);
      else if (
        (operand.kind === 'memory' || operand.kind === 'scalable_memory') &&
        operand.writeback !== 'none' &&
        'root' in operand.base
      )
        forget(operand.base.root);
    slots.clear();
    flags = null;
  };
  const bound = (node: Node): Bound => {
    let structural: Bound = { max: U64, guard: null };
    if (node.k === 'const') structural = { max: node.v, guard: null };
    else if (node.k === 'zext') {
      const inner = bound(node.a);
      structural = inner.max <= mask(node.bits) ? inner : { max: mask(node.bits), guard: null };
    } else if (node.k === 'sext') {
      const low = bound(values.zext(node.bits, node.a));
      if (low.max < 1n << BigInt(node.bits - 1)) structural = low;
    } else if (node.k === 'add' && node.b.k === 'const' && node.b.v < 1n << 63n) {
      const inner = bound(node.a);
      if (inner.max + node.b.v <= U64)
        structural = { max: inner.max + node.b.v, guard: inner.guard };
    }
    const fact = facts.get(node.key);
    if (!fact) return structural;
    return fact.max <= structural.max
      ? fact
      : { max: structural.max, guard: structural.guard ?? fact.guard };
  };
  /** Memory value at an address: a bounded table entry, a forwarded slot or a fresh value. */
  const load = (
    instruction: DecodedInstruction,
    address: Node,
    size: number,
    signed: boolean,
    selector: {
      readonly register: RegisterDescriptor;
      readonly node: Node;
      readonly shift: number;
    } | null,
  ): Node => {
    const sum = affine(address);
    if (
      selector &&
      sum.terms.length === 1 &&
      sum.terms[0]!.node.key === selector.node.key &&
      sum.terms[0]!.shift === selector.shift &&
      bound(selector.node).guard &&
      (size === 1 || size === 2 || size === 4 || size === 8)
    )
      return values.entry({
        load: instruction,
        selector: selector.register,
        table: sum.c,
        index: selector.node,
        stride: 2 ** selector.shift,
        bytes: size,
        signed,
      });
    const base = sum.terms.map((term) => `${term.node.key}<<${term.shift}`).join('|');
    const slot = slots.get(`${base}@${sum.c}:${size}`);
    let raw = slot?.value;
    if (!raw) {
      const opaque = values.sym();
      if (selector) indexed.set(opaque.key, [address, selector.node]);
      raw = values.zext(size * 8, opaque);
    }
    return signed ? values.sext(size * 8, raw) : raw;
  };
  const store = (address: Node | undefined, size: number, value: Node): void => {
    if (!address) {
      slots.clear();
      return;
    }
    const sum = affine(address);
    const base = sum.terms.map((term) => `${term.node.key}<<${term.shift}`).join('|');
    const end = sum.c + BigInt(size);
    for (const [key, slot] of slots)
      if (slot.base !== base || (slot.offset < end && slot.offset + BigInt(slot.size) > sum.c))
        slots.delete(key);
    slots.set(`${base}@${sum.c}:${size}`, {
      base,
      offset: sum.c,
      size,
      value: values.zext(size * 8, value),
    });
  };

  const arm64 = (instruction: DecodedInstruction, payload: Arm64Payload): void => {
    const encoding = payload.canonical_encoding,
      operands = payload.operands,
      fields = payload.fields;
    const register = (index: number): RegisterDescriptor | undefined => {
      const operand = operands[index];
      return operand?.kind === 'register' && operand.register.bank === 'integer'
        ? operand.register
        : undefined;
    };
    if (payload.behavior === 'nop' || encoding.startsWith('NOP_')) return;
    const d = register(0),
      n = register(1),
      m = register(2);
    const width = encoding.includes('_64') ? 64 : 32;
    const lhs = (node: Node): Node => values.zext(width, node);
    let match: RegExpExecArray | null;
    if (
      payload.alias === 'MOV_ORR_log_shift' &&
      operands.length === 2 &&
      d &&
      n &&
      fields.imm6 === 0n
    ) {
      write(d, read(n));
      return;
    }
    if ((match = /^(ADD|SUB)(S?)_(?:32|64)S?_addsub_imm$/.exec(encoding)) && d && n) {
      const immediate = (fields.imm12 ?? 0n) << (fields.sh ? 12n : 0n);
      const source = read(n);
      if (match[2])
        flags =
          match[1] === 'SUB' ? { width, lhs: lhs(source), rhs: values.constant(immediate) } : null;
      write(d, values.add(source, values.constant(match[1] === 'SUB' ? -immediate : immediate)));
      return;
    }
    if ((match = /^(ADD|SUB)(S?)_(?:32|64)S?_addsub_shift$/.exec(encoding)) && d && n && m) {
      const amount = Number(fields.imm6 ?? 0n);
      const plain = (fields.shift ?? 0n) === 0n;
      const rhs = plain ? values.shl(read(m), amount) : values.sym();
      const source = read(n);
      if (match[2])
        flags = match[1] === 'SUB' && plain ? { width, lhs: lhs(source), rhs: lhs(rhs) } : null;
      write(
        d,
        match[1] === 'ADD'
          ? values.add(source, rhs)
          : rhs.k === 'const'
            ? values.add(source, values.constant(-rhs.v))
            : values.sym(),
      );
      return;
    }
    if ((match = /^(ADD|SUB)_(?:32|64)_addsub_ext$/.exec(encoding)) && d && n && m) {
      const option = Number(fields.option ?? 0n),
        amount = Number(fields.imm3 ?? 0n);
      const raw = read(m);
      const extended =
        option === 3 || option === 7
          ? raw
          : option < 3
            ? values.zext(8 << option, raw)
            : values.sext(8 << (option - 4), raw);
      const rhs = values.shl(extended, amount);
      write(
        d,
        match[1] === 'ADD'
          ? values.add(read(n), rhs)
          : rhs.k === 'const'
            ? values.add(read(n), values.constant(-rhs.v))
            : values.sym(),
      );
      return;
    }
    if (/^MOV[ZN]_(?:32|64)_movewide$/.test(encoding) && d) {
      const value = (fields.imm16 ?? 0n) << ((fields.hw ?? 0n) * 16n);
      write(d, values.constant(encoding.startsWith('MOVN') ? ~value & mask(width) : value));
      return;
    }
    if (encoding === 'ADR_only_pcreladdr' || encoding === 'ADRP_only_pcreladdr') {
      const relative = operands[1];
      if (d && relative?.kind === 'relative') {
        write(d, values.constant(relative.target.value));
        return;
      }
    }
    if (/^[US]BFM_(?:32|64)M_bitfield$/.test(encoding) && d && n && fields.immr === 0n) {
      const top = Number(fields.imms ?? 0n) + 1;
      if (top === 8 || top === 16 || (top === 32 && width === 64)) {
        write(d, encoding.startsWith('U') ? values.zext(top, read(n)) : values.sext(top, read(n)));
        return;
      }
    }
    const memory = operands.find((operand) => operand.kind === 'memory');
    const isLoad = /^LDU?R(S?)(B|H|W)?_/.exec(encoding);
    const isStore = /^STU?R(B|H)?_/.test(encoding);
    if (memory?.kind === 'memory' && d && (isLoad || isStore)) {
      const size = memory.access_bits / 8;
      if (memory.index && memory.writeback !== 'none') return unmodeled(payload);
      const base = read(memory.base);
      let address =
        memory.writeback === 'post' ? base : values.add(base, values.constant(memory.displacement));
      let selector: Parameters<typeof load>[4] = null;
      if (memory.index) {
        const index = read(memory.index);
        const node =
          memory.extend === 'sxtw'
            ? values.sext(32, index)
            : memory.extend === 'uxtw'
              ? values.zext(32, index)
              : index;
        address = values.add(address, values.shl(node, memory.shift));
        selector = { register: memory.index, node, shift: memory.shift };
      }
      if (isLoad) write(d, load(instruction, address, size, isLoad[1] === 'S', selector));
      else store(address, size, read(d));
      if (memory.writeback !== 'none')
        write(memory.base, values.add(base, values.constant(memory.displacement)));
      return;
    }
    // Data processing writing only its destination (and NZCV in S forms): that
    // register becomes opaque, a low-bit mask keeps its exact bound.
    if (DESTINATION_ONLY.test(encoding) && d) {
      const immediate = operands[2];
      const low =
        encoding.startsWith('AND_') && n && immediate?.kind === 'immediate'
          ? immediate.value + 1n
          : 0n;
      write(
        d,
        low > 1n && (low & (low - 1n)) === 0n
          ? values.zext(low.toString(2).length - 1, read(n!))
          : values.sym(),
      );
      if (/^[A-Z]+S_/.test(encoding)) flags = null;
      return;
    }
    unmodeled(payload);
  };

  const x86Address = (memory: X86Payload['memory'][number]): Node | undefined => {
    if (memory.address_bits !== 64 || (memory.segment && /:(fs|gs)$/i.test(memory.segment.id)))
      return undefined;
    if (memory.rip_relative_target) return values.constant(memory.rip_relative_target.value);
    let sum = values.constant(memory.displacement);
    if (memory.base) sum = values.add(read(memory.base), sum);
    if (memory.index)
      sum = values.add(sum, values.shl(read(memory.index), Math.log2(memory.scale)));
    return sum;
  };
  /** Memory operand value; an indexed operand may select a bounded table entry. */
  const x86Load = (
    instruction: DecodedInstruction,
    memory: X86Payload['memory'][number],
    signed: boolean,
  ): Node | undefined => {
    const location = x86Address(memory);
    if (!location) return undefined;
    const selector = memory.index
      ? { register: memory.index, node: read(memory.index), shift: Math.log2(memory.scale) }
      : null;
    return load(instruction, location, memory.access_bits / 8, signed, selector);
  };
  const x86 = (instruction: DecodedInstruction, payload: X86Payload): void => {
    const mnemonic = payload.mnemonic.toLowerCase(),
      operands = payload.operands;
    const writesFlags =
      (payload.flags.written |
        payload.flags.cleared |
        payload.flags.set |
        payload.flags.undefined) !==
      0n;
    /** Integer source operand value of the given width. */
    const source = (
      operand: X86Payload['operands'][number] | undefined,
      signed = false,
    ): Node | undefined => {
      if (operand?.kind === 'register' && operand.register.bank === 'integer') {
        const value = read(operand.register);
        return signed ? values.sext(operand.register.width_bits, value) : value;
      }
      if (operand?.kind === 'immediate')
        return values.constant(operand.value & mask(operand.effective_bits));
      if (operand?.kind === 'memory') return x86Load(instruction, operand.memory, signed);
      return undefined;
    };
    const dest = operands[0],
      second = operands[1];
    const destination =
      dest?.kind === 'register' && dest.register.bank === 'integer' ? dest.register : undefined;
    let next: Flags | null | undefined;
    let handled = false;
    if (mnemonic === 'nop' || mnemonic === 'endbr64') return;
    if (mnemonic === 'mov' && destination) {
      const value = source(second);
      if (value) {
        write(destination, value);
        handled = true;
      }
    } else if (
      mnemonic === 'mov' &&
      dest?.kind === 'memory' &&
      (second?.kind === 'register' || second?.kind === 'immediate')
    ) {
      const value = source(second);
      if (value) {
        store(x86Address(dest.memory), dest.memory.access_bits / 8, value);
        handled = true;
      }
    } else if (
      (mnemonic === 'movzx' || mnemonic === 'movsx' || mnemonic === 'movsxd') &&
      destination
    ) {
      const value = source(second, mnemonic !== 'movzx');
      if (value) {
        write(destination, value);
        handled = true;
      }
    } else if (mnemonic === 'lea' && destination && second?.kind === 'memory') {
      write(destination, x86Address(second.memory) ?? values.sym());
      handled = true;
    } else if (
      mnemonic === 'and' &&
      destination &&
      second?.kind === 'immediate' &&
      (((second.value & mask(destination.width_bits)) + 1n) &
        (second.value & mask(destination.width_bits))) ===
        0n
    ) {
      // A low-bit mask (2^k - 1) keeps an exact bound; an empty mask is zero.
      const low = second.value & mask(destination.width_bits);
      write(destination, values.zext(low ? low.toString(2).length : 0, read(destination)));
      next = null;
      handled = true;
    } else if ((mnemonic === 'add' || mnemonic === 'sub' || mnemonic === 'cmp') && destination) {
      const left = read(destination),
        right = source(second);
      if (right) {
        next = mnemonic === 'add' ? null : { width: destination.width_bits, lhs: left, rhs: right };
        if (mnemonic === 'add') write(destination, values.add(left, right));
        else if (mnemonic === 'sub')
          write(
            destination,
            right.k === 'const' ? values.add(left, values.constant(-right.v)) : values.sym(),
          );
        handled = true;
      }
    }
    if (!handled) {
      for (const access of payload.registers)
        if (
          access.access !== 'read' &&
          access.access !== 'none' &&
          access.access !== 'conditional_read'
        )
          forget(access.register.root);
      if (payload.memory.some((memory) => memory.access !== 'read' && memory.access !== 'none'))
        slots.clear();
    }
    if (next !== undefined) flags = next;
    else if (writesFlags) flags = null;
  };

  const guardFact = (instruction: DecodedInstruction, next: DecodedInstruction): void => {
    const flow = instruction.flow;
    if (flow.kind !== 'branch' || !flow.conditional || !flow.fallthrough) return;
    const taken = flow.target.value === next.address.value;
    if (taken === (flow.fallthrough.value === next.address.value)) return;
    const payload = instruction.payload;
    let relation: Relation | undefined;
    if (payload?.architecture === 'arm64' && payload.canonical_encoding === 'B_only_condbranch') {
      const condition = payload.operands.find((operand) => operand.kind === 'condition');
      if (condition?.kind === 'condition')
        relation = ({ 2: '>=', 3: '<', 8: '>', 9: '<=' } as const)[condition.code as 2 | 3 | 8 | 9];
    } else if (payload?.architecture === 'x86_64')
      relation = (
        {
          ja: '>',
          jnbe: '>',
          jae: '>=',
          jnb: '>=',
          jnc: '>=',
          jb: '<',
          jc: '<',
          jnae: '<',
          jbe: '<=',
          jna: '<=',
        } as const
      )[payload.mnemonic.toLowerCase() as 'ja'];
    const current = flags as Flags | null;
    if (!relation || !current || current.rhs.k !== 'const') return;
    const edge: Relation = taken
      ? relation
      : ({ '>': '<=', '>=': '<', '<': '>=', '<=': '>' } as const)[relation];
    const limit = current.rhs.v & mask(current.width);
    const max = edge === '<=' ? limit : edge === '<' && limit > 0n ? limit - 1n : undefined;
    if (max === undefined) return;
    const known = facts.get(current.lhs.key);
    if (!known || max < known.max)
      facts.set(current.lhs.key, {
        max,
        guard: { instruction, otherwise: taken ? flow.fallthrough : flow.target },
      });
  };

  return {
    registers,
    initial,
    indexed,
    facts,
    seed,
    read,
    bound,
    fact(node) {
      if (node.k === 'const') return { kind: 'const', value: node.v };
      const max = bound(node).max;
      if (max === 0n) return { kind: 'const', value: 0n };
      const bits = max.toString(2).length;
      return bits < 64 ? { kind: 'zext', bits } : undefined;
    },
    x86Load,
    step(instruction, payload) {
      if (payload.architecture === 'arm64') arm64(instruction, payload);
      else x86(instruction, payload);
    },
    guardFact,
  };
}

/** Evaluate the chain from `entry`: the proof, or else the roots whose start values a
 * register fact could supply (`neededRoots`). */
function evaluateChain(
  input: JumpTableProofInput,
  chain: readonly DecodedInstruction[],
  entry: ReadonlyMap<string, RegisterFact> | undefined,
  context: OperationContext,
): { readonly proof?: JumpTableProof; readonly needed: ReadonlySet<string> } {
  const { image, branch } = input;
  const none = { needed: new Set<string>() };
  const state = createStepper(false);
  for (const [root, fact] of entry ?? []) state.seed(root, fact);
  let target: Node | undefined;
  for (let index = 0; index < chain.length; index++) {
    context.checkpoint(1);
    const instruction = chain[index]!,
      payload = instruction.payload;
    if (!payload || payload.architecture !== image.target.architecture) return none;
    if (instruction === branch) {
      if (payload.architecture === 'arm64') {
        const operand = payload.operands[0];
        if (payload.canonical_encoding !== 'BR_64_branch_reg' || operand?.kind !== 'register')
          return none;
        target = state.read(operand.register);
      } else {
        const operand = payload.operands[0];
        if (payload.mnemonic.toLowerCase() !== 'jmp') return none;
        if (operand?.kind === 'register') target = state.read(operand.register);
        else if (operand?.kind === 'memory' && operand.memory.access_bits === 64)
          target = state.x86Load(instruction, operand.memory, false);
      }
      break;
    }
    if (instruction.flow.kind === 'branch') {
      if (instruction.flow.conditional) state.guardFact(instruction, chain[index + 1]!);
      continue;
    }
    state.step(instruction, payload);
  }
  if (!target) return none;
  const entries = new Map<string, Extract<Node, { k: 'entry' }>>();
  if (!inputs(target, entries) || entries.size !== 1) return { needed: neededRoots(state, target) };
  const selected = [...entries.values()][0]!;
  const limit = state.bound(selected.index);
  if (!limit.guard || limit.max >= BigInt(input.max_entries))
    return { needed: neededRoots(state, target) };
  const count = Number(limit.max) + 1;
  const length = (count - 1) * selected.stride + selected.bytes;
  const table: Address = { image_id: image.id, space: 'va', value: selected.table };
  const bytes = recoverDataBytes(image, table, length, context);
  if (!bytes) return none;
  const targets: Address[] = [];
  for (let index = 0; index < count; index++) {
    context.checkpoint(1);
    let raw = 0n;
    for (let byte = selected.bytes - 1; byte >= 0; byte--)
      raw = (raw << 8n) | BigInt(bytes[index * selected.stride + byte]!);
    const value = selected.signed
      ? BigInt.asUintN(64, BigInt.asIntN(selected.bytes * 8, raw))
      : raw;
    const destination = evaluate(target, value);
    if (
      destination === undefined ||
      !input.executable(destination) ||
      (image.target.architecture === 'arm64' && destination % 4n !== 0n)
    )
      return none;
    targets.push({ image_id: image.id, space: 'va', value: destination });
  }
  return {
    proof: {
      branch: branch.id,
      selector: { instruction: selected.load.id, register: selected.selector },
      table: { start: table, size: BigInt(length) },
      entry: { bytes: selected.bytes, signed: selected.signed, stride: selected.stride },
      targets,
      guard: limit.guard.instruction.id,
      otherwise: limit.guard.otherwise,
      // The bound is the guard's own fact on the index value itself.
      guard_exact: state.facts.get(selected.index.key) === limit,
      chain: chain.map((instruction) => instruction.id),
    },
    needed: none.needed,
  };
}

/** Roots whose start values feed a failed target through an indexed load: the load's base or
 * index, or a value combined with the loaded entry. Empty when no indexed load feeds it, as for
 * a plain register branch, where no start value can make a table. */
function neededRoots(state: Stepper, target: Node): Set<string> {
  const roots = new Map([...state.initial].map(([root, node]) => [node.key, root]));
  const needed = new Set<string>();
  const seen = new Set<string>();
  let indexed = false;
  const visit = (node: Node): void => {
    if (seen.has(node.key)) return;
    seen.add(node.key);
    switch (node.k) {
      case 'const':
        return;
      case 'sym': {
        const root = roots.get(node.key);
        if (root) needed.add(root);
        const address = state.indexed.get(node.key);
        if (address) {
          indexed = true;
          address.forEach(visit);
        }
        return;
      }
      case 'entry':
        indexed = true;
        return visit(node.index);
      case 'add':
        visit(node.a);
        return visit(node.b);
      default:
        return visit(node.a);
    }
  };
  visit(target);
  return indexed ? needed : new Set();
}

/** A register's value on the paths reaching an instruction, with the instructions defining it
 * and the calls it survives; `value: null` is unknown (⊤). */
interface FactCell {
  readonly value: RegisterFact | null;
  readonly definitions: readonly DecodedInstruction[];
  readonly calls: readonly DecodedInstruction[];
}
const UNKNOWN: FactCell = { value: null, definitions: [], calls: [] };

/** Width of the narrowest zero extension a fact satisfies. */
const factBits = (fact: RegisterFact): number =>
  fact.kind === 'zext' ? fact.bits : fact.value === 0n ? 0 : fact.value.toString(2).length;
function union(
  a: readonly DecodedInstruction[],
  b: readonly DecodedInstruction[],
): readonly DecodedInstruction[] {
  const extra = b.filter((item) => !a.includes(item));
  return extra.length ? [...a, ...extra] : a;
}
/** Least upper bound: equal constants stay, otherwise the wider zero extension (64 bits is ⊤). */
function joinCell(a: FactCell, b: FactCell): FactCell {
  if (!a.value) return a;
  if (!b.value) return b;
  let value: RegisterFact | null = a.value;
  if (a.value.kind !== 'const' || b.value.kind !== 'const' || a.value.value !== b.value.value) {
    const bits = Math.max(factBits(a.value), factBits(b.value));
    value =
      a.value.kind === 'zext' && a.value.bits === bits
        ? a.value
        : bits < 64
          ? { kind: 'zext', bits }
          : null;
  }
  if (!value) return UNKNOWN;
  const definitions = union(a.definitions, b.definitions),
    calls = union(a.calls, b.calls);
  return value === a.value && definitions === a.definitions && calls === a.calls
    ? a
    : { value, definitions, calls };
}

/** Whether an instruction may write a root: x86 from its exact register accesses, ARM64 from
 * every register operand and a written-back base. */
function writes(payload: Arm64Payload | X86Payload, root: string): boolean {
  if (payload.architecture === 'x86_64')
    return payload.registers.some(
      (access) =>
        access.register.root === root &&
        access.access !== 'read' &&
        access.access !== 'none' &&
        access.access !== 'conditional_read',
    );
  return payload.operands.some(
    (operand) =>
      (operand.kind === 'register' && operand.register.root === root) ||
      ((operand.kind === 'memory' || operand.kind === 'scalable_memory') &&
        operand.writeback !== 'none' &&
        'root' in operand.base &&
        operand.base.root === root),
  );
}
/** Whether a written value may depend on the root's previous value (it keeps its provenance). */
function reads(payload: Arm64Payload | X86Payload, root: string): boolean {
  if (payload.architecture === 'x86_64')
    return payload.registers.some(
      (access) => access.register.root === root && access.access.includes('read'),
    );
  return payload.operands.some(
    (operand, index) =>
      (operand.kind === 'register' && index > 0 && operand.register.root === root) ||
      (operand.kind === 'memory' && (operand.base.root === root || operand.index?.root === root)),
  );
}

/** Facts on `needed` roots at `start` that hold on every decoded path into it: a forward
 * must-dataflow over the decoded instructions reaching `start` (its backward closure over
 * `incoming`, which includes proved table edges), where roots start unknown. Lattice
 * ⊥ / constant / zero-extended from k bits / ⊤. The transfer is the prover's own stepper,
 * forgetting what an instruction may write; a call keeps only `preserved_registers` (none
 * without them). Roots at ⊥ (no root reaches `start`) or ⊤ have no fact. */
function registerFacts(
  input: JumpTableProofInput,
  start: DecodedInstruction,
  needed: ReadonlySet<string>,
  context: OperationContext,
): JumpTableEntryFact[] {
  if (input.is_entry(start.address.value)) return [];
  const roots = [...needed].sort();
  const successors = new Map<DecodedInstruction, DecodedInstruction[]>();
  const entries: DecodedInstruction[] = [];
  const seen = new Set([start]);
  for (const stack = [start]; stack.length;) {
    context.checkpoint(1);
    const current = stack.pop()!;
    if (input.is_entry(current.address.value)) {
      entries.push(current);
      continue;
    }
    for (const previous of input.incoming.get(current.address.value) ?? []) {
      const list = successors.get(previous);
      if (list) list.push(current);
      else successors.set(previous, [current]);
      if (!seen.has(previous)) {
        seen.add(previous);
        stack.push(previous);
      }
    }
  }
  const unknown = roots.map(() => UNKNOWN);
  const architecture = input.image.target.architecture;
  const transfer = (
    instruction: DecodedInstruction,
    state: readonly FactCell[],
  ): readonly FactCell[] => {
    const payload = instruction.payload,
      flow = instruction.flow;
    if (!payload || payload.architecture !== architecture || flow.kind === 'unknown')
      return unknown;
    if (flow.kind === 'call')
      return state.map((cell, index) =>
        cell.value && input.preserved_registers?.has(roots[index]!)
          ? { ...cell, calls: union(cell.calls, [instruction]) }
          : UNKNOWN,
      );
    if (payload.architecture === 'arm64') {
      if (
        payload.behavior === 'unknown' ||
        payload.behavior === 'undefined' ||
        ARM64_WRITES_UNNAMED.test(payload.canonical_encoding) ||
        payload.operands.some(
          (operand) => operand.kind === 'opaque' && GENERAL_REGISTER_TEXT.test(operand.text),
        )
      )
        return unknown;
      // ARM64 branches and returns write no general register (calls are handled above).
      if (flow.kind === 'branch' || flow.kind === 'indirect_branch' || flow.kind === 'return')
        return state;
    }
    const written = roots.map((root) => writes(payload, root));
    if (!written.includes(true)) return state;
    const stepper = createStepper(true);
    const seeded = roots.map((root, index) => stepper.seed(root, state[index]!.value ?? undefined));
    stepper.step(instruction, payload);
    return state.map((cell, index) => {
      const node = stepper.registers.get(roots[index]!);
      if (!written[index] || node === seeded[index]) return cell;
      const value = node && stepper.fact(node);
      if (!value) return UNKNOWN;
      return cell.value && reads(payload, roots[index]!)
        ? { value, definitions: union(cell.definitions, [instruction]), calls: cell.calls }
        : { value, definitions: [instruction], calls: [] };
    });
  };
  const states = new Map<DecodedInstruction, readonly FactCell[]>();
  const queue: DecodedInstruction[] = [];
  const queued = new Set<DecodedInstruction>();
  for (const entry of entries) {
    states.set(entry, unknown);
    queue.push(entry);
    queued.add(entry);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    context.checkpoint(1);
    const instruction = queue[cursor]!;
    queued.delete(instruction);
    const out = transfer(instruction, states.get(instruction)!);
    for (const next of successors.get(instruction) ?? []) {
      const before = states.get(next);
      let after = out;
      if (before) {
        const joined = before.map((cell, index) => joinCell(cell, out[index]!));
        after = joined.every((cell, index) => cell === before[index]) ? before : joined;
      }
      if (after === before) continue;
      states.set(next, after);
      if (!queued.has(next)) {
        queued.add(next);
        queue.push(next);
      }
    }
  }
  const order = (a: DecodedInstruction, b: DecodedInstruction): number =>
    a.address.value < b.address.value ? -1 : a.address.value > b.address.value ? 1 : 0;
  return (states.get(start) ?? []).flatMap((cell, index) =>
    cell.value
      ? [
          {
            register: roots[index]!,
            value: cell.value,
            definitions: [...cell.definitions].sort(order).map((item) => item.id),
            calls: [...cell.calls].sort(order).map((item) => item.id),
          },
        ]
      : [],
  );
}

/** Prove the complete target set of one indirect branch, or return undefined.
 *
 * Evaluates the `jumpTableChain` ending at the branch with the stepper's exact evaluators.
 * Values start opaque at the chain start, or from `entry_state`. The branch target must be a
 * function of exactly one load from a constant table base plus a stride-scaled index whose
 * unsigned maximum is established by a conditional branch on the chain (an unsigned compare of
 * that very index value against a constant) and whose entries lie in immutable file-backed
 * bytes free of relocations. Every computed target must be executable (and aligned on ARM64).
 *
 * Without `entry_state`, a target that fails only for start values feeding an indexed load
 * (its table base, its index, or a base combined with the entry) is evaluated once more from
 * the `registerFacts` on exactly those roots, recorded as `entry_facts`. Callers must re-check
 * that the chain stays single-entry in the final graph, that targets decode there and that
 * `entry_facts` still hold on the final graph's predecessors.
 */
export function proveJumpTable(
  input: JumpTableProofInput,
  context: OperationContext,
): JumpTableProof | undefined {
  const chain = input.chain ?? jumpTableChain(input, context);
  if (chain.length < 3) return undefined;
  const first = evaluateChain(input, chain, input.entry_state, context);
  if (first.proof || input.entry_state || !first.needed.size) return first.proof;
  const known = registerFacts(input, chain[0]!, first.needed, context);
  if (!known.length) return undefined;
  const { proof } = evaluateChain(
    input,
    chain,
    new Map(known.map((fact) => [fact.register, fact.value])),
    context,
  );
  return proof && { ...proof, entry_facts: known };
}
