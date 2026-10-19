import type { Section } from '../../core/index.js';
import { RuntimeIssue, RuntimeReader } from './reader.js';

export class ObjCRecovery {
  static readonly sections: ReadonlySet<string> = new Set([
    '__objc_classlist',
    '__objc_nlclslist',
    '__objc_catlist',
    '__objc_nlcatlist',
    '__objc_protolist',
    '__objc_selrefs',
    '__objc_classrefs',
    '__objc_superrefs',
  ]);
  /** Non-pointer-array Objective-C sections with their own record layouts. */
  static readonly auxiliary: ReadonlySet<string> = new Set(['__objc_stubs', '__cfstring']);
  readonly classes = new Map<bigint, { name: string; metaclass: boolean }>();
  readonly activeClasses = new Set<bigint>();
  readonly protocols = new Map<bigint, string>();
  readonly activeProtocols = new Set<bigint>();
  constructor(readonly r: RuntimeReader) {}

  name(slot: bigint, allowEmpty = false): string {
    const value = this.r.pointer(slot);
    if (value === null)
      throw new RuntimeIssue('malformed_image', 'Missing Objective-C metadata name pointer', slot);
    return this.r.text(value, false, allowEmpty);
  }

  classAt(slot: bigint, depth: number): { name: string; target: bigint | null } | null {
    this.r.file(slot, 8n);
    const external = this.r.externalClasses.get(slot),
      fixup = this.r.fixups.get(slot);
    if (external !== undefined) {
      if (external === null || fixup?.conflicting || fixup?.external === false)
        throw new RuntimeIssue(
          'unavailable_semantics',
          'Conflicting Objective-C class reference identities',
          slot,
        );
      return { name: external, target: null };
    }
    const target = this.r.pointer(slot);
    return target === null ? null : { name: this.classInfo(target, depth), target };
  }

  methods(address: bigint | null, owner: string, classMethod: boolean, declaration = false): void {
    if (address === null) return;
    const r = this.r,
      flags = r.u32(address),
      count = r.count(BigInt(r.u32(address + 4n)), address);
    const small = (flags & 0x80000000) !== 0,
      direct = (flags & 0x40000000) !== 0,
      stride = flags & 0xfffc;
    if (stride < (small ? 12 : 24))
      throw new RuntimeIssue(
        'malformed_image',
        'Invalid Objective-C method record stride',
        address,
      );
    if (count) r.file(address + 8n, BigInt(count * stride));
    for (let index = 0; index < count; index++)
      r.attempt(() => {
        const entry = address + 8n + BigInt(index * stride);
        let selector: bigint | null, type: bigint | null, implementation: bigint | null;
        if (small) {
          selector = r.relative(entry);
          if (!direct && selector !== null) selector = r.pointer(selector);
          type = r.relative(entry + 4n);
          implementation = declaration ? null : r.relative(entry + 8n);
        } else {
          selector = r.pointer(entry);
          type = r.pointer(entry + 8n);
          implementation = declaration ? null : r.pointer(entry + 16n);
        }
        if (selector === null)
          throw new RuntimeIssue('malformed_image', 'Missing Objective-C method selector', entry);
        const name = r.text(selector);
        r.add(
          declaration ? 'objc_method_declaration' : 'objc_method',
          name,
          entry,
          BigInt(stride),
          {
            owner,
            target: implementation,
            target_role: declaration ? 'unresolved' : 'code',
            method_kind: classMethod ? 'class' : 'instance',
            type: type === null ? null : r.text(type, false, true),
            encoding: 'objc',
            flags: BigInt(flags),
            symbol: `${classMethod ? '+' : '-'}[${owner} ${name}]`,
          },
        );
      });
  }

  ivars(address: bigint | null, owner: string): void {
    if (address === null) return;
    const r = this.r,
      stride = r.u32(address),
      count = r.count(BigInt(r.u32(address + 4n)), address);
    if (stride < 32)
      throw new RuntimeIssue('malformed_image', 'Invalid Objective-C ivar stride', address);
    if (count) r.file(address + 8n, BigInt(count * stride));
    for (let index = 0; index < count; index++)
      r.attempt(() => {
        const entry = address + 8n + BigInt(index * stride),
          name = this.name(entry + 8n),
          type = this.name(entry + 16n, true);
        r.add('objc_ivar', name, entry, BigInt(stride), {
          owner,
          type: type || null,
          encoding: 'objc',
        });
      });
  }

  adopted(address: bigint | null, owner: string, depth: number): void {
    if (address === null) return;
    const r = this.r,
      count = r.count(r.u64(address), address);
    if (count) r.file(address + 8n, BigInt(count * 8));
    for (let index = 0; index < count; index++)
      r.attempt(() => {
        const slot = address + 8n + BigInt(index * 8),
          target = r.pointer(slot);
        if (target === null) return;
        const name = this.protocol(target, depth + 1);
        r.add('objc_protocol_adoption', name, slot, 8n, { owner, target });
      });
  }

  protocol(address: bigint, depth: number): string {
    const r = this.r;
    r.depth(depth, address);
    if (this.activeProtocols.has(address))
      throw new RuntimeIssue('malformed_image', 'Cyclic Objective-C protocol adoption', address);
    const known = this.protocols.get(address);
    if (known !== undefined) return known;
    r.file(address, 72n);
    const size = r.u32(address + 64n);
    if (size < 72)
      throw new RuntimeIssue(
        'malformed_image',
        'Truncated Objective-C protocol descriptor',
        address,
      );
    r.file(address, BigInt(size));
    const name = this.name(address + 8n);
    this.activeProtocols.add(address);
    try {
      r.add('objc_protocol', name, address, 72n);
      r.attempt(() => this.adopted(r.pointer(address + 16n), name, depth));
      for (const [offset, classMethod] of [
        [24n, false],
        [32n, true],
        [40n, false],
        [48n, true],
      ] as const)
        r.attempt(() => this.methods(r.pointer(address + offset), name, classMethod, true));
      this.protocols.set(address, name);
      return name;
    } finally {
      this.activeProtocols.delete(address);
    }
  }

  classInfo(address: bigint, depth = 0, metaclass = false, instanceOwner?: string): string {
    const r = this.r;
    r.depth(depth, address);
    if (this.activeClasses.has(address))
      throw new RuntimeIssue('malformed_image', 'Cyclic Objective-C class metadata', address);
    const known = this.classes.get(address);
    if (known) {
      if (known.metaclass !== metaclass)
        throw new RuntimeIssue(
          'malformed_image',
          'Objective-C class/metaclass relationship mismatch',
          address,
        );
      return known.name;
    }
    r.file(address, 40n);
    const data = r.pointer(address + 32n);
    if (data === null)
      throw new RuntimeIssue('malformed_image', 'Missing Objective-C class data', address);
    if (data & 0x8000000000000000n)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Realized class_rw data is not static class_ro metadata',
        address,
      );
    const ro = data & 0x00007ffffffffff8n;
    r.file(ro, 72n);
    const flags = r.u32(ro);
    if (flags & 0xe0000000)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Dynamic Objective-C class flags are unsupported',
        ro,
      );
    if (((flags & 1) !== 0) !== metaclass)
      throw new RuntimeIssue('malformed_image', 'Objective-C class_ro metaclass flag mismatch', ro);
    const name = this.name(ro + 24n);
    this.activeClasses.add(address);
    try {
      r.add(metaclass ? 'objc_metaclass' : 'objc_class', name, address, 40n, {
        ...(instanceOwner === undefined ? {} : { owner: instanceOwner }),
        flags: BigInt(flags),
      });
      this.classes.set(address, { name, metaclass });
      // Root metaclasses point back into root classes; that runtime cycle is not an inheritance traversal.
      if (!metaclass)
        r.attempt(() => {
          const superclass = this.classAt(address + 8n, depth + 1);
          if (superclass)
            r.add('objc_superclass_reference', superclass.name, address + 8n, 8n, {
              owner: name,
              target: superclass.target,
            });
        });
      r.attempt(() => this.methods(r.pointer(ro + 32n), instanceOwner ?? name, metaclass));
      r.attempt(() => this.adopted(r.pointer(ro + 40n), instanceOwner ?? name, depth));
      if (!metaclass) r.attempt(() => this.ivars(r.pointer(ro + 48n), name));
      if (!metaclass)
        r.attempt(() => {
          const isa = r.pointer(address);
          if (isa !== null) {
            this.classInfo(isa, depth + 1, true, name);
            r.add('objc_metaclass_link', name, address, 8n, { owner: name, target: isa });
          }
        });
      return name;
    } finally {
      this.activeClasses.delete(address);
    }
  }

  category(address: bigint): void {
    const r = this.r;
    r.file(address, 48n);
    const name = this.name(address),
      target = this.classAt(address + 8n, 0);
    if (target === null)
      throw new RuntimeIssue('malformed_image', 'Missing Objective-C category class', address);
    const owner = `${target.name}(${name})`;
    r.add('objc_category', name, address, 48n, { owner: target.name, target: target.target });
    r.attempt(() => this.methods(r.pointer(address + 16n), owner, false));
    r.attempt(() => this.methods(r.pointer(address + 24n), owner, true));
    r.attempt(() => this.adopted(r.pointer(address + 32n), owner, 0));
  }

  run(): void {
    const r = this.r;
    for (const section of r.sections)
      if (ObjCRecovery.sections.has(section.name))
        r.attempt(() => {
          const start = section.virtual_range.start.value,
            size = section.virtual_range.size;
          if (size % 8n)
            throw new RuntimeIssue(
              'malformed_image',
              'Misaligned Objective-C pointer array',
              start,
            );
          const count = r.count(size / 8n, start);
          r.file(start, size);
          for (let index = 0; index < count; index++)
            r.attempt(() => {
              const slot = start + BigInt(index * 8);
              if (section.name === '__objc_classrefs' || section.name === '__objc_superrefs') {
                const target = this.classAt(slot, 0);
                if (target)
                  r.add(
                    section.name === '__objc_superrefs'
                      ? 'objc_superclass_reference'
                      : 'objc_class_reference',
                    target.name,
                    slot,
                    8n,
                    { target: target.target },
                  );
                return;
              }
              const target = r.pointer(slot);
              if (target === null) return;
              if (section.name === '__objc_classlist' || section.name === '__objc_nlclslist')
                this.classInfo(target);
              else if (section.name === '__objc_catlist' || section.name === '__objc_nlcatlist')
                this.category(target);
              else if (section.name === '__objc_protolist') this.protocol(target, 0);
              else r.add('objc_selector', r.text(target), slot, 8n, { target });
            });
        });
      else if (section.name === '__objc_stubs') r.attempt(() => this.selectorStubs(section));
      else if (section.name === '__cfstring') r.attempt(() => this.constantStrings(section));
  }

  /** Xcode 14+ `__objc_stubs`: `adrp x1, selref@PAGE; ldr x1, [x1, selref@PAGEOFF]`,
   * then either `adrp x16, _objc_msgSend@GOTPAGE; ldr x16, [x16, ...]; br x16`
   * (BRK-padded to 32 bytes) or `b _objc_msgSend`. Only a stub whose selector
   * slot lies in `__objc_selrefs` and whose transfer reaches the bound
   * `_objc_msgSend` import is published; the first unrecognized word stops the
   * section (its remaining stubs stay unnamed, reported as partial). */
  selectorStubs(section: Section): void {
    const r = this.r;
    if (r.image.target.architecture !== 'arm64') return;
    const start = section.virtual_range.start.value,
      end = start + section.virtual_range.size;
    r.file(start, section.virtual_range.size);
    const page = (at: bigint, word: number, register: number): bigint | null => {
      if ((word & 0x9f00001f) !== (0x90000000 | register)) return null;
      const immediate = ((word >>> 5) & 0x7ffff) * 4 + ((word >>> 29) & 3);
      const signed = immediate >= 0x100000 ? immediate - 0x200000 : immediate;
      return (at & ~0xfffn) + BigInt(signed) * 0x1000n;
    };
    const load = (word: number, register: number): bigint | null =>
      (word & 0xffc003ff) === (0xf9400000 | (register << 5) | register)
        ? BigInt(((word >>> 10) & 0xfff) * 8)
        : null;
    const words = (at: bigint, count: number): number[] | null => {
      if (at + BigInt(count * 4) > end) return null;
      return Array.from({ length: count }, (_, index) => r.u32(at + BigInt(index * 4)));
    };
    let cursor = start;
    while (cursor < end) {
      r.context.checkpoint(1);
      if ((r.u32(cursor) & 0xffe0001f) >>> 0 === 0xd4200000) {
        cursor += 4n; // BRK padding between stubs
        continue;
      }
      const head = words(cursor, 3);
      const selectorPage = head && page(cursor, head[0]!, 1),
        selectorOffset = head && load(head[1]!, 1);
      if (!head || selectorPage === null || selectorOffset === null)
        throw new RuntimeIssue('unavailable_semantics', 'Unrecognized Objective-C stub', cursor);
      let size: bigint, sends: boolean;
      if ((head[2]! & 0xfc000000) === 0x14000000) {
        const delta = head[2]! & 0x3ffffff,
          target = cursor + 8n + BigInt((delta >= 0x2000000 ? delta - 0x4000000 : delta) * 4);
        size = 12n;
        sends = r.importEntries.get(target) === '_objc_msgSend';
      } else {
        const tail = words(cursor + 8n, 3);
        const slotPage = tail && page(cursor + 8n, tail[0]!, 16),
          slotOffset = tail && load(tail[1]!, 16);
        if (!tail || slotPage === null || slotOffset === null || tail[2] !== 0xd61f0200)
          throw new RuntimeIssue('unavailable_semantics', 'Unrecognized Objective-C stub', cursor);
        size = 20n;
        sends = r.importSlots.get(slotPage + slotOffset) === '_objc_msgSend';
      }
      const stub = cursor;
      cursor += size;
      if (!sends)
        throw new RuntimeIssue(
          'unavailable_semantics',
          'Objective-C stub does not reach the bound _objc_msgSend import',
          stub,
        );
      r.attempt(() => {
        const slot = selectorPage + selectorOffset;
        if (r.section(slot, 8n).name !== '__objc_selrefs')
          throw new RuntimeIssue(
            'malformed_image',
            'Objective-C stub selector is outside __objc_selrefs',
            stub,
          );
        const selector = r.pointer(slot);
        if (selector === null)
          throw new RuntimeIssue('malformed_image', 'Objective-C stub selector is null', stub);
        const name = r.text(selector);
        r.add('objc_selector_stub', name, stub, size, {
          target: stub,
          target_role: 'code',
          symbol: `_objc_msgSend$${name}`,
        });
      });
    }
  }

  /** Compiler-emitted constant CFString/NSString objects: isa bound to
   * `___CFConstantStringClassReference`, 8-bit (0x7c8, ASCII) or UTF-16
   * (0x7d0) contents with an explicit length. No symbol is published. */
  constantStrings(section: Section): void {
    const r = this.r,
      start = section.virtual_range.start.value,
      size = section.virtual_range.size;
    if (size % 32n)
      throw new RuntimeIssue('malformed_image', 'Misaligned constant string section', start);
    const count = r.count(size / 32n, start);
    r.file(start, size);
    for (let index = 0; index < count; index++)
      r.attempt(() => {
        const at = start + BigInt(index * 32);
        if (r.importSlots.get(at) !== '___CFConstantStringClassReference')
          throw new RuntimeIssue(
            'unavailable_semantics',
            'Constant string class reference is not established',
            at,
          );
        const flags = r.u32(at + 8n),
          data = r.pointer(at + 16n),
          length = r.u64(at + 24n),
          wide = flags === 0x7d0;
        if ((flags !== 0x7c8 && !wide) || data === null)
          throw new RuntimeIssue('unavailable_semantics', 'Unsupported constant string', at);
        if (length > BigInt(r.limits.max_string_bytes)) return; // contents stay unpublished
        const bytes = length * (wide ? 2n : 1n);
        let text = '';
        if (bytes) {
          const raw = r.image.bytes.read(r.file(data, bytes), Number(bytes));
          r.stringBytes += raw.length;
          if (r.stringBytes > r.limits.max_total_string_bytes)
            throw new RuntimeIssue('resource_limit', 'Runtime string byte budget reached', at);
          if (!wide && raw.some((byte) => byte >= 0x80))
            throw new RuntimeIssue('malformed_image', 'Non-ASCII 8-bit constant string', at);
          try {
            text = new TextDecoder(wide ? 'utf-16le' : 'ascii', { fatal: true }).decode(raw);
          } catch {
            throw new RuntimeIssue('malformed_image', 'Constant string is not valid UTF-16', at);
          }
        }
        r.add('objc_string', text, at, 32n, { target: data, symbol: false });
      });
  }
}
