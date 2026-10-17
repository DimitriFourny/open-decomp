import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  type LoadedImage,
} from '../../src/core/index.js';
import { MachOLoader } from '../../src/loaders/macho/index.js';
import { PELoader } from '../../src/loaders/pe/index.js';

export function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}
export function loadBytes(data: Uint8Array): LoadedImage {
  const sha256 = contentHash(data),
    image_id = imageIdentity(sha256),
    bytes = new ImmutableBytes(data);
  return (data[0] === 0x4d && data[1] === 0x5a ? new PELoader() : new MachOLoader()).load(
    { image_id, sha256, bytes, slice_id: null },
    createOperationContext(),
  );
}
export function fixtureImage(name: string): LoadedImage {
  return loadBytes(fixtureBytes(name));
}
export function fileAt(image: LoadedImage, value: bigint): number {
  const result = image.address_map.translate({ image_id: image.id, space: 'va', value }, 'file');
  assert.equal(result.kind, 'mapped');
  return Number(result.address.value);
}
export const BASE = 0x100000000n;
export interface RuntimeFixtureOptions {
  encrypted?: { offset: number; size: number };
  data_in_code?: { offset: number; size: number };
  chained?: boolean;
}

/** Actual Mach-O bytes, not mocked LoadedImage structures. Ported from the
 * existing project's metadata boundary corpus, using the new real loader. */
export function runtimeBytes(
  sections: { name: string; offset: number; size: number }[],
  options: RuntimeFixtureOptions = {},
) {
  const bytes = Buffer.alloc(0x8000),
    u32 = (offset: number, value: number): void => {
      bytes.writeUInt32LE(value, offset);
    };
  const u64 = (offset: number, value: bigint): void => {
    bytes.writeBigUInt64LE(value, offset);
  };
  const relative = (slot: number, target: number, indirect = false): void => {
    bytes.writeInt32LE((target - slot) | (indirect ? 1 : 0), slot);
  };
  const pointer = (slot: number, target: number, flags = 0n): void =>
    u64(slot, (BASE + BigInt(target)) | flags);
  let stringOffset = 0x4000;
  const string = (value: string): number => {
    const at = stringOffset;
    stringOffset += bytes.write(value, at, 'utf8') + 1;
    return at;
  };
  const all = [
    ...sections,
    { name: '__const', offset: 0x2000, size: 0x1000 },
    { name: '__cstring', offset: 0x4000, size: 0x1000 },
    { name: '__text', offset: 0x6000, size: 0x1000 },
  ];
  const segmentSize = 72 + all.length * 80,
    commandSize =
      segmentSize +
      (options.encrypted ? 24 : 0) +
      (options.chained ? 16 : 0) +
      (options.data_in_code ? 16 : 0);
  u32(0, 0xfeedfacf);
  u32(4, 0x100000c);
  u32(12, 2);
  u32(
    16,
    1 + Number(!!options.encrypted) + Number(!!options.chained) + Number(!!options.data_in_code),
  );
  u32(20, commandSize);
  u32(32, 0x19);
  u32(36, segmentSize);
  bytes.write('__TEXT', 40);
  u64(56, BASE);
  u64(64, BigInt(bytes.length));
  u64(80, BigInt(bytes.length));
  u32(88, 7);
  u32(92, 7);
  u32(96, all.length);
  all.forEach((section, index) => {
    const at = 104 + index * 80;
    bytes.write(section.name, at);
    bytes.write('__TEXT', at + 16);
    u64(at + 32, BASE + BigInt(section.offset));
    u64(at + 40, BigInt(section.size));
    u32(at + 48, section.offset);
    if (section.name === '__text') u32(at + 64, 0x80000400);
  });
  let command = 32 + segmentSize;
  if (options.encrypted) {
    u32(command, 0x2c);
    u32(command + 4, 24);
    u32(command + 8, options.encrypted.offset);
    u32(command + 12, options.encrypted.size);
    u32(command + 16, 1);
    command += 24;
  }
  if (options.chained) {
    u32(command, 0x80000034);
    u32(command + 4, 16);
    command += 16;
  }
  if (options.data_in_code) {
    u32(command, 0x29);
    u32(command + 4, 16);
    u32(command + 8, 0x7800);
    u32(command + 12, 8);
    u32(0x7800, options.data_in_code.offset);
    bytes.writeUInt16LE(options.data_in_code.size, 0x7804);
    bytes.writeUInt16LE(1, 0x7806);
  }
  for (const offset of [0x6000, 0x6004, 0x6008]) u32(offset, 0xd65f03c0);
  return { bytes, u32, u64, relative, pointer, string };
}
export function objcBytes(options: RuntimeFixtureOptions = {}) {
  const built = runtimeBytes(
    [
      { name: '__objc_classlist', offset: 0x1000, size: 8 },
      { name: '__objc_selrefs', offset: 0x1010, size: 8 },
      { name: '__objc_catlist', offset: 0x1020, size: 8 },
      { name: '__objc_protolist', offset: 0x1030, size: 8 },
    ],
    options,
  );
  const { pointer: p, string: s, u32, u64 } = built;
  const className = s('Widget'),
    selector = s('value'),
    classSelector = s('shared'),
    encoding = s('q16@0:8');
  p(0x1000, 0x2000);
  p(0x1010, selector);
  p(0x1020, 0x2300);
  p(0x1030, 0x2400);
  p(0x2000, 0x2040);
  p(0x2020, 0x2100, 3n);
  p(0x2040, 0x2040);
  p(0x2048, 0x2000);
  p(0x2060, 0x2180);
  u32(0x2100, 2);
  p(0x2118, className);
  p(0x2120, 0x2200);
  p(0x2128, 0x2500);
  p(0x2130, 0x2600);
  u32(0x2180, 3);
  p(0x2198, className);
  p(0x21a0, 0x2240);
  for (const [list, name, imp] of [
    [0x2200, selector, 0x6000],
    [0x2240, classSelector, 0x6004],
    [0x2280, s('extra'), 0x6008],
  ] as const) {
    u32(list, 24);
    u32(list + 4, 1);
    p(list + 8, name);
    p(list + 16, encoding);
    p(list + 24, imp);
  }
  p(0x2300, s('Extras'));
  p(0x2308, 0x2000);
  p(0x2310, 0x2280);
  p(0x2320, 0x2500);
  p(0x2408, s('Readable'));
  p(0x2418, 0x2680);
  u32(0x2440, 72);
  u32(0x2680, 24);
  u32(0x2684, 1);
  p(0x2688, selector);
  p(0x2690, encoding);
  u64(0x2500, 1n);
  p(0x2508, 0x2400);
  u32(0x2600, 32);
  u32(0x2604, 1);
  p(0x2608, 0x26c0);
  p(0x2610, s('_value'));
  p(0x2618, s('q'));
  u32(0x2620, 3);
  u32(0x2624, 8);
  return { ...built, selector, encoding };
}
export function swiftBytes() {
  const built = runtimeBytes([
    { name: '__swift5_types', offset: 0x1000, size: 4 },
    { name: '__swift5_fieldmd', offset: 0x1100, size: 28 },
  ]);
  const { u32, relative: r, string: s, bytes } = built;
  r(0x1000, 0x2040);
  r(0x2008, s('Main'));
  u32(0x2040, 17);
  r(0x2044, 0x2000);
  r(0x2048, s('Box'));
  r(0x2050, 0x1100);
  u32(0x2054, 1);
  r(0x1100, s('4Main3BoxV'));
  bytes.writeUInt16LE(0, 0x1108);
  bytes.writeUInt16LE(12, 0x110a);
  u32(0x110c, 1);
  u32(0x1110, 2);
  r(0x1114, 0x4800);
  r(0x1118, s('value'));
  bytes.set([1, 0x34, 0, 0, 0, 0x56, 0], 0x4800);
  return built;
}
