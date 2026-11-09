import { OperationError, type OperationContext } from '../../core/index.js';
import type {
  DebugFunction,
  DebugLine,
  DebugLocation,
  DebugLocationEntry,
  DebugPublic,
  DebugRange,
  DebugType,
  DebugVariable,
  DwarfData,
} from '../dwarf/index.js';
import { MsfFile, PDB_LIMITS, PdbReader } from './msf.js';
import { functionIdType, PdbTypes, TypeStream } from './types.js';
export { isPdb } from './msf.js';

/** A function's frame after its prologue, relative to the stack pointer at entry. */
export interface PdbFrame {
  readonly stack: bigint;
  /** The frame register the prologue establishes (a CodeView register) and its value. */
  readonly frame?: { readonly register: number; readonly value: bigint };
}
export interface PdbOptions {
  /** VA of each image section; PDB section numbers are 1-based indices into it. */
  readonly sections: readonly bigint[];
  /** The frame of the function at `address`, or null when it is not established. */
  readonly frame: (address: bigint) => PdbFrame | null;
}
export interface PdbIdentity {
  /** Canonical lowercase GUID (first three fields little-endian), as the RSDS record's. */
  readonly guid: string;
  /** The DBI stream's age (the image's RSDS age); the info stream's when there is no DBI. */
  readonly age: number;
}
export interface PdbResult extends PdbIdentity {
  readonly data: DwarfData;
}

const S = {
  END: 0x0006,
  THUNK32: 0x1102,
  BLOCK32: 0x1103,
  WITH32: 0x1104,
  REGISTER: 0x1106,
  UDT: 0x1108,
  BPREL32: 0x110b,
  LDATA32: 0x110c,
  GDATA32: 0x110d,
  PUB32: 0x110e,
  LPROC32: 0x110f,
  GPROC32: 0x1110,
  REGREL32: 0x1111,
  FRAMEPROC: 0x1012,
  SEPCODE: 0x1132,
  LOCAL: 0x113e,
  DEFRANGE_REGISTER: 0x1141,
  DEFRANGE_FRAMEPOINTER_REL: 0x1142,
  DEFRANGE_SUBFIELD_REGISTER: 0x1143,
  DEFRANGE_FRAMEPOINTER_REL_FULL_SCOPE: 0x1144,
  DEFRANGE_REGISTER_REL: 0x1145,
  LPROC32_ID: 0x1146,
  GPROC32_ID: 0x1147,
  INLINESITE: 0x114d,
  INLINESITE_END: 0x114e,
  PROC_ID_END: 0x114f,
} as const;
const PROCEDURES: readonly number[] = [S.GPROC32, S.LPROC32, S.GPROC32_ID, S.LPROC32_ID];
const SCOPE_ENDS: readonly number[] = [S.END, S.PROC_ID_END, S.INLINESITE_END];
const DEFRANGES: readonly number[] = [
  S.DEFRANGE_REGISTER,
  S.DEFRANGE_FRAMEPOINTER_REL,
  S.DEFRANGE_SUBFIELD_REGISTER,
  S.DEFRANGE_FRAMEPOINTER_REL_FULL_SCOPE,
  S.DEFRANGE_REGISTER_REL,
];
const CV_RSP = 335;
/** CodeView x64 registers (and their sub-registers) to DWARF x86-64 register numbers. */
const DWARF_REGISTER = new Map<number, number>();
{
  const order = [0, 3, 2, 1, 4, 5, 6, 7]; // CodeView RAX RBX RCX RDX RSI RDI RBP RSP
  order.forEach((dwarf, i) => DWARF_REGISTER.set(328 + i, dwarf));
  // AL CL DL BL; AX CX DX BX SP BP SI DI; EAX..EDI; SIL DIL BPL SPL.
  [0, 2, 1, 3].forEach((dwarf, i) => DWARF_REGISTER.set(1 + i, dwarf));
  [0, 2, 1, 3, 7, 6, 4, 5].forEach((dwarf, i) => {
    DWARF_REGISTER.set(9 + i, dwarf);
    DWARF_REGISTER.set(17 + i, dwarf);
  });
  [4, 5, 6, 7].forEach((dwarf, i) => DWARF_REGISTER.set(324 + i, dwarf));
  for (let i = 0; i < 8; i++) {
    for (const base of [336, 344, 352, 360]) DWARF_REGISTER.set(base + i, 8 + i); // R8..R15 (Q/B/W/D)
    DWARF_REGISTER.set(154 + i, 17 + i); // XMM0-7
    DWARF_REGISTER.set(194 + i, 17 + i); // XMM0L-7L
    DWARF_REGISTER.set(252 + i, 25 + i); // XMM8-15
    DWARF_REGISTER.set(292 + i, 25 + i); // XMM8L-15L
  }
}

function guidText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const hex = (from: number, to: number) =>
    [...bytes.subarray(from, to)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${view.getUint32(0, true).toString(16).padStart(8, '0')}-${view.getUint16(4, true).toString(16).padStart(4, '0')}-${view.getUint16(6, true).toString(16).padStart(4, '0')}-${hex(8, 10)}-${hex(10, 16)}`;
}

interface InfoStream {
  readonly guid: string;
  readonly age: number;
  readonly named: ReadonlyMap<string, number>;
}
function readInfo(msf: MsfFile): InfoStream {
  const bytes = msf.stream(1);
  if (!bytes) throw new Error('PDB has no info stream');
  const r = new PdbReader(bytes);
  r.u32(); // version
  r.u32(); // signature (time stamp)
  const age = r.u32(),
    guid = guidText(r.block(16));
  const named = new Map<string, number>();
  try {
    const strings = r.block(r.u32());
    const count = r.u32();
    r.u32(); // capacity
    const present: number[] = [];
    const words = r.u32();
    if (words > 1024) throw new Error('named stream map is too large');
    for (let word = 0; word < words; word++) {
      const bits = r.u32();
      for (let bit = 0; bit < 32; bit++) if (bits & (1 << bit)) present.push(word * 32 + bit);
    }
    const deleted = r.u32();
    r.skip(deleted * 4);
    if (present.length !== count) throw new Error('named stream map count mismatch');
    for (let i = 0; i < count; i++) {
      const key = r.u32(),
        stream = r.u32();
      named.set(new PdbReader(strings, key).string(), stream);
    }
  } catch {
    // Named streams only locate source file names; the identity above stands without them.
  }
  return { guid, age, named };
}

interface Module {
  readonly name: string;
  readonly stream: number;
  readonly symbols: number;
  readonly c11: number;
  readonly c13: number;
}
interface Dbi {
  readonly age: number;
  readonly symbolRecords: number;
  readonly modules: readonly Module[];
}
function readDbi(bytes: Uint8Array): Dbi {
  const r = new PdbReader(bytes);
  if (r.i32() !== -1) throw new Error('Unsupported DBI stream version signature');
  r.u32(); // version
  const age = r.u32();
  r.u16(); // global symbol hash stream
  r.u16();
  r.u16(); // public symbol hash stream
  r.u16();
  const symbolRecords = r.u16();
  r.u16();
  const moduleBytes = r.i32();
  r.skip(36); // other substream sizes, MFC index, flags, machine, padding
  if (moduleBytes < 0) throw new Error('Invalid DBI module substream size');
  const m = new PdbReader(r.block(moduleBytes));
  const modules: Module[] = [];
  while (m.position < m.end && modules.length < 65535) {
    m.skip(4 + 28 + 2); // unused, section contribution, flags
    const stream = m.u16(),
      symbols = m.u32(),
      c11 = m.u32(),
      c13 = m.u32();
    m.skip(2 + 2 + 4 + 4 + 4);
    const name = m.string();
    m.string(); // object file name
    m.position = Math.min(m.end, (m.position + 3) & ~3);
    modules.push({ name, stream, symbols, c11, c13 });
  }
  return { age, symbolRecords, modules };
}

/** The PDB's GUID and age, the identity an image's RSDS record names. */
export function readPdbIdentity(bytes: Uint8Array, context: OperationContext): PdbIdentity {
  const msf = new MsfFile(bytes, context);
  const info = readInfo(msf);
  const dbi = msf.stream(3);
  return { guid: info.guid, age: dbi?.length ? readDbi(dbi).age : info.age };
}

/**
 * Decodes a PDB (MSF 7.0) into the debug records DWARF produces: procedures with their
 * prototypes and parameter names (S_GPROC32/S_LPROC32 and their _ID forms, typed by TPI
 * procedure records), frame variables (S_LOCAL with S_DEFRANGE_*, MSVC's S_REGREL32,
 * S_REGISTER), globals and statics (S_GDATA32/S_LDATA32), typedefs (S_UDT), public
 * symbols (S_PUB32, names only), C13 line tables and the TPI types they reference.
 * Frame-relative storage becomes CFA-relative through `options.frame` (the image's unwind
 * data), else stays register-relative. Inline sites, thunks, TLS data, constants, C11 lines
 * and type servers are not decoded. No I/O; bounded by PDB_LIMITS and the context budget.
 */
export function parsePdb(
  bytes: Uint8Array,
  context: OperationContext,
  options: PdbOptions,
): PdbResult {
  context.checkpoint(0);
  let work = 0;
  const spend = () => {
    context.checkpoint(1);
    if (++work > 20_000_000) throw new Error('PDB analysis operation limit exceeded');
  };
  const diagnostics: string[] = [];
  let undecoded = false;
  const diagnose = (message: string) => {
    if (diagnostics.length < 1000 && !diagnostics.includes(message)) diagnostics.push(message);
  };
  const hide = (message: string) => {
    undecoded = true;
    diagnose(message);
  };
  // Per-record limitations are counted, then reported once each.
  const tally = new Map<string, number>();
  const note = (limitation: string): void => {
    tally.set(limitation, (tally.get(limitation) ?? 0) + 1);
  };
  const guard = (label: string, fn: () => void, hidden = true) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof OperationError) throw error;
      (hidden ? hide : diagnose)(`${label}: ${String(error)}`);
    }
  };

  const msf = new MsfFile(bytes, context);
  const info = readInfo(msf);
  const dbiBytes = msf.stream(3);
  const dbi = dbiBytes?.length ? readDbi(dbiBytes) : null;
  let tpi: TypeStream | null = null,
    ipi: TypeStream | null = null;
  guard('PDB type stream (TPI)', () => {
    const stream = msf.stream(2);
    if (stream?.length) tpi = new TypeStream(stream, spend);
  });
  guard('PDB id stream (IPI)', () => {
    const stream = msf.stream(4);
    if (stream?.length) ipi = new TypeStream(stream, spend);
  });
  const types = new PdbTypes(tpi, spend);
  let names: Uint8Array | null = null;
  guard(
    'PDB string table (/names)',
    () => {
      const index = info.named.get('/names');
      const stream = index === undefined ? null : msf.stream(index);
      if (!stream) return;
      const r = new PdbReader(stream);
      if (r.u32() !== 0xeffeeffe) throw new Error('bad signature');
      r.u32();
      names = r.block(r.u32());
    },
    false,
  );
  const stringAt = (offset: number): string | undefined =>
    names && offset < (names as Uint8Array).length
      ? new PdbReader(names, offset).string()
      : undefined;

  const address = (section: number, offset: number): bigint | null => {
    const base = options.sections[section - 1];
    return base === undefined ? null : base + BigInt(offset);
  };

  const functions: DebugFunction[] = [],
    variables: DebugVariable[] = [],
    lines: DebugLine[] = [],
    publics: DebugPublic[] = [],
    typedefs: DebugType[] = [];
  const globals = new Set<string>(),
    udts = new Set<string>();
  let symbolCount = 0;
  const count = () => {
    spend();
    if (++symbolCount > PDB_LIMITS.symbols) throw new Error('PDB symbol count limit exceeded');
  };

  function data(id: string, r: PdbReader, functionAddress?: bigint): void {
    const type = r.u32(),
      offset = r.u32(),
      section = r.u16(),
      name = r.string();
    const at = address(section, offset);
    if (at === null) return note('data symbols lie outside the image sections (linker-defined)');
    const key = `${at}:${name}:${functionAddress ?? ''}`;
    if (globals.has(key)) return;
    globals.add(key);
    variables.push({
      id,
      name,
      typeId: types.id(type),
      functionAddress,
      parameter: false,
      locations: [{ ranges: [], location: { kind: 'address', address: at } }],
    });
  }
  function typedef(r: PdbReader): void {
    const type = r.u32(),
      name = r.string();
    const key = `${name}:${types.resolve(type)}`;
    if (udts.has(key)) return;
    udts.add(key);
    // A C struct's S_UDT repeats its tag; only a different name is a typedef.
    if (types.declaration(type) === name) return;
    const record = types.typedef(name, type, udts.size);
    if (record) typedefs.push(record);
  }
  /** Records of a symbol substream: [kind, record offset, reader over the record body]. */
  function* records(bytes: Uint8Array, start: number, end: number) {
    const r = new PdbReader(bytes, start, end);
    while (r.position + 4 <= r.end) {
      count();
      const offset = r.position,
        length = r.u16();
      if (length < 2 || r.position + length > r.end)
        throw new Error(`Truncated symbol record at 0x${offset.toString(16)}`);
      const kind = r.u16();
      const body = new PdbReader(bytes, r.position, offset + 2 + length);
      r.position = offset + 2 + length;
      yield [kind, offset, body] as const;
    }
  }

  // Global symbol records: publics, globals, typedefs. Procedure references point into
  // module streams, which are read in full below.
  if (dbi)
    guard('PDB global symbol records', () => {
      const stream = msf.stream(dbi.symbolRecords);
      if (!stream) return;
      for (const [kind, offset, r] of records(stream, 0, stream.length)) {
        if (kind === S.PUB32) {
          const flags = r.u32(),
            at = r.u32(),
            section = r.u16(),
            name = r.string();
          const resolved = address(section, at);
          if (resolved !== null)
            publics.push({
              id: `pdb-pub-${offset.toString(16)}`,
              name,
              address: resolved,
              code: (flags & 3) !== 0,
            });
        } else if (kind === S.GDATA32 || kind === S.LDATA32)
          data(`pdb-gsym-${offset.toString(16)}`, r);
        else if (kind === S.UDT) typedef(r);
      }
    });

  interface Procedure {
    readonly fn: DebugFunction;
    readonly type: number;
    readonly parameterCount: number;
    readonly parameters: DebugVariable[];
    readonly frame: PdbFrame | null;
    /** S_FRAMEPROC flags: which register locals and parameters are relative to. */
    readonly frameFlags: number;
    legacyParameters: number;
  }
  interface Scope {
    readonly procedure: Procedure | null;
    readonly ranges: DebugRange[];
    /** Inline sites and thunks: their variables belong to another function. */
    readonly foreign: boolean;
  }
  function frameLocation(procedure: Procedure, register: number, offset: number) {
    const frame = procedure.frame,
      displacement = BigInt(offset);
    // CFA = entry stack pointer + 8 (the return address).
    if (frame && register === CV_RSP)
      return { kind: 'cfa-offset', offset: frame.stack + displacement - 8n } as const;
    if (frame?.frame && register === frame.frame.register)
      return { kind: 'cfa-offset', offset: frame.frame.value + displacement - 8n } as const;
    const dwarf = DWARF_REGISTER.get(register);
    return dwarf === undefined
      ? null
      : ({ kind: 'register-offset', register: dwarf, offset: displacement } as const);
  }
  /** The frame register S_FRAMEPROC encodes for locals or parameters (x64). */
  const encodedFrameRegister = (procedure: Procedure, parameter: boolean) =>
    [0, CV_RSP, 334, 341][(procedure.frameFlags >> (parameter ? 16 : 14)) & 3]!;

  /** The flags of a procedure's S_FRAMEPROC, which MSVC may record after its locals. */
  function frameFlags(stream: Uint8Array, start: number, end: number): number {
    const r = new PdbReader(stream, start, Math.max(start, Math.min(end, stream.length)));
    while (r.position + 4 <= r.end) {
      spend();
      const at = r.position,
        length = r.u16();
      if (length < 2 || at + 2 + length > r.end) break;
      if (r.u16() === S.FRAMEPROC && length >= 28) {
        r.skip(22); // frame and padding sizes, saved registers, exception handler
        return r.u32();
      }
      r.position = at + 2 + length;
    }
    return 0;
  }

  function readModule(index: number, module: Module): void {
    const stream = msf.stream(module.stream);
    if (!stream) return;
    if (module.symbols > stream.length || module.symbols + module.c11 + module.c13 > stream.length)
      throw new Error('substream sizes exceed the module stream');
    if (module.symbols >= 4 && new PdbReader(stream).u32() !== 4)
      throw new Error('unsupported module symbol signature (not C13)');
    const scopes: Scope[] = [];
    let local: { variable: DebugVariable; procedure: Procedure; scope: Scope } | null = null;
    const close = () => {
      if (local?.variable.locations.length) variables.push(local.variable);
      local = null;
    };
    const top = () => scopes[scopes.length - 1];
    const id = (offset: number) => `pdb-m${index}-${offset.toString(16)}`;
    const range = (r: PdbReader): DebugRange[] => {
      const start = r.u32(),
        section = r.u16(),
        length = r.u16();
      const base = address(section, start);
      if (base === null) return [];
      let ranges: DebugRange[] = [{ start: base, end: base + BigInt(length) }];
      while (r.position + 4 <= r.end) {
        const gap = base + BigInt(r.u16()),
          gapEnd = gap + BigInt(r.u16());
        ranges = ranges.flatMap((item) =>
          gapEnd <= item.start || gap >= item.end
            ? [item]
            : [
                ...(gap > item.start ? [{ start: item.start, end: gap }] : []),
                ...(gapEnd < item.end ? [{ start: gapEnd, end: item.end }] : []),
              ],
        );
      }
      return ranges;
    };
    const addVariable = (
      offset: number,
      name: string,
      type: number,
      location: DebugLocation | null,
      scope: Scope,
      procedure: Procedure,
      parameter: boolean,
      listed = parameter,
    ) => {
      const variable: DebugVariable = {
        id: id(offset),
        name,
        typeId: types.id(type),
        functionAddress: procedure.fn.address,
        parameter,
        locations: location ? [{ ranges: scope.ranges, location }] : [],
      };
      if (location) variables.push(variable);
      else note('variables have storage this reader does not place');
      // A parameter names its position in the signature wherever its value lives.
      if (listed) procedure.parameters.push(variable);
    };

    for (const [kind, offset, r] of records(stream, 4, Math.max(4, module.symbols))) {
      if (!DEFRANGES.includes(kind)) close();
      const scope = top();
      const procedure = scope?.procedure ?? null;
      if (PROCEDURES.includes(kind)) {
        r.skip(4); // parent
        const end = r.u32();
        r.skip(4); // next
        const size = r.u32();
        r.skip(8); // debug start/end
        let type = r.u32();
        const start = r.u32(),
          section = r.u16(),
          flags = r.u8(),
          name = r.string();
        if (kind === S.GPROC32_ID || kind === S.LPROC32_ID) type = functionIdType(ipi, type) ?? 0;
        const at = address(section, start);
        const ranges = at === null ? [] : [{ start: at, end: at + BigInt(size) }];
        if (at === null) note('procedures lie outside the image sections');
        const contract = types.procedure(type);
        const fn: DebugFunction = {
          id: id(offset),
          name,
          address: at ?? 0n,
          size: BigInt(size),
          ranges,
          prototype: types.declaration(contract?.returns ?? 0, `${name}()`),
          ...(contract
            ? { signature: { ...contract.signature, nonReturning: (flags & 0x08) !== 0 } }
            : {}),
        };
        if (!contract) note('procedures have no procedure type (funclets, thunks): no signature');
        if (at !== null) functions.push(fn);
        const state: Procedure = {
          fn,
          type,
          parameterCount: contract?.parameters.length ?? 0,
          parameters: [],
          frame: at === null ? null : options.frame(at),
          frameFlags: frameFlags(stream, r.end, end),
          legacyParameters: 0,
        };
        scopes.push({ procedure: at === null ? null : state, ranges, foreign: false });
      } else if (kind === S.BLOCK32) {
        r.skip(8);
        const size = r.u32(),
          start = r.u32(),
          section = r.u16();
        const at = address(section, start);
        scopes.push({
          procedure,
          ranges: at === null ? [] : [{ start: at, end: at + BigInt(size) }],
          foreign: scope?.foreign ?? false,
        });
      } else if (
        kind === S.INLINESITE ||
        kind === S.THUNK32 ||
        kind === S.SEPCODE ||
        kind === S.WITH32
      )
        scopes.push({ procedure, ranges: [], foreign: true });
      else if (SCOPE_ENDS.includes(kind)) {
        const ended = scopes.pop();
        if (ended?.procedure && !scopes.some((item) => item.procedure === ended.procedure))
          finishProcedure(ended.procedure);
      } else if (kind === S.GDATA32 || kind === S.LDATA32)
        data(id(offset), r, procedure && !scope?.foreign ? procedure.fn.address : undefined);
      else if (kind === S.UDT) typedef(r);
      else if (!procedure || scope!.foreign) continue;
      else if (kind === S.REGREL32 || kind === S.BPREL32 || kind === S.REGISTER) {
        let type: number,
          register: number | null = null,
          displacement = 0;
        if (kind === S.REGISTER) {
          type = r.u32();
          register = r.u16();
        } else {
          displacement = r.i32();
          type = r.u32();
          if (kind === S.REGREL32) register = r.u16();
        }
        const name = r.string();
        // MSVC records an optimized parameter's home slot after its S_LOCAL; without
        // S_LOCAL parameters it records the parameters first, in order, in the
        // procedure's own scope.
        const home = procedure.parameters.some((parameter) => parameter.name === name);
        const parameter =
          home ||
          (scope!.ranges === procedure.fn.ranges &&
            procedure.parameters.length === procedure.legacyParameters &&
            procedure.legacyParameters < procedure.parameterCount);
        if (parameter && !home) procedure.legacyParameters++;
        const location =
          kind === S.REGISTER
            ? DWARF_REGISTER.has(register!)
              ? ({ kind: 'register', register: DWARF_REGISTER.get(register!)! } as const)
              : null
            : frameLocation(
                procedure,
                register ?? encodedFrameRegister(procedure, parameter),
                displacement,
              );
        addVariable(offset, name, type, location, scope!, procedure, parameter, parameter && !home);
      } else if (kind === S.LOCAL) {
        const type = r.u32(),
          flags = r.u16(),
          name = r.string();
        const parameter = (flags & 1) !== 0;
        const variable: DebugVariable = {
          id: id(offset),
          name,
          typeId: types.id(type),
          functionAddress: procedure.fn.address,
          parameter,
          locations: [],
        };
        if (parameter) procedure.parameters.push(variable);
        local = { variable, procedure, scope: scope! };
      } else if (DEFRANGES.includes(kind) && local) {
        const current: { variable: DebugVariable; procedure: Procedure; scope: Scope } = local;
        let location: DebugLocation | null = null,
          ranges: DebugRange[];
        if (kind === S.DEFRANGE_FRAMEPOINTER_REL_FULL_SCOPE) {
          location = frameLocation(
            current.procedure,
            encodedFrameRegister(current.procedure, current.variable.parameter),
            r.i32(),
          );
          ranges = current.scope.ranges;
        } else if (kind === S.DEFRANGE_FRAMEPOINTER_REL) {
          location = frameLocation(
            current.procedure,
            encodedFrameRegister(current.procedure, current.variable.parameter),
            r.i32(),
          );
          ranges = range(r);
        } else if (kind === S.DEFRANGE_REGISTER_REL) {
          const register = r.u16(),
            flags = r.u16(),
            displacement = r.i32();
          // A spilled subfield (flags bit 0) is part of the variable, not its whole value.
          location = flags & 1 ? null : frameLocation(current.procedure, register, displacement);
          ranges = range(r);
        } else if (kind === S.DEFRANGE_REGISTER) {
          const dwarf = DWARF_REGISTER.get(r.u16());
          r.u16();
          location = dwarf === undefined ? null : { kind: 'register', register: dwarf };
          ranges = range(r);
        } else {
          // A register holding part of the variable (S_DEFRANGE_SUBFIELD_REGISTER).
          note('variable ranges hold part of a variable in a register (not placed)');
          continue;
        }
        if (location)
          (current.variable.locations as DebugLocationEntry[]).push({ ranges, location });
        else note('variable ranges have storage this reader does not place');
      }
    }
    close();
    for (const scope of scopes) if (scope.procedure) finishProcedure(scope.procedure);
    if (module.c13) readLines(stream, module.symbols + module.c11, module.c13);
  }

  /** Parameter names and the prototype once a procedure's records are read. */
  const finished = new Set<Procedure>();
  function finishProcedure(procedure: Procedure): void {
    if (finished.has(procedure)) return;
    finished.add(procedure);
    const fn = procedure.fn,
      contract = types.procedure(procedure.type);
    if (!contract || !fn.signature) return;
    // Only a complete, ordered set of parameter records names the parameters.
    const named = procedure.parameters.length === contract.parameters.length;
    if (!named && procedure.parameters.length)
      note('procedures have parameter records that do not match their type: parameters unnamed');
    fn.signature.parameters = fn.signature.parameters.map((parameter, i) => ({
      ...parameter,
      name: named ? procedure.parameters[i]!.name : undefined,
    }));
    const declared = contract.parameters.map((type, i) =>
      types.declaration(type, named ? procedure.parameters[i]!.name : ''),
    );
    if (contract.signature.variadic) declared.push('...');
    fn.prototype = types.declaration(
      contract.returns,
      `${fn.name}(${declared.join(', ') || 'void'})`,
    );
  }

  function readLines(stream: Uint8Array, start: number, size: number): void {
    const files = new Map<number, string>();
    const subsections: [number, PdbReader][] = [];
    const r = new PdbReader(stream, start, start + size);
    while (r.position + 8 <= r.end) {
      spend();
      const kind = r.u32(),
        length = r.u32();
      const body = new PdbReader(
        stream,
        r.position,
        r.position + Math.min(length, r.end - r.position),
      );
      r.position = Math.min(r.end, (r.position + length + 3) & ~3);
      if (kind === 0xf4) {
        // File checksums: line blocks name a file by its entry's offset in this subsection.
        const origin = body.position;
        while (body.position + 6 <= body.end) {
          const at = body.position;
          const name = body.u32(),
            checksum = body.u8();
          body.skip(1 + checksum);
          body.position = Math.min(body.end, at + ((body.position - at + 3) & ~3));
          files.set(at - origin, stringAt(name) ?? `<file ${name}>`);
        }
      } else if (kind === 0xf2) subsections.push([kind, body]);
    }
    for (const [, body] of subsections) {
      const offset = body.u32(),
        section = body.u16(),
        flags = body.u16(),
        codeSize = body.u32();
      const base = address(section, offset);
      if (base === null) continue;
      const rows: DebugLine[] = [];
      while (body.position + 12 <= body.end) {
        const file = files.get(body.u32()) ?? '<unknown file>',
          count = body.u32();
        body.u32(); // block size
        const block: DebugLine[] = [];
        for (let i = 0; i < count; i++) {
          spend();
          const at = body.u32(),
            bits = body.u32();
          block.push({ address: base + BigInt(at), file, line: bits & 0xffffff });
        }
        if (flags & 1)
          for (const row of block) {
            const column = body.u16();
            body.u16();
            if (column) row.column = column;
          }
        rows.push(...block);
      }
      rows.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
      const end = base + BigInt(codeSize);
      rows.forEach((row, i) => {
        const next = rows[i + 1]?.address ?? end;
        if (next > row.address) row.endAddress = next;
      });
      for (const row of rows) {
        // 0xfeefee / 0xf00f00 mark compiler-generated code with no source line.
        if (row.endAddress === undefined || row.line === 0xfeefee || row.line === 0xf00f00)
          continue;
        if (lines.length >= PDB_LIMITS.rows) return diagnose('PDB line row limit reached');
        lines.push(row);
      }
    }
  }

  if (dbi)
    dbi.modules.forEach((module, index) =>
      guard(`PDB module ${module.name}`, () => readModule(index, module)),
    );
  else hide('PDB has no DBI stream: no symbols were decoded');

  const typeRecords = [...types.types(), ...typedefs];
  for (const message of types.diagnostics) diagnose(message);
  for (const [limitation, count] of tally) diagnose(`PDB: ${count} ${limitation}`);
  functions.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : a.name.localeCompare(b.name),
  );
  lines.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return {
    guid: info.guid,
    age: dbi?.age ?? info.age,
    data: {
      functions,
      types: typeRecords,
      lines,
      diagnostics,
      undecoded,
      variables,
      inlineScopes: [],
      publics,
    },
  };
}
