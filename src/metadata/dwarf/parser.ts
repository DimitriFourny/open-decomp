import { OperationError, type OperationContext } from '../../core/index.js';
import type {
  DebugFunction,
  DebugInlineScope,
  DebugLocationEntry,
  DebugRange,
  DebugSignature,
  DebugSignatureType,
  DebugSymbols,
  DebugType,
  DebugVariable,
} from './model.js';
import {
  DwarfReader,
  DwarfTextBudget,
  DWARF_LIMITS,
  MAX_ADDRESS,
  number,
  sectionReader,
  stringAt,
  type DwarfSections,
} from './reader.js';
import { readLineProgram } from './line.js';
import {
  decodeLocation,
  intersectRanges,
  memberOffset,
  normalizeRanges,
  readLocationList,
} from './location.js';

interface Attribute {
  form: number;
  value: bigint | string | Uint8Array;
}
interface Die {
  offset: number;
  tag: number;
  attributes: Map<number, Attribute>;
  children: Die[];
  unit: Unit;
}
interface Unit {
  start: number;
  end: number;
  version: number;
  offsetSize: number;
  addressSize: number;
  root?: Die | undefined;
  dies: Die[];
}
interface Abbreviation {
  tag: number;
  children: boolean;
  attributes: { name: number; form: number; implicit?: bigint | undefined }[];
}
const TYPE_KINDS: Record<number, string> = {
  1: 'array',
  2: 'class',
  4: 'enum',
  15: 'pointer',
  16: 'reference',
  19: 'struct',
  21: 'subroutine',
  22: 'typedef',
  23: 'union',
  31: 'pointer-to-member',
  36: 'base',
  38: 'const',
  53: 'volatile',
  55: 'restrict',
  66: 'rvalue-reference',
  71: 'atomic',
};
const ADDRESS_FORMS = [1, 0x1b, 0x29, 0x2a, 0x2b, 0x2c];

function abbreviations(
  sections: DwarfSections,
  offset: number,
  little: boolean,
  spend: () => void,
): Map<number, Abbreviation> {
  const r = sectionReader(sections, '__debug_abbrev', offset, little),
    result = new Map<number, Abbreviation>();
  while (r.position < r.end) {
    spend();
    const code = r.nleb();
    if (!code) return result;
    if (result.has(code)) throw new Error('Duplicate abbreviation code');
    if (result.size >= DWARF_LIMITS.dies) throw new Error('Abbreviation count limit exceeded');
    const tag = r.nleb(),
      child = r.u8();
    if (child > 1) throw new Error('Invalid abbreviation child flag');
    const attributes: Abbreviation['attributes'] = [];
    while (true) {
      spend();
      const name = r.nleb(),
        form = r.nleb();
      if (!name && !form) break;
      if (!name || !form || attributes.length >= 1024)
        throw new Error('Invalid or excessive abbreviation attributes');
      attributes.push({ name, form, implicit: form === 0x21 ? r.leb(true) : undefined });
    }
    result.set(code, { tag, children: child === 1, attributes });
  }
  throw new Error('Unterminated abbreviation table');
}

function readForm(
  r: DwarfReader,
  unit: Unit,
  form: number,
  textBudget: DwarfTextBudget,
  implicit?: bigint,
  depth = 0,
): Attribute {
  if (depth > 8) throw new Error('Indirect DWARF form nesting limit exceeded');
  let value: Attribute['value'];
  switch (form) {
    case 1:
      value = r.uint(unit.addressSize);
      break;
    case 3:
      value = r.block(r.u16());
      break;
    case 4:
      value = r.block(r.u32());
      break;
    case 5:
      value = r.uint(2);
      break;
    case 6:
      value = r.uint(4);
      break;
    case 7:
      value = r.uint(8);
      break;
    case 8:
      value = r.string(textBudget);
      break;
    case 9:
    case 0x18:
      value = r.block(r.nleb());
      break;
    case 0xa:
      value = r.block(r.u8());
      break;
    case 0xb:
    case 0xc:
    case 0x11:
    case 0x25:
    case 0x29:
      value = r.uint(1);
      break;
    case 0xd:
      value = r.leb(true);
      break;
    case 0xe:
    case 0x17:
    case 0x1d:
    case 0x1f:
      value = r.uint(unit.offsetSize);
      break;
    case 0xf:
    case 0x15:
    case 0x1a:
    case 0x1b:
    case 0x22:
    case 0x23:
      value = r.leb();
      break;
    case 0x10:
      value = r.uint(unit.version === 2 ? unit.addressSize : unit.offsetSize);
      break;
    case 0x12:
    case 0x26:
    case 0x2a:
      value = r.uint(2);
      break;
    case 0x13:
    case 0x27:
    case 0x2b:
      value = r.uint(form === 0x13 ? 4 : 3);
      break;
    case 0x14:
    case 0x20:
    case 0x24:
      value = r.uint(8);
      break;
    case 0x16:
      return readForm(r, unit, r.nleb(), textBudget, undefined, depth + 1);
    case 0x19:
      value = 1n;
      break;
    case 0x1c:
    case 0x28:
    case 0x2c:
      value = r.uint(4);
      break;
    case 0x1e:
      value = r.block(16);
      break;
    case 0x21:
      if (implicit === undefined)
        throw new Error('implicit_const is missing its abbreviation value');
      value = implicit;
      break;
    default:
      throw new Error(`Unsupported DWARF form 0x${form.toString(16)}`);
  }
  if ([0x1c, 0x1d, 0x20, 0x24].includes(form))
    throw new Error('Unsupported supplementary/split DWARF reference or type signature');
  return { form, value };
}

export function parseDwarf(
  sections: DwarfSections,
  little: boolean,
  context: OperationContext,
): Omit<DebugSymbols, 'uuid'> {
  const info = sectionReader(sections, '__debug_info', 0, little),
    units: Unit[] = [],
    dies = new Map<number, Die>();
  context.checkpoint(0);
  const textBudget = new DwarfTextBudget(Math.min(DWARF_LIMITS.text, context.budget.output_bytes));
  const diagnostics: string[] = [],
    diagnosticSet = new Set<string>();
  const diagnose = (message: string) => {
    if (!diagnosticSet.has(message) && diagnostics.length < 1000) {
      diagnosticSet.add(message);
      diagnostics.push(message);
    }
  };
  let totalDies = 0,
    unitCount = 0;
  let work = 0,
    renderedCharacters = 0;
  const spend = () => {
    context.checkpoint(1);
    if (++work > DWARF_LIMITS.steps) throw new Error('DWARF analysis operation limit exceeded');
  };
  const abbreviationCache = new Map<number, Map<number, Abbreviation>>();
  while (info.position < info.end) {
    const start = info.position;
    let end: number;
    let offsetSize: number;
    try {
      ({ end, offsetSize } = info.initialLength());
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnose(`DWARF unit at 0x${start.toString(16)}: ${String(error)}`);
      break;
    }
    try {
      if (++unitCount > 10_000) throw new Error('Compilation unit count limit exceeded');
      const r = new DwarfReader(info.bytes, info.position, end, little),
        version = r.u16();
      if (version < 2 || version > 5) throw new Error(`Unsupported DWARF version ${version}`);
      let addressSize: number, abbrevOffset: number;
      if (version === 5) {
        const unitType = r.u8();
        addressSize = r.u8();
        abbrevOffset = number(r.uint(offsetSize));
        if (unitType !== 1 && unitType !== 3)
          throw new Error(
            `Unsupported DWARF unit type ${unitType} (split/type units require supplementary input)`,
          );
      } else {
        abbrevOffset = number(r.uint(offsetSize));
        addressSize = r.u8();
      }
      if (addressSize !== 4 && addressSize !== 8)
        throw new Error(`Unsupported DWARF address size ${addressSize}`);
      let table = abbreviationCache.get(abbrevOffset);
      if (!table) {
        table = abbreviations(sections, abbrevOffset, little, spend);
        abbreviationCache.set(abbrevOffset, table);
      }
      const unit: Unit = { start, end, version, offsetSize, addressSize, dies: [] },
        parents: Die[] = [];
      while (r.position < end) {
        spend();
        const offset = r.position,
          code = r.nleb();
        if (!code) {
          if (parents.length) parents.pop();
          else if (r.position !== end) throw new Error('Unexpected null DIE outside the root');
          continue;
        }
        if (++totalDies > DWARF_LIMITS.dies) throw new Error('DWARF DIE count limit exceeded');
        const abbrev = table.get(code);
        if (!abbrev) throw new Error(`Unknown abbreviation ${code}`);
        const die: Die = { offset, tag: abbrev.tag, attributes: new Map(), children: [], unit };
        for (const attr of abbrev.attributes) {
          spend();
          if (die.attributes.has(attr.name)) throw new Error('Duplicate DIE attribute');
          die.attributes.set(attr.name, readForm(r, unit, attr.form, textBudget, attr.implicit));
        }
        if (parents.length) parents[parents.length - 1]!.children.push(die);
        else if (!unit.root) unit.root = die;
        else throw new Error('Multiple roots in one compilation unit');
        unit.dies.push(die);
        if (abbrev.children) {
          if (parents.length >= DWARF_LIMITS.depth)
            throw new Error('DIE nesting depth limit exceeded');
          parents.push(die);
        }
      }
      if (parents.length || !unit.root) throw new Error('Incomplete compilation unit DIE tree');
      if (unit.root.tag !== 0x11 && unit.root.tag !== 0x3c)
        throw new Error('Compilation unit root has an invalid tag');
      if (unit.root.attributes.has(0x76) || unit.root.attributes.has(0x2130))
        throw new Error('Unsupported split DWARF compilation unit');
      units.push(unit);
      for (const die of unit.dies) dies.set(die.offset, die);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnose(`DWARF unit at 0x${start.toString(16)}: ${String(error)}`);
    }
    info.position = end;
    if (totalDies > DWARF_LIMITS.dies || unitCount > 10_000) break;
  }
  if (!units.length) throw new Error(`No valid DWARF compilation units. ${diagnostics.join(' ')}`);

  function reference(owner: Die, attribute: Attribute): Die | undefined {
    if (typeof attribute.value !== 'bigint') return undefined;
    const relative = attribute.form >= 0x11 && attribute.form <= 0x15;
    if (!relative && attribute.form !== 0x10) {
      diagnose(`Unsupported DIE reference form 0x${attribute.form.toString(16)}`);
      return undefined;
    }
    const offset = number(attribute.value + BigInt(relative ? owner.unit.start : 0));
    if (relative && (offset < owner.unit.start || offset >= owner.unit.end)) {
      diagnose(`DIE reference at 0x${owner.offset.toString(16)} escapes its compilation unit`);
      return undefined;
    }
    const found = dies.get(offset);
    if (!found) diagnose(`Unresolved DIE reference 0x${offset.toString(16)}`);
    return found;
  }
  function inherited(
    die: Die,
    name: number,
    visited = new Set<number>(),
  ): { owner: Die; attribute: Attribute } | undefined {
    spend();
    if (visited.has(die.offset) || visited.size >= DWARF_LIMITS.depth)
      throw new Error(`Cyclic or excessive DIE inheritance at 0x${die.offset.toString(16)}`);
    visited.add(die.offset);
    const own = die.attributes.get(name);
    if (own) return { owner: die, attribute: own };
    for (const key of [0x47, 0x31]) {
      const link = die.attributes.get(key),
        target = link && reference(die, link);
      if (link && !target)
        throw new Error(
          'Unresolved DWARF inheritance reference; refusing to infer absent attributes',
        );
      if (target) {
        const found = inherited(target, name, visited);
        if (found) return found;
      }
    }
    return undefined;
  }
  function base(unit: Unit, attribute: number): number {
    const value = unit.root?.attributes.get(attribute)?.value;
    if (typeof value !== 'bigint')
      throw new Error(`Missing DWARF indexed-table base attribute 0x${attribute.toString(16)}`);
    return number(value);
  }
  interface Contribution {
    bytes: Uint8Array;
    entries: number;
    listStart: number;
    end: number;
    offsetSize: number;
    addressSize: number;
  }
  const contributionCache = new Map<string, Contribution[]>();
  function contributions(name: string): Contribution[] {
    const cached = contributionCache.get(name);
    if (cached) return cached;
    const r = sectionReader(sections, name, 0, little),
      result: Contribution[] = [];
    while (r.position < r.end) {
      if (result.length >= 10_000) throw new Error('DWARF table contribution count limit exceeded');
      const header = r.initialLength(),
        c = new DwarfReader(r.bytes, r.position, header.end, little);
      if (c.u16() !== 5) throw new Error(`Unsupported ${name} contribution version`);
      let addressSize = 0,
        count = 0;
      if (name === '__debug_str_offs') {
        if (c.u16()) throw new Error('Invalid string-offset table padding');
      } else {
        addressSize = c.u8();
        if (![4, 8].includes(addressSize) || c.u8())
          throw new Error('Unsupported segmented/address table encoding');
        if (name === '__debug_rnglists' || name === '__debug_loclists') count = c.u32();
      }
      const entries = c.position;
      c.need(count * header.offsetSize);
      result.push({
        bytes: r.bytes,
        entries,
        listStart: entries + count * header.offsetSize,
        end: header.end,
        offsetSize: header.offsetSize,
        addressSize,
      });
      r.position = header.end;
    }
    contributionCache.set(name, result);
    return result;
  }
  function indexedTable(
    unit: Unit,
    name: string,
    baseAttribute: number,
    index: bigint,
  ): DwarfReader {
    const tableBase = base(unit, baseAttribute),
      contribution = contributions(name).find((item) => item.entries === tableBase);
    if (!contribution) throw new Error(`Invalid ${name} contribution base`);
    const width = name === '__debug_addr' ? unit.addressSize : unit.offsetSize;
    if (
      name === '__debug_addr'
        ? contribution.addressSize !== unit.addressSize
        : contribution.offsetSize !== unit.offsetSize
    )
      throw new Error('DWARF table/CU width mismatch');
    const end =
      name === '__debug_rnglists' || name === '__debug_loclists'
        ? contribution.listStart
        : contribution.end;
    return new DwarfReader(contribution.bytes, tableBase + number(index) * width, end, little);
  }
  function indexedAddress(unit: Unit, index: bigint): bigint {
    const r = indexedTable(unit, '__debug_addr', 0x73, index);
    return r.uint(unit.addressSize);
  }
  function listReader(
    unit: Unit,
    name: string,
    raw: bigint,
    indexed: boolean,
    baseAttribute: number,
  ): DwarfReader {
    let offset = number(raw),
      contribution: Contribution | undefined;
    if (indexed) {
      const tableBase = base(unit, baseAttribute),
        table = indexedTable(unit, name, baseAttribute, raw);
      contribution = contributions(name).find((item) => item.entries === tableBase);
      offset = tableBase + number(table.uint(unit.offsetSize));
    } else
      contribution = contributions(name).find(
        (item) => offset >= item.listStart && offset < item.end,
      );
    if (
      !contribution ||
      offset < contribution.listStart ||
      offset >= contribution.end ||
      contribution.addressSize !== unit.addressSize ||
      contribution.offsetSize !== unit.offsetSize
    ) {
      throw new Error(`${name} list offset escapes its contribution or has mismatched widths`);
    }
    return new DwarfReader(contribution.bytes, offset, contribution.end, little);
  }
  function locations(die: Die, key: number, scope: DebugRange[] | undefined): DebugLocationEntry[] {
    // Storage belongs to a concrete instance, not its abstract-origin declaration.
    const attr = die.attributes.get(key);
    if (!attr || (scope !== undefined && !scope.length)) return [];
    const unit = die.unit,
      context = {
        addressSize: unit.addressSize,
        little,
        spend,
        indexedAddress: (index: bigint) => indexedAddress(unit, index),
        diagnose: (message: string) =>
          diagnose(`Location at DIE 0x${die.offset.toString(16)}: ${message}`),
      };
    try {
      if (attr.value instanceof Uint8Array) {
        if (![3, 4, 9, 0xa, 0x18].includes(attr.form))
          throw new Error('Unsupported DWARF location block form');
        const location = decodeLocation(attr.value, context);
        return location ? [{ ranges: scope ?? [], location }] : [];
      }
      if (
        typeof attr.value !== 'bigint' ||
        !(
          attr.form === 0x17 ||
          (unit.version >= 5 && attr.form === 0x22) ||
          (unit.version < 4 && [6, 7].includes(attr.form))
        )
      ) {
        throw new Error(`Unsupported DWARF location attribute form 0x${attr.form.toString(16)}`);
      }
      const r =
        unit.version < 5
          ? sectionReader(sections, '__debug_loc', number(attr.value), little)
          : listReader(unit, '__debug_loclists', attr.value, attr.form === 0x22, 0x8c);
      const low = unit.root?.attributes.get(0x11),
        initialBase = low && value(unit.root!, low);
      return readLocationList(
        r,
        unit.version,
        typeof initialBase === 'bigint' ? initialBase : 0n,
        scope,
        context,
      );
    } catch (error) {
      if (error instanceof OperationError) throw error;
      context.diagnose(String(error));
      return [];
    }
  }
  function value(owner: Die, attribute: Attribute): Attribute['value'] {
    const { form, value: raw } = attribute;
    if (typeof raw !== 'bigint') return raw;
    if (form === 0xe) return stringAt(sections, '__debug_str', raw, little, textBudget);
    if (form === 0x1f) return stringAt(sections, '__debug_line_str', raw, little, textBudget);
    if (form === 0x1a || (form >= 0x25 && form <= 0x28)) {
      const r = indexedTable(owner.unit, '__debug_str_offs', 0x72, raw);
      return stringAt(sections, '__debug_str', r.uint(owner.unit.offsetSize), little, textBudget);
    }
    if (form === 0x1b || (form >= 0x29 && form <= 0x2c)) return indexedAddress(owner.unit, raw);
    return raw;
  }
  function attribute(die: Die, name: number): Attribute['value'] | undefined {
    const found = inherited(die, name);
    return found && value(found.owner, found.attribute);
  }
  function text(die: Die, key: number): string | undefined {
    const result = attribute(die, key);
    if (typeof result === 'string') {
      renderedCharacters += result.length;
      if (renderedCharacters > 64 * 1024 * 1024)
        throw new Error('DWARF rendered-text limit exceeded');
    }
    return typeof result === 'string' ? result : undefined;
  }
  function typeTarget(die: Die): Die | undefined {
    const found = inherited(die, 0x49);
    if (!found) return undefined;
    const target = reference(found.owner, found.attribute);
    if (!target) throw new Error('Unresolved type reference; refusing to infer a void type');
    return target;
  }
  function typeDeclaration(
    die: Die | undefined,
    declarator = '',
    seen = new Set<number>(),
    qualifiers: string[] = [],
    indirect = false,
  ): string {
    let baseName = die ? text(die, 3) : 'void';
    if (!baseName && die) {
      if (seen.has(die.offset) || seen.size >= DWARF_LIMITS.depth) {
        diagnose(`Cyclic or excessive type reference at 0x${die.offset.toString(16)}`);
        baseName = `<recursive type 0x${die.offset.toString(16)}>`;
      } else {
        seen.add(die.offset);
        const target = typeTarget(die);
        if ([38, 53, 55, 71].includes(die.tag))
          return typeDeclaration(
            target,
            declarator,
            seen,
            [...qualifiers, die.tag === 71 ? '_Atomic' : TYPE_KINDS[die.tag]!],
            indirect,
          );
        if (die.tag === 15 || die.tag === 16 || die.tag === 66) {
          const operator = die.tag === 15 ? '*' : die.tag === 16 ? '&' : '&&';
          const qualified = qualifiers.length
            ? ` ${qualifiers.join(' ')}${declarator ? ' ' : ''}`
            : '';
          return typeDeclaration(target, `${operator}${qualified}${declarator}`, seen, [], true);
        }
        if (die.tag === 1)
          return typeDeclaration(
            target,
            `${indirect ? `(${declarator})` : declarator}${arrayDimensions(die)}`,
            seen,
            qualifiers,
          );
        if (die.tag === 21)
          return typeDeclaration(
            target,
            `${indirect ? `(${declarator})` : declarator}(${parameters(die, seen).join(', ')})`,
            seen,
            qualifiers,
          );
        baseName = `<${TYPE_KINDS[die.tag] ?? 'type'} 0x${die.offset.toString(16)}>`;
      }
    }
    const qualifiedBase = `${qualifiers.length ? `${qualifiers.join(' ')} ` : ''}${baseName}`;
    return `${qualifiedBase}${declarator ? `${declarator.startsWith('[') ? '' : ' '}${declarator}` : ''}`;
  }
  function arrayDimensions(die: Die): string {
    const dimensions = die.children.filter((child) => child.tag === 0x21);
    if (!dimensions.length) return '[?]';
    return dimensions
      .map((range) => {
        const count = attribute(range, 0x37),
          upper = attribute(range, 0x2f),
          lower = attribute(range, 0x22);
        let length: bigint | undefined;
        if (typeof count === 'bigint') length = count;
        else if (typeof upper === 'bigint') {
          const language = attribute(die.unit.root!, 0x13);
          // C-family DWARF defaults to a zero lower bound. Other languages must
          // provide a bound before we claim a concrete dimension.
          const zeroBased =
            language === undefined ||
            (typeof language === 'bigint' &&
              [1n, 2n, 4n, 0xcn, 0x10n, 0x11n, 0x1an, 0x1dn, 0x21n, 0x2an, 0x2bn, 0x2cn].includes(
                language,
              ));
          if (typeof lower === 'bigint' || (lower === undefined && zeroBased))
            length = upper - (typeof lower === 'bigint' ? lower : 0n) + 1n;
        }
        return `[${length !== undefined && length >= 0n ? length : '?'}]`;
      })
      .join('');
  }
  function parameterOwner(die: Die, seen = new Set<number>()): Die {
    if (
      die.children.some((child) => child.tag === 5 || child.tag === 0x18) ||
      seen.has(die.offset) ||
      seen.size >= DWARF_LIMITS.depth
    )
      return die;
    seen.add(die.offset);
    for (const key of [0x47, 0x31]) {
      const link = die.attributes.get(key),
        target = link && reference(die, link);
      if (target) return parameterOwner(target, seen);
    }
    return die;
  }
  function parameters(die: Die, seen = new Set<number>()): string[] {
    return parameterOwner(die)
      .children.filter((child) => child.tag === 5 || child.tag === 0x18)
      .map((child) =>
        child.tag === 0x18
          ? '...'
          : typeDeclaration(typeTarget(child), text(child, 3) ?? '', new Set(seen)),
      );
  }
  function signatureType(
    die: Die | undefined,
    parameter = false,
    ancestors = new Set<number>(),
  ): DebugSignatureType {
    if (!die)
      return { name: parameter ? '<missing type>' : 'void', kind: parameter ? 'unknown' : 'void' };
    const name = typeDeclaration(die),
      seen = new Set(ancestors);
    let current: Die | undefined = die;
    while (current && [22, 38, 53, 55].includes(current.tag)) {
      if (seen.has(current.offset) || seen.size >= DWARF_LIMITS.depth)
        return { name, kind: 'unknown' };
      seen.add(current.offset);
      current = typeTarget(current);
    }
    if (!current || seen.has(current.offset) || seen.size >= DWARF_LIMITS.depth)
      return { name, kind: 'unknown' };
    seen.add(current.offset);
    const size = attribute(current, 0xb),
      encoding = attribute(current, 0x3e);
    const result: DebugSignatureType = {
      typeId: id(die),
      name,
      kind: TYPE_KINDS[current.tag] ?? 'unknown',
      byteSize:
        typeof size === 'bigint'
          ? number(size, 'signature type byte size')
          : current.tag === 15
            ? current.unit.addressSize
            : undefined,
      encoding:
        typeof encoding === 'bigint' ? number(encoding, 'signature type encoding') : undefined,
    };
    if (current.tag === 15) {
      let pointee = typeTarget(current);
      while (pointee && [22, 38, 53, 55].includes(pointee.tag)) {
        if (seen.has(pointee.offset) || seen.size >= DWARF_LIMITS.depth) break;
        seen.add(pointee.offset);
        if (pointee.tag === 38) result.pointeeConst = true;
        pointee = typeTarget(pointee);
      }
      // Function pointers have contracts of their own; do not present them as object pointers.
      if (pointee?.tag === 21) result.kind = 'subroutine-pointer';
      else result.pointee = signatureType(pointee, false, seen);
    }
    return result;
  }
  function functionSignature(die: Die): DebugSignature {
    const owner = parameterOwner(die),
      children = owner.children.filter((child) => child.tag === 5);
    const convention = attribute(die, 0x36),
      language = attribute(die.unit.root!, 0x13);
    const prototyped = attribute(die, 0x27);
    return {
      returnType: signatureType(typeTarget(die)),
      parameters: children.map((child) => ({
        name: text(child, 3),
        type: signatureType(typeTarget(child), true),
      })),
      variadic: owner.children.some((child) => child.tag === 0x18),
      callingConvention:
        typeof convention === 'bigint' ? number(convention, 'calling convention') : undefined,
      language: typeof language === 'bigint' ? number(language, 'source language') : undefined,
      prototyped:
        prototyped === 1n ||
        (prototyped === undefined &&
          typeof language === 'bigint' &&
          [4n, 0x19n, 0x1an, 0x21n, 0x2an, 0x2bn].includes(language)),
      definition: die.attributes.get(0x3c)?.value !== 1n,
      nonReturning: attribute(die, 0x87) === 1n,
    };
  }
  function ranges(die: Die): { start: bigint; end: bigint }[] {
    const result: { start: bigint; end: bigint }[] = [];
    const add = (start: bigint, end: bigint) => {
      if (
        start < 0n ||
        end < start ||
        end > (die.unit.addressSize === 8 ? MAX_ADDRESS : 0xffffffffn)
      )
        throw new Error('Invalid function address range');
      if (end > start) result.push({ start, end });
      if (result.length > 100_000) throw new Error('Function range count limit exceeded');
    };
    const lowAttr = die.attributes.get(0x11),
      highAttr = die.attributes.get(0x12),
      listAttr = die.attributes.get(0x55);
    const low = lowAttr && value(die, lowAttr),
      high = highAttr && { owner: die, attribute: highAttr },
      list = listAttr && { owner: die, attribute: listAttr };
    if (list && typeof list.attribute.value === 'bigint') {
      const unit = list.owner.unit;
      if (!(
        list.attribute.form === 0x17 ||
        (unit.version >= 5 && list.attribute.form === 0x23) ||
        (unit.version < 4 && [6, 7].includes(list.attribute.form))
      )) {
        throw new Error(
          `Unsupported DWARF range-list attribute form 0x${list.attribute.form.toString(16)}`,
        );
      }
      let currentBase = attribute(unit.root!, 0x11);
      if (typeof currentBase !== 'bigint') currentBase = 0n;
      if (unit.version < 5) {
        const r = sectionReader(sections, '__debug_ranges', number(list.attribute.value), little),
          max = (1n << BigInt(unit.addressSize * 8)) - 1n;
        for (let i = 0; i < 100_000; i++) {
          spend();
          const start = r.uint(unit.addressSize),
            end = r.uint(unit.addressSize);
          if (!start && !end) return result;
          if (start === max) currentBase = end;
          else add(currentBase + start, currentBase + end);
        }
      } else {
        const r = listReader(
          unit,
          '__debug_rnglists',
          list.attribute.value,
          list.attribute.form === 0x23,
          0x74,
        );
        for (let i = 0; i < 100_000; i++) {
          spend();
          const kind = r.u8();
          if (kind === 0) return result;
          if (kind === 1) currentBase = indexedAddress(unit, r.leb());
          else if (kind === 2) {
            const start = indexedAddress(unit, r.leb());
            add(start, indexedAddress(unit, r.leb()));
          } else if (kind === 3) {
            const start = indexedAddress(unit, r.leb());
            add(start, start + r.leb());
          } else if (kind === 4) {
            const start = r.leb();
            add(currentBase + start, currentBase + r.leb());
          } else if (kind === 5) currentBase = r.uint(unit.addressSize);
          else if (kind === 6) {
            const start = r.uint(unit.addressSize);
            add(start, r.uint(unit.addressSize));
          } else if (kind === 7) {
            const start = r.uint(unit.addressSize);
            add(start, start + r.leb());
          } else throw new Error(`Unsupported DWARF range-list opcode ${kind}`);
        }
      }
      throw new Error('Range-list entry limit exceeded or missing terminator');
    }
    if (typeof low === 'bigint' && high) {
      const end = value(high.owner, high.attribute);
      if (typeof end === 'bigint')
        add(low, ADDRESS_FORMS.includes(high.attribute.form) ? end : low + end);
    }
    return result;
  }

  const id = (die: Die) => `die-${die.offset.toString(16)}`;
  function arrayShape(die: Die): {
    dimensions: (bigint | null)[];
    elementCount: number | undefined;
  } {
    const dimensions: (bigint | null)[] = [];
    let total: bigint | undefined = 1n;
    for (const dimension of die.children.filter((child) => child.tag === 0x21)) {
      spend();
      const count = attribute(dimension, 0x37),
        upper = attribute(dimension, 0x2f),
        lower = attribute(dimension, 0x22);
      let length: bigint | undefined = typeof count === 'bigint' ? count : undefined;
      if (length === undefined && typeof upper === 'bigint') {
        const language = attribute(die.unit.root!, 0x13);
        const zeroBased =
          language === undefined ||
          (typeof language === 'bigint' &&
            [1n, 2n, 4n, 0xcn, 0x10n, 0x11n, 0x1an, 0x1dn, 0x21n, 0x2an, 0x2bn, 0x2cn].includes(
              language,
            ));
        if (typeof lower === 'bigint' || (lower === undefined && zeroBased))
          length = upper - (typeof lower === 'bigint' ? lower : 0n) + 1n;
      }
      if (length === undefined || length < 0n || length > MAX_ADDRESS) {
        if (length !== undefined) diagnose(`Invalid array dimension at ${id(die)}`);
        dimensions.push(null);
        total = undefined;
      } else {
        dimensions.push(length);
        if (total !== undefined) {
          total *= length;
          if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
            diagnose(`Array element count exceeds safe bounds at ${id(die)}`);
            total = undefined;
          }
        }
      }
    }
    return {
      dimensions,
      elementCount: dimensions.length && total !== undefined ? Number(total) : undefined,
    };
  }
  function typeMembers(die: Die): DebugType['members'] {
    if (![2, 19, 23].includes(die.tag)) return undefined;
    return die.children
      .filter((child) => child.tag === 0xd)
      .map((child) => {
        const member: NonNullable<DebugType['members']>[number] = {
          name: text(child, 3) ?? '<anonymous>',
        };
        try {
          const target = typeTarget(child),
            offset = attribute(child, 0x38),
            bits = attribute(child, 0xd),
            bitOffset = attribute(child, 0x6b) ?? attribute(child, 0xc);
          member.typeId = target && id(target);
          member.byteOffset =
            typeof offset === 'bigint'
              ? number(offset, 'member offset')
              : offset instanceof Uint8Array
                ? memberOffset(offset, little)
                : die.tag === 23
                  ? 0
                  : undefined;
          member.bitSize = typeof bits === 'bigint' ? number(bits, 'member bit size') : undefined;
          member.bitOffset =
            typeof bitOffset === 'bigint' ? number(bitOffset, 'member bit offset') : undefined;
        } catch (error) {
          if (error instanceof OperationError) throw error;
          diagnose(`Member at ${id(child)}: ${String(error)}`);
        }
        return member;
      });
  }
  const functions: DebugFunction[] = [],
    types: DebugType[] = [],
    lines: DebugSymbols['lines'] = [];
  const variables: DebugVariable[] = [],
    inlineScopes: DebugInlineScope[] = [];
  const functionsByDie = new Map<number, DebugFunction>();
  for (const die of dies.values()) {
    if (work > DWARF_LIMITS.steps || renderedCharacters > 64 * 1024 * 1024) break;
    try {
      if (TYPE_KINDS[die.tag]) {
        const name = typeDeclaration(die),
          target = typeTarget(die),
          byteSize = attribute(die, 0xb);
        let detail = name;
        if ([2, 19, 23].includes(die.tag)) {
          detail = `${TYPE_KINDS[die.tag]} ${name} { ${die.children
            .filter((child) => child.tag === 0xd)
            .map((child) => {
              const offset = attribute(child, 0x38),
                bits = attribute(child, 0xd),
                bitOffset = attribute(child, 0x6b) ?? attribute(child, 0xc);
              return `${typeDeclaration(typeTarget(child), text(child, 3) ?? '<anonymous>')}${typeof bits === 'bigint' ? ` : ${bits}` : ''}${typeof offset === 'bigint' ? ` @ +${offset}` : offset instanceof Uint8Array ? ' @ DWARF expression (not evaluated)' : ''}${typeof bitOffset === 'bigint' ? ` bit ${bitOffset}` : ''}`;
            })
            .join('; ')} }`;
        } else if (die.tag === 4)
          detail = `enum ${name} { ${die.children
            .filter((child) => child.tag === 0x28)
            .map(
              (child) =>
                `${text(child, 3) ?? '<anonymous>'} = ${String(attribute(child, 0x1c) ?? '?')}`,
            )
            .join(', ')} }`;
        else if (die.tag === 22) detail = `typedef ${typeDeclaration(target, name)}`;
        else if (die.tag === 21) detail = typeDeclaration(die);
        else if (die.tag === 36)
          detail = `${name}; encoding ${String(attribute(die, 0x3e) ?? 'unspecified')}`;
        types.push({
          id: id(die),
          name,
          kind: TYPE_KINDS[die.tag]!,
          encoding:
            typeof attribute(die, 0x3e) === 'bigint'
              ? number(attribute(die, 0x3e) as bigint)
              : undefined,
          alignment:
            typeof attribute(die, 0x88) === 'bigint'
              ? number(attribute(die, 0x88) as bigint)
              : undefined,
          byteSize:
            typeof byteSize === 'bigint'
              ? number(byteSize, 'type byte size')
              : die.tag === 15
                ? die.unit.addressSize
                : undefined,
          detail,
          targetTypeId: target && id(target),
          members: typeMembers(die),
          ...(die.tag === 1 ? arrayShape(die) : {}),
        });
      }
      if (die.tag === 0x2e) {
        const name =
          text(die, 3) ?? text(die, 0x6e) ?? text(die, 0x2007) ?? `<subprogram ${id(die)}>`;
        const codeRanges = normalizeRanges(ranges(die), spend);
        if (!codeRanges.length) continue;
        const fn: DebugFunction = {
          id: id(die),
          name,
          address: codeRanges[0]!.start,
          size: codeRanges[0]!.end - codeRanges[0]!.start,
          ranges: codeRanges,
          prototype: typeDeclaration(typeTarget(die), `${name}(${parameters(die).join(', ')})`),
          signature: functionSignature(die),
        };
        fn.frameBase = locations(die, 0x40, codeRanges);
        functions.push(fn);
        functionsByDie.set(die.offset, fn);
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnose(`DIE at 0x${die.offset.toString(16)}: ${String(error)}`);
    }
  }
  const lineOffsets = new Map<number, Map<number, string>>();
  const unitFiles = new Map<Unit, Map<number, string>>();
  const lineTextBudget = textBudget;
  for (const unit of units) {
    if (work > DWARF_LIMITS.steps || renderedCharacters > 64 * 1024 * 1024) break;
    try {
      const statementList = attribute(unit.root!, 0x10);
      if (typeof statementList !== 'bigint') continue;
      const offset = number(statementList);
      const cached = lineOffsets.get(offset);
      if (cached) {
        unitFiles.set(unit, cached);
        continue;
      }
      const result = readLineProgram(
        sections,
        offset,
        unit.addressSize,
        text(unit.root!, 0x1b) ?? '',
        little,
        DWARF_LIMITS.rows - lines.length,
        spend,
        lineTextBudget,
      );
      lineOffsets.set(offset, result.files);
      unitFiles.set(unit, result.files);
      for (const row of result.lines) lines.push(row);
      for (const message of result.diagnostics) diagnose(message);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnose(`Line program for CU 0x${unit.start.toString(16)}: ${String(error)}`);
    }
  }
  function sourceFile(die: Die, key: number): string | undefined {
    const found = inherited(die, key);
    if (!found) return undefined;
    const index = value(found.owner, found.attribute);
    if (typeof index !== 'bigint') return undefined;
    const files = unitFiles.get(found.owner.unit);
    if (!files) return undefined;
    const path = files.get(number(index, 'source file index'));
    if (path === undefined && !(found.owner.unit.version < 5 && index === 0n))
      diagnose(`Invalid source file index ${index} at ${id(die)}`);
    return path;
  }
  function sourceLine(die: Die, key: number): number | undefined {
    const line = attribute(die, key);
    return typeof line === 'bigint' && line > 0n ? number(line, 'source line') : undefined;
  }
  function visit(die: Die, fn?: DebugFunction, scope?: DebugRange[], inlineId?: string): void {
    spend();
    try {
      if (die.tag === 0x2e) {
        fn = functionsByDie.get(die.offset);
        if (!fn) return; // Abstract/declaration parameters are not global storage.
        scope = fn.ranges;
        inlineId = undefined;
      } else if (die.tag === 0x1d || die.tag === 0xb || die.tag === 0x32) {
        const hasRanges =
          die.attributes.has(0x55) || die.attributes.has(0x11) || die.attributes.has(0x12);
        if (hasRanges || die.tag === 0x1d) {
          const own = normalizeRanges(ranges(die), spend);
          scope = scope === undefined ? own : intersectRanges(scope, own, spend);
        }
        if (die.tag === 0x1d) {
          if (!fn || !scope?.length) return;
          const name = text(die, 3) ?? text(die, 0x6e) ?? `<inline ${id(die)}>`;
          inlineScopes.push({
            id: id(die),
            name,
            functionAddress: fn.address,
            ranges: scope,
            parentId: inlineId,
            callFile: sourceFile(die, 0x58),
            callLine: sourceLine(die, 0x59),
          });
          inlineId = id(die);
        }
      }
      if (die.tag === 0x34 || (die.tag === 5 && fn)) {
        const name = text(die, 3) ?? `<variable ${id(die)}>`;
        const target = typeTarget(die),
          startScope = die.attributes.get(0x2c);
        let validScope = scope;
        if (startScope) {
          if (
            scope?.length &&
            typeof startScope.value === 'bigint' &&
            [5, 6, 7, 0xb, 0xf].includes(startScope.form)
          ) {
            const start = scope[0]!.start + startScope.value;
            validScope = scope.flatMap((range) => {
              spend();
              return range.end > start
                ? [{ start: range.start > start ? range.start : start, end: range.end }]
                : [];
            });
          } else {
            diagnose(`Unsupported DWARF start_scope at ${id(die)}`);
            validScope = [];
          }
        }
        variables.push({
          id: id(die),
          name,
          typeId: target && id(target),
          functionAddress: fn?.address,
          scopeId: inlineId,
          parameter: die.tag === 5,
          locations: locations(die, 2, validScope),
          file: sourceFile(die, 0x3a),
          line: sourceLine(die, 0x3b),
        });
      }
      // Type children describe declarations, not concrete parameter storage.
      if (TYPE_KINDS[die.tag]) return;
      for (const child of die.children) visit(child, fn, scope, inlineId);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnose(`Scope at ${id(die)}: ${String(error)}`);
    }
  }
  for (const unit of units) {
    if (work > DWARF_LIMITS.steps || renderedCharacters > DWARF_LIMITS.text) break;
    try {
      visit(unit.root!);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      diagnose(`Variables for CU 0x${unit.start.toString(16)}: ${String(error)}`);
    }
  }
  if (sections.has('__debug_types'))
    diagnose(
      'DWARF .debug_types signature units are unsupported; compilation-unit types remain available.',
    );
  functions.sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : a.name.localeCompare(b.name),
  );
  lines.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { functions, types, lines, diagnostics, variables, inlineScopes };
}
