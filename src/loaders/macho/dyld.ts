import type { ImportRecord } from '../../core/index.js';
import { Cursor, MachOError, malformed, safe, vmEnd, type Payload } from './reader.js';
import { State } from './state.js';

interface Binding {
  name: string;
  library: string | null;
  addend: bigint;
  weak: boolean;
}
export function readDyld(
  s: State,
  streams: ReadonlyMap<string, Payload>,
  chained: Payload | undefined,
): void {
  const r = s.r;
  const slot = (segmentIndex: number, offset: bigint, width = 8) => {
    const segment = s.segments[segmentIndex];
    if (!segment || offset < 0n || offset + BigInt(width) > BigInt(segment.fileSize))
      malformed('Fixup slot outside file-backed segment');
    const p = segment.offset + safe(offset);
    s.readable(p, width);
    const va = segment.va + offset;
    if (
      !s.mappings.some(
        (mapping) => va >= mapping.va && va + BigInt(width) <= mapping.va + mapping.file_size,
      )
    )
      malformed('Fixup slot overlaps zero-fill or a mapping boundary');
    return { va: segment.va + offset, p };
  };
  const seen = new Map<bigint, { kind: string; signature: string }>();
  function emit(
    location: { va: bigint; p: number },
    mechanism: string,
    binding: Binding | null,
    target: bigint | null,
    auth: boolean,
    evidence: readonly string[],
    width = 64,
  ): void {
    r.context.checkpoint(1);
    if (s.relocations.length >= 100_000)
      throw new MachOError('resource_limit', 'Dyld fixup count exceeds 100,000');
    const signature = JSON.stringify([
      binding?.name,
      binding?.library,
      binding?.addend.toString(),
      target?.toString(),
    ]);
    const previous = seen.get(location.va);
    if (
      previous &&
      previous.signature !== signature &&
      !(mechanism === 'lazy bind' && previous.kind === 'rebase') &&
      mechanism !== 'weak bind'
    )
      s.warn(
        'Conflicting dyld fixups retained as conflicting evidence',
        'conflicting_evidence',
        evidence,
      );
    seen.set(location.va, { kind: mechanism, signature });
    let symbolId: string | null = null;
    if (binding) {
      symbolId = s.id('dyld_import', `${mechanism}:${location.va}`);
      const item: ImportRecord = {
        id: symbolId,
        original_name: binding.name,
        display_name: binding.name,
        library: binding.library,
        ordinal: null,
        slot: s.va(location.va),
        callable_entry: null,
        delayed: mechanism === 'lazy bind',
        weak: binding.weak,
        evidence_ids: [...evidence],
      };
      s.imports.push(item);
    }
    if (binding && (binding.addend < -(1n << 63n) || binding.addend >= 1n << 63n))
      malformed('Dyld addend exceeds signed 64 bits');
    if (target !== null) vmEnd(target, 0n);
    s.relocations.push({
      id: s.id('dyld_fixup', `${mechanism}:${location.va}`),
      address: s.va(location.va),
      kind: mechanism === 'chained' ? 'chained_fixup' : binding ? 'bind' : 'rebase',
      encoding: mechanism,
      width_bits: width,
      target: target === null ? null : s.va(target),
      symbol_id: symbolId,
      addend: binding?.addend ?? 0n,
      authenticated: auth,
      evidence_ids: [...evidence],
    });
  }
  for (const [kind, payload] of streams)
    s.optional(`Dyld ${kind}`, () => {
      s.readable(payload.offset, payload.size);
      const c = new Cursor(r, payload.offset, payload.offset + payload.size);
      let segment = -1,
        offset = 0n,
        type = 1,
        ordinal = kind === 'weak bind' ? -3 : 0,
        name = '',
        addend = 0n,
        weak = false,
        done = false;
      const rebase = kind === 'rebase',
        lazy = kind === 'lazy bind';
      const proof = s.proof(payload.offset, payload.size, `Dyld ${kind} opcode stream`);
      const repeat = (count: bigint, skip: bigint) => {
        if (count > BigInt(r.context.budget.work))
          throw new MachOError('resource_limit', 'Dyld repeat exceeds work budget');
        for (let i = 0n; i < count; i++) {
          if (![1, 2, 3].includes(type))
            throw new MachOError('unsupported_target', `Unsupported dyld fixup type ${type}`);
          const width = type === 1 ? 8 : 4;
          const location = slot(segment, offset, width);
          if (rebase) {
            const target =
              type === 1
                ? r.u64(location.p)
                : type === 2
                  ? BigInt(r.u32(location.p))
                  : location.va + 4n + BigInt.asIntN(32, BigInt(r.u32(location.p)));
            emit(
              location,
              kind,
              null,
              target,
              false,
              [...proof, ...s.proof(location.p, width, 'Dyld rebase word')],
              width * 8,
            );
          } else {
            if (!name) malformed('Bind has no symbol name');
            emit(
              location,
              kind,
              { name, library: s.library(ordinal), addend, weak },
              null,
              false,
              proof,
              width * 8,
            );
          }
          offset = vmEnd(offset, BigInt(width) + skip);
        }
      };
      while (c.p < c.end) {
        const byte = c.byte(),
          op = byte & 0xf0,
          imm = byte & 15;
        done = op === 0;
        if (done) {
          if (imm) malformed('Reserved DONE bits');
          if (!lazy) return;
          segment = -1;
          offset = 0n;
          type = 1;
          ordinal = 0;
          name = '';
          addend = 0n;
          weak = false;
          continue;
        }
        if (rebase) {
          switch (op) {
            case 0x10:
              type = imm;
              break;
            case 0x20:
              segment = imm;
              offset = c.leb();
              break;
            case 0x30:
              offset = vmEnd(offset, c.leb());
              break;
            case 0x40:
              offset = vmEnd(offset, BigInt(imm * 8));
              break;
            case 0x50:
              repeat(BigInt(imm), 0n);
              break;
            case 0x60:
              repeat(c.leb(), 0n);
              break;
            case 0x70:
              repeat(1n, c.leb());
              break;
            case 0x80: {
              const count = c.leb();
              repeat(count, c.leb());
              break;
            }
            default:
              throw new MachOError('unsupported_target', `Unsupported rebase opcode ${byte}`);
          }
        } else
          switch (op) {
            case 0x10:
              ordinal = imm;
              break;
            case 0x20:
              ordinal = safe(c.leb());
              break;
            case 0x30:
              ordinal = imm ? imm - 16 : 0;
              break;
            case 0x40:
              if (imm & ~9) malformed('Reserved bind symbol flags');
              name = c.string();
              weak = !!(imm & 1);
              break;
            case 0x50:
              type = imm;
              break;
            case 0x60:
              addend = c.leb(true);
              break;
            case 0x70:
              segment = imm;
              offset = c.leb();
              break;
            case 0x80:
              offset = vmEnd(offset, c.leb());
              break;
            case 0x90:
              repeat(1n, 0n);
              break;
            case 0xa0:
              repeat(1n, c.leb());
              break;
            case 0xb0:
              repeat(1n, BigInt(imm * 8));
              break;
            case 0xc0: {
              const count = c.leb();
              repeat(count, c.leb());
              break;
            }
            default:
              throw new MachOError(
                'unsupported_target',
                `Unsupported bind opcode ${byte}, including threaded binds`,
              );
          }
      }
      if (!lazy || !done) malformed('Dyld stream lacks terminating DONE');
    });
  if (!chained) return;
  s.optional('Dyld chained fixups', () => {
    const start = chained.offset,
      end = start + chained.size;
    const within = (p: number, size: number) => {
      if (p < start) malformed('Chained offset precedes payload');
      r.range(p, size, end);
      s.readable(p, size);
    };
    within(start, 28);
    const chainedProof = s.proof(
      start,
      chained.size,
      'Chained fixup header, starts, imports and symbol pool',
    );
    if (r.u32(start) !== 0)
      throw new MachOError('unsupported_version', 'Unsupported chained fixup version');
    const starts = start + r.u32(start + 4),
      imports = start + r.u32(start + 8),
      names = start + r.u32(start + 12),
      count = r.u32(start + 16),
      importFormat = r.u32(start + 20),
      symbolFormat = r.u32(start + 24);
    const bindings: Binding[] = [];
    s.optional('Chained imports', () => {
      if (!count) return;
      if (symbolFormat !== 0)
        throw new MachOError(
          'unsupported_target',
          `Unsupported chained symbol compression ${symbolFormat}`,
        );
      const stride = importFormat === 1 ? 4 : importFormat === 2 ? 8 : importFormat === 3 ? 16 : 0;
      if (!stride)
        throw new MachOError(
          'unsupported_target',
          `Unsupported chained import format ${importFormat}`,
        );
      if (imports < start + 28 || names < imports + count * stride)
        malformed('Chained import and symbol tables overlap');
      within(imports, count * stride);
      within(names, 0);
      for (let i = 0; i < count; i++) {
        r.context.checkpoint(1);
        const p = imports + i * stride,
          raw = importFormat === 3 ? r.u64(p) : BigInt(r.u32(p));
        const bits = importFormat === 3 ? 16 : 8,
          mask = (1 << bits) - 1,
          encoded = Number(raw & BigInt(mask));
        const ordinal = encoded > mask - 15 ? encoded - mask - 1 : encoded;
        if (importFormat === 3 && (raw >> 17n) & 0x7fffn) malformed('Reserved chained import bits');
        const nameOffset = names + Number(raw >> BigInt(importFormat === 3 ? 32 : 9));
        within(nameOffset, 1);
        const name = r.string(nameOffset, end);
        s.readable(nameOffset, name.next - nameOffset);
        bindings.push({
          name: name.text,
          library: s.library(ordinal),
          weak: !!(raw & (1n << BigInt(bits))),
          addend:
            importFormat === 1
              ? 0n
              : importFormat === 2
                ? BigInt.asIntN(32, BigInt(r.u32(p + 4)))
                : BigInt.asIntN(64, r.u64(p + 8)),
        });
      }
    });
    if (starts < start + 28) malformed('Chained starts overlap header');
    within(starts, 4);
    const segments = r.u32(starts);
    if (segments > s.segments.length) malformed('Chained starts exceed segment count');
    within(starts + 4, segments * 4);
    const visited = new Set<bigint>();
    for (let index = 0; index < segments; index++) {
      r.context.checkpoint(1);
      const relative = r.u32(starts + 4 + index * 4);
      if (!relative) continue;
      s.optional(`Chained segment ${index}`, () => {
        if (relative < 4 + segments * 4) malformed('Chained segment starts overlap index');
        const p = starts + relative;
        within(p, 22);
        const size = r.u32(p),
          pageSize = r.u16(p + 4),
          format = r.u16(p + 6),
          segmentOffset = r.u64(p + 8),
          pages = r.u16(p + 20),
          segment = s.segments[index]!;
        if (size < 22 + pages * 2 || size % 2) malformed('Invalid chained page table');
        within(p, size);
        if (
          (count &&
            p < imports + count * (importFormat === 3 ? 16 : importFormat === 2 ? 8 : 4) &&
            imports < p + size) ||
          (names >= start + 28 && p + size > names)
        )
          malformed('Chained starts overlap import/symbol tables');
        if ((pageSize !== 4096 && pageSize !== 16384) || ![1, 2, 6, 9, 12].includes(format))
          throw new MachOError(
            'unsupported_target',
            `Unsupported chained page size ${pageSize} or pointer format ${format}`,
          );
        if (
          r.u32(p + 16) !== 0 ||
          s.imageBase + segmentOffset !== segment.va ||
          (pages && BigInt((pages - 1) * pageSize) >= segment.size)
        )
          malformed('Chained segment bounds disagree with segment command');
        const arm = [1, 9, 12].includes(format),
          stride = arm ? 8 : 4;
        const proof = s.proof(p, size, `Chained starts pointer format ${format}`);
        const walk = (page: number, first: number) => {
          if (first >= pageSize || first % stride) malformed('Unaligned chained start');
          let inPage = first;
          while (true) {
            r.context.checkpoint(1);
            if (inPage + 8 > pageSize) malformed('Chained pointer crosses page');
            const location = slot(index, BigInt(page * pageSize + inPage));
            if (visited.has(location.va)) malformed('Repeated or overlapping chained slot');
            visited.add(location.va);
            const raw = r.u64(location.p),
              next = Number((raw >> 51n) & (arm ? 0x7ffn : 0xfffn));
            s.optional(`Chained slot ${location.va.toString(16)}`, () => {
              const bind = !!(raw & (1n << (arm ? 62n : 63n))),
                auth = arm && !!(raw & (1n << 63n));
              const evidence = [
                ...chainedProof,
                ...proof,
                ...s.proof(location.p, 8, `Chained pointer format ${format}`),
              ];
              if (bind) {
                const ordinalBits = format === 12 || !arm ? 24 : 16,
                  ordinal = Number(raw & ((1n << BigInt(ordinalBits)) - 1n));
                if (
                  arm
                    ? !!((raw >> BigInt(ordinalBits)) & ((1n << BigInt(32 - ordinalBits)) - 1n))
                    : !!((raw >> 32n) & 0x7ffffn)
                )
                  malformed('Reserved chained bind bits');
                const binding = bindings[ordinal];
                if (!binding) malformed('Invalid chained import ordinal');
                const addend = arm
                  ? auth
                    ? 0n
                    : BigInt.asIntN(19, (raw >> 32n) & 0x7ffffn)
                  : (raw >> 24n) & 255n;
                emit(
                  location,
                  'chained',
                  { ...binding, addend: binding.addend + addend },
                  null,
                  auth,
                  evidence,
                );
              } else {
                if (!arm && (raw >> 44n) & 0x7fn) malformed('Reserved chained rebase bits');
                const width = arm ? 43n : 36n,
                  target = (raw & ((1n << width) - 1n)) | (((raw >> width) & 255n) << 56n);
                emit(
                  location,
                  'chained',
                  null,
                  auth
                    ? s.imageBase + (raw & 0xffffffffn)
                    : format === 1 || format === 2
                      ? target
                      : s.imageBase + target,
                  auth,
                  evidence,
                );
              }
            });
            if (!next) break;
            const after = inPage + next * stride;
            if (after < inPage + 8 || after + 8 > pageSize)
              malformed('Chained next overlaps slot or escapes page');
            inPage = after;
          }
        };
        for (let page = 0; page < pages; page++) {
          r.context.checkpoint(1);
          const first = r.u16(p + 22 + page * 2);
          if (first === 0xffff) continue;
          s.optional(`Chained page ${page}`, () => {
            if (!(first & 0x8000)) {
              walk(page, first);
              return;
            }
            let overflow = first & 0x7fff;
            if (overflow < pages) malformed('Multi-start overlaps primary table');
            while (true) {
              r.context.checkpoint(1);
              const q = p + 22 + overflow++ * 2;
              r.range(q, 2, p + size);
              const entry = r.u16(q);
              walk(page, entry & 0x7fff);
              if (entry & 0x8000) break;
            }
          });
        }
      });
    }
  });
}
