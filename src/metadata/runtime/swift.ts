import type { RuntimeKind } from './model.js';
import { RuntimeIssue, RuntimeReader } from './reader.js';

interface SwiftContext {
  readonly name: string;
  readonly kind: number;
  readonly fields: bigint | null;
}
export class SwiftRecovery {
  static readonly sections: ReadonlySet<string> = new Set(['__swift5_types', '__swift5_fieldmd']);
  readonly contexts = new Map<bigint, SwiftContext>();
  readonly active = new Set<bigint>();
  readonly owners = new Map<bigint, Set<string>>();
  readonly attemptedFields = new Set<bigint>();
  readonly fieldRanges: { start: bigint; end: bigint }[] = [];
  constructor(readonly r: RuntimeReader) {}

  context(address: bigint, depth = 0): SwiftContext {
    const r = this.r;
    r.depth(depth, address);
    if (this.active.has(address))
      throw new RuntimeIssue('malformed_image', 'Cyclic Swift context descriptor', address);
    const known = this.contexts.get(address);
    if (known) return known;
    const flags = r.u32(address),
      kind = flags & 0x1f;
    if (((flags >>> 8) & 0xff) !== 0)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Unsupported Swift context descriptor version',
        address,
      );
    if (![0, 1, 3, 16, 17, 18].includes(kind))
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Unsupported Swift context descriptor kind',
        address,
      );
    const size = kind <= 1 ? 12n : kind === 3 ? 24n : kind === 16 ? 44n : 28n;
    r.file(address, size);
    this.active.add(address);
    try {
      const parentAddress = r.relative(address + 4n, true),
        parent = parentAddress === null ? null : this.context(parentAddress, depth + 1).name;
      const nameAddress = r.relative(address + 8n);
      if (nameAddress === null)
        throw new RuntimeIssue('malformed_image', 'Missing Swift context name', address);
      const local = r.text(nameAddress, kind === 1),
        name = parent === null ? local : `${parent}.${local}`;
      if (name.length > 4096)
        throw new RuntimeIssue(
          'resource_limit',
          'Qualified Swift context name bound reached',
          address,
        );
      const fields = kind < 16 ? null : r.relative(address + 16n),
        value: SwiftContext = { name, kind, fields };
      const recordKind: RuntimeKind =
        kind === 0
          ? 'swift_module'
          : kind === 1
            ? 'swift_extension'
            : kind === 3
              ? 'swift_protocol'
              : kind === 16
                ? 'swift_class'
                : kind === 17
                  ? 'swift_structure'
                  : 'swift_enum';
      r.add(recordKind, local, address, size, {
        ...(parent === null ? {} : { owner: parent }),
        encoding: kind === 1 ? 'swift-mangled' : null,
        flags: BigInt(flags),
      });
      this.contexts.set(address, value);
      if (fields !== null) {
        let owners = this.owners.get(fields);
        if (!owners) {
          owners = new Set();
          this.owners.set(fields, owners);
        }
        if (owners.size && !owners.has(name))
          r.report(
            new RuntimeIssue(
              'unavailable_semantics',
              'Different Swift contexts reference the same field descriptor; all owners are retained',
              fields,
            ),
          );
        owners.add(name);
      }
      if (parentAddress !== null)
        r.add('swift_parent', parent!, address + 4n, 4n, { owner: name, target: parentAddress });
      if (kind === 16)
        r.attempt(() => {
          const superclass = r.relative(address + 20n);
          if (superclass !== null)
            r.add('swift_superclass', r.text(superclass, true), address + 20n, 4n, {
              owner: name,
              target: superclass,
              encoding: 'swift-mangled',
            });
        });
      return value;
    } finally {
      this.active.delete(address);
    }
  }

  fields(address: bigint, sectionEnd: bigint, checkOverlap = false): bigint {
    const r = this.r;
    this.attemptedFields.add(address);
    r.file(address, 16n);
    const kind = r.u16(address + 8n),
      stride = r.u16(address + 10n),
      count = r.count(BigInt(r.u32(address + 12n)), address);
    if (kind > 7 || stride < 12)
      throw new RuntimeIssue(
        'unavailable_semantics',
        'Unsupported Swift field descriptor kind or stride',
        address,
      );
    const end = address + 16n + BigInt(count * stride);
    if (end > sectionEnd)
      throw new RuntimeIssue(
        'malformed_image',
        'Swift field descriptor crosses its declared section',
        address,
      );
    if (checkOverlap)
      for (const range of this.fieldRanges) {
        r.context.checkpoint(1);
        if (address < range.end && range.start < end)
          throw new RuntimeIssue(
            'malformed_image',
            'Swift field reference overlaps another descriptor',
            address,
          );
      }
    if (count) r.file(address + 16n, BigInt(count * stride));
    const typeAddress = r.relative(address),
      mangled = typeAddress === null ? null : r.text(typeAddress, true);
    const owners = [...(this.owners.get(address) ?? [])];
    if (owners.length === 0) owners.push(mangled ?? '');
    if (count * owners.length > r.limits.max_records - r.records.length)
      throw new RuntimeIssue(
        'resource_limit',
        'Swift field records exceed the remaining metadata record bound',
        address,
      );
    const pending: { address: bigint; name: string; type: string | null; flags: bigint }[] = [];
    for (let index = 0; index < count; index++) {
      r.context.checkpoint(1);
      const entry = address + 16n + BigInt(index * stride),
        flags = r.u32(entry),
        nameAddress = r.relative(entry + 8n),
        type = r.relative(entry + 4n);
      if (nameAddress === null)
        throw new RuntimeIssue('malformed_image', 'Missing Swift field name', entry);
      pending.push({
        address: entry,
        name: r.text(nameAddress),
        type: type === null ? null : r.text(type, true),
        flags: BigInt(flags),
      });
    }
    // Validate the entire descriptor before publishing any of its field names.
    const superAddress = r.relative(address + 4n),
      superclass = superAddress === null ? null : r.text(superAddress, true);
    for (const owner of owners) {
      const ownership = owner ? { owner } : {};
      if (mangled !== null)
        r.add('swift_field_descriptor', mangled, address, 16n, {
          ...ownership,
          type: mangled,
          encoding: 'swift-mangled',
          flags: BigInt(kind),
        });
      if (superclass !== null)
        r.add('swift_superclass', superclass, address + 4n, 4n, {
          ...ownership,
          target: superAddress,
          encoding: 'swift-mangled',
        });
      for (const field of pending)
        r.add(
          kind === 2 || kind === 3 ? 'swift_enum_case' : 'swift_field',
          field.name,
          field.address,
          12n,
          { ...ownership, type: field.type, encoding: 'swift-mangled', flags: field.flags },
        );
    }
    this.fieldRanges.push({ start: address, end });
    return end;
  }

  run(): void {
    const r = this.r;
    for (const section of r.sections)
      if (section.name === '__swift5_types')
        r.attempt(() => {
          const start = section.virtual_range.start.value,
            size = section.virtual_range.size;
          if (size % 4n)
            throw new RuntimeIssue(
              'malformed_image',
              'Misaligned Swift type reference array',
              start,
            );
          const count = r.count(size / 4n, start);
          r.file(start, size);
          for (let index = 0; index < count; index++)
            r.attempt(() => {
              const slot = start + BigInt(index * 4);
              if ((r.u32(slot) & 3) > 1)
                throw new RuntimeIssue(
                  'unavailable_semantics',
                  'Unsupported Objective-C reference kind in Swift type metadata',
                  slot,
                );
              const target = r.relative(slot, true);
              if (target === null) return;
              if (![16, 17, 18].includes(r.u32(target) & 0x1f))
                throw new RuntimeIssue(
                  'malformed_image',
                  'Swift type reference does not identify a nominal type',
                  slot,
                );
              this.context(target);
            });
        });
    const sections = r.sections.filter((section) => section.name === '__swift5_fieldmd');
    for (const section of sections)
      r.attempt(() => {
        const end = section.virtual_range.start.value + section.virtual_range.size;
        let address = section.virtual_range.start.value;
        while (address < end) {
          r.context.checkpoint(1);
          if (end - address < 16n)
            throw new RuntimeIssue(
              'malformed_image',
              'Truncated Swift field descriptor header',
              address,
            );
          address = this.fields(address, end);
        }
      });
    for (const address of this.owners.keys())
      r.attempt(() => {
        if (this.attemptedFields.has(address)) return;
        const section = r.section(address, 16n);
        if (section.name !== '__swift5_fieldmd')
          throw new RuntimeIssue(
            'malformed_image',
            'Swift field reference is outside its declared field section',
            address,
          );
        this.fields(address, section.virtual_range.start.value + section.virtual_range.size, true);
      });
  }
}
