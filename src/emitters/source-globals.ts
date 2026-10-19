import type { AbiProfile, Address, OperationContext } from '../core/index.js';
import { describeVariableType, type VariableType } from '../metadata/library-contracts/variables.js';
import { bitWidth, type DataType, type Instruction, type Value } from '../ir/index.js';
import type { Reconstruction } from '../reconstruction/model.js';
import type { SourceAddress } from '../reconstruction/source-model.js';

/** One image-backed or import-bound object the function names. Declaration shape
 * follows only the accesses observed in this function; its extent stays unknown
 * unless the image established one, and a use never invents an array bound. */
export interface GlobalObject {
  /** Stable identity: the object's base VA, or the imported symbol. */
  readonly key: string;
  readonly address: Address;
  readonly object: NonNullable<SourceAddress['object']>;
  readonly import?: NonNullable<SourceAddress['import']>;
  /** Preferred C identifier stem; native names use their C spelling. */
  readonly stem: string;
  /** Native linkage name, kept in identifier metadata. */
  readonly native_name?: string;
  /** `scalar`: one element at offset 0; `array`: unbounded elements of one
   * scalar type; `bytes`: bytes, every access an explicit cast dereference. */
  shape: 'scalar' | 'array' | 'bytes';
  element: { readonly bits: 8 | 16 | 32 | 64; readonly float: boolean };
  /** First planned access, for provenance of the declaration. */
  first?: string;
  /** Header-declared type of an imported data object, when every observed access
   * agrees with it: one scalar element at offset 0 of exactly its width and kind
   * (a pointer object is only read). Otherwise the object keeps its access type. */
  declared?: {
    readonly type: VariableType;
    readonly constant: boolean;
    readonly source: string;
  };
}
export interface GlobalAccess {
  readonly object: GlobalObject;
  /** Byte displacement from the object base. */
  readonly offset: bigint;
}
export interface GlobalPlan {
  /** Loads and stores printed as the object itself (`name`, `name[i]`). */
  readonly accesses: ReadonlyMap<string, GlobalAccess>;
  /** Pointer-width reads of an import slot: the imported symbol's address. */
  readonly import_loads: ReadonlyMap<string, GlobalObject>;
  /** Their results, by value id. */
  readonly import_values: ReadonlyMap<string, GlobalObject>;
  /** The storage an address constant lies in, created on first request. */
  object(item: SourceAddress): GlobalObject | undefined;
}

const hex = (value: bigint): string => value.toString(16);
const keyOf = (address: Address): string => `${address.image_id}:${address.space}:${address.value}`;
const WIDTHS = new Set([8, 16, 32, 64]);

/** Bind each retained scalar memory access to the global it touches, directly
 * or through a loader import slot, and choose how each global is declared. */
export function planGlobals(
  program: Reconstruction,
  context: OperationContext,
  options: {
    readonly data: (value: Value) => SourceAddress | undefined;
    readonly uncast: (value: Value) => Value;
    readonly access_type: (node: Extract<Instruction, { kind: 'load' | 'store' }>) => DataType;
    /** Source view only: pretty accesses and import-slot folding. */
    readonly pretty: boolean;
    readonly pointer_bits: number | undefined;
    /** Target ABI that sizes header-declared library types. */
    readonly abi: AbiProfile | undefined;
  },
): GlobalPlan {
  const objects = new Map<string, GlobalObject>();
  /** The imported object a binding slot's pointer value designates. */
  const imported = (item: SourceAddress): GlobalObject | undefined => {
    if (!item.import) return undefined;
    const key = `import:${item.import.library ?? ''}:${item.import.name}`;
    let found = objects.get(key);
    if (!found) {
      found = {
        key,
        address: item.address,
        object: {
          address: item.address,
          byte_length: null,
          offset: 0n,
          mutable: true,
          kind: 'bytes',
          evidence_ids: item.import.evidence_ids,
        },
        import: item.import,
        stem: item.import.source_name,
        native_name: item.import.name,
        shape: 'bytes',
        element: { bits: 8, float: false },
      };
      objects.set(key, found);
    }
    return found;
  };
  /** The image storage an address constant lies in; a binding slot is storage too. */
  const object = (item: SourceAddress): GlobalObject | undefined => {
    const base = item.object;
    if (!base) return undefined;
    const key = `va:${keyOf(base.address)}`;
    let found = objects.get(key);
    if (!found) {
      found = {
        key,
        address: base.address,
        object: { ...base, offset: 0n },
        stem:
          item.source_name ??
          item.name ??
          (item.import ? `got_${item.import.source_name}` : `data_${hex(base.address.value)}`),
        ...(item.name === undefined ? {} : { native_name: item.name }),
        shape: 'bytes',
        element: { bits: 8, float: false },
      };
      objects.set(key, found);
    }
    return found;
  };
  const accesses = new Map<string, GlobalAccess>();
  const importLoads = new Map<string, GlobalObject>();
  const importValues = new Map<string, GlobalObject>();
  const plan: GlobalPlan = {
    accesses,
    import_loads: importLoads,
    import_values: importValues,
    object,
  };
  if (!options.pretty) return plan;
  const pointerBits = options.pointer_bits;
  const nodes: Extract<Instruction, { kind: 'load' | 'store' }>[] = [];
  for (const block of program.blocks.values())
    for (const node of block.statements) {
      context.checkpoint(1);
      if (
        (node.kind === 'load' || node.kind === 'store') &&
        program.retained.has(node.id) &&
        !program.source?.locals.has(node.id)
      )
        nodes.push(node);
    }
  // Only the dynamic linker writes a binding slot. A store that names it
  // exactly keeps every read of it an explicit memory access.
  const written = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'store') continue;
    const item = options.data(node.address);
    if (item?.import) written.add(keyOf(item.address));
  }
  for (const node of nodes) {
    if (
      node.kind !== 'load' ||
      node.result.type.kind !== 'integer' ||
      node.result.type.bits !== pointerBits ||
      node.access.volatile ||
      node.access.endian !== 'little'
    )
      continue;
    const item = options.data(node.address);
    if (!item?.import || item.object?.offset !== 0n || written.has(keyOf(item.address))) continue;
    const found = imported(item);
    if (!found) continue;
    importLoads.set(node.id, found);
    importValues.set(node.result.id, found);
  }
  interface Observed {
    readonly node: Extract<Instruction, { kind: 'load' | 'store' }>;
    readonly offset: bigint;
    readonly bits: number;
    readonly float: boolean;
    readonly plain: boolean;
  }
  const observed = new Map<GlobalObject, Observed[]>();
  for (const node of nodes) {
    if (importLoads.has(node.id)) continue;
    const through = importValues.get(options.uncast(node.address).id);
    let target: GlobalObject | undefined = through,
      offset = 0n;
    if (!target) {
      const item = options.data(node.address);
      if (!item?.object) continue;
      target = object(item);
      offset = item.object.offset;
    }
    if (!target || offset < 0n) continue;
    const type = options.access_type(node),
      float = type.kind === 'float',
      bits = bitWidth(type);
    const plain =
      (type.kind === 'integer' || float) &&
      WIDTHS.has(bits) &&
      node.access.endian === 'little' &&
      !node.access.volatile &&
      node.access.alignment === 1 &&
      (target.import !== undefined || target.object.kind === 'bytes');
    const list = observed.get(target);
    const entry = { node, offset, bits, float, plain };
    if (list) list.push(entry);
    else observed.set(target, [entry]);
    target.first ??= node.id;
  }
  for (const [target, list] of observed) {
    const first = list[0]!;
    const bytes = BigInt(first.bits / 8);
    const known = target.object.byte_length;
    const uniform = list.every(
      (item) =>
        item.plain &&
        item.bits === first.bits &&
        item.float === first.float &&
        item.offset % bytes === 0n &&
        (target.import !== undefined || (target.address.value + item.offset) % bytes === 0n) &&
        (known === null || item.offset + bytes <= known),
    );
    if (!uniform) continue;
    target.element = { bits: first.bits as 8 | 16 | 32 | 64, float: first.float };
    target.shape =
      list.every((item) => item.offset === 0n) && (known === null || known === bytes)
        ? 'scalar'
        : 'array';
    for (const item of list) accesses.set(item.node.id, { object: target, offset: item.offset });
    const variable = target.import?.variable,
      type =
        variable && options.abi
          ? describeVariableType(variable.type, options.abi)
          : undefined;
    const reads = list.every((item) => item.node.kind === 'load');
    if (
      variable &&
      type &&
      target.shape === 'scalar' &&
      type.bits === first.bits &&
      (type.kind === 'float') === first.float &&
      (reads || (type.kind !== 'pointer' && !variable.constant))
    )
      target.declared = { type, constant: variable.constant, source: variable.source };
  }
  return plan;
}
