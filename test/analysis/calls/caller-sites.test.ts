import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressMap,
  ImmutableBytes,
  contentHash,
  createOperationContext,
  entityIdentity,
  imageIdentity,
  sliceIdentity,
  type Address,
  type FunctionRecord,
  type LoadedImage,
  type ReferenceRecord,
} from '../../../src/core/index.js';
import { darwinArm64Abi } from '../../../src/abi/darwin-arm64/index.js';
import { Arm64Decoder } from '../../../src/decoders/arm64/index.js';
import { Arm64Lifter } from '../../../src/lifters/arm64/index.js';
import {
  callerSiteIndex,
  callerSiteIndexWork,
  callerSites,
  classifyResultUse,
  type CallerSite,
} from '../../../src/analysis/calls/caller-sites.js';

const BASE = 0x1000n;
const RET = 0xd65f03c0;
const bl = (from: number, to: number) => 0x94000000 | (((to - from) / 4) & 0x3ffffff);
const b = (from: number, to: number) => 0x14000000 | (((to - from) / 4) & 0x3ffffff);

/** Byte offsets of the synthetic functions; F returns `1` in w0, G returns. */
const F = 0x00,
  G = 0x08,
  READ = 0x0c,
  DEAD = 0x18,
  FORWARD = 0x24,
  TAIL_WINDOW = 0x2c,
  TAIL_SITE = 0x34,
  BRANCH = 0x38,
  TABLE = 0x48,
  COPY = 0x5c,
  DEAD_BOTH = 0x70,
  DATA = 0x80,
  CONST = 0x84;
const words: readonly (readonly [number, readonly number[]])[] = [
  [F, [0x52800020 /* mov w0, #1 */, RET]],
  [G, [RET]],
  // *p = f();
  [READ, [bl(READ, F), 0xb9000020 /* str w0, [x1] */, RET]],
  // f(); return *p; (w0 written before any read)
  [DEAD, [bl(DEAD, F), 0xb9400020 /* ldr w0, [x1] */, RET]],
  // return f();
  [FORWARD, [bl(FORWARD, F), RET]],
  // f(); return g(); with the result still in x0
  [TAIL_WINDOW, [bl(TAIL_WINDOW, F), b(TAIL_WINDOW + 4, G)]],
  // return f(); as a tail branch
  [TAIL_SITE, [b(TAIL_SITE, F)]],
  // if (f()) ...
  [BRANCH, [bl(BRANCH, F), 0x34000040 /* cbz w0, #8 */, RET, RET]],
  // f(); switch (x2) through an unproven table
  [
    TABLE,
    [
      bl(TABLE, F),
      0x10000050 /* adr x16, #8 */,
      0xb8a27a11 /* ldrsw x17, [x16, x2, lsl #2] */,
      0x8b110210 /* add x16, x16, x17 */,
      0xd61f0200 /* br x16 */,
    ],
  ],
  // x19 = f(); g(); return x19;
  [
    COPY,
    [bl(COPY, F), 0xaa0003f3 /* mov x19, x0 */, bl(COPY + 8, G), 0xaa1303e0 /* mov x0, x19 */, RET],
  ],
  // Data in code and a constant that both look like `bl F`.
  // f(); return (*p, 0.0): both result carriers written before any read
  [
    DEAD_BOTH,
    [bl(DEAD_BOTH, F), 0xb9400020 /* ldr w0, [x1] */, 0x6f00e400 /* movi v0.2d, #0 */, RET],
  ],
  [DATA, [bl(DATA, F)]],
  [CONST, [bl(CONST, F)]],
];

function arm64Fixture() {
  const bytes = Buffer.alloc(CONST + 4);
  for (const [offset, values] of words)
    values.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, offset + index * 4));
  const buffer = Uint8Array.from(bytes);
  const sha256 = contentHash(buffer);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, BigInt(buffer.length), 'arm64');
  const at = (offset: number): Address => ({
    image_id: id,
    space: 'va',
    value: BASE + BigInt(offset),
  });
  const mappings = [
    {
      id: 'test-code',
      va: BASE,
      memory_size: BigInt(buffer.length),
      file_offset: 0n,
      file_size: BigInt(buffer.length),
      permissions: ['read', 'execute'] as const,
    },
  ];
  const section = (name: string, start: number, end: number, flags: bigint) => ({
    id: `section-${name}`,
    name,
    segment_id: null,
    kind: 'section' as const,
    virtual_range: { start: at(start), size: BigInt(end - start) },
    file_range: {
      start: { image_id: id, space: 'file' as const, value: BigInt(start) },
      size: BigInt(end - start),
    },
    permissions: ['read', 'execute'] as ('read' | 'execute')[],
    flags,
    evidence_ids: [],
  });
  const image: LoadedImage = {
    id,
    sha256,
    selected_slice_id: slice,
    bytes: new ImmutableBytes(buffer),
    image_base: BASE,
    slices: [
      {
        id: slice,
        image_id: id,
        offset: 0n,
        size: BigInt(buffer.length),
        architecture: 'arm64',
        subtype: 'all',
        supported: true,
      },
    ],
    target: {
      format: 'macho',
      architecture: 'arm64',
      abi: 'darwin-arm64',
      endian: 'little',
      address_bits: 64,
      features: ['FEAT_FP', 'FEAT_AdvSIMD'],
    },
    mappings,
    address_map: new AddressMap({
      image_id: id,
      image_base: BASE,
      byte_length: BigInt(buffer.length),
      slice_offset: 0n,
      slice_size: BigInt(buffer.length),
      mappings,
    }),
    entry_points: [at(F)],
    // Instruction attributes mark `__text`; `__const` shares the executable segment.
    hints: [
      { kind: 'data', range: { start: at(DATA), size: 4n }, encoding: 'bytes', evidence_ids: [] },
    ],
    headers: [],
    sections: [section('__text', 0, CONST, 0x80000400n), section('__const', CONST, CONST + 4, 0n)],
    symbols: [],
    imports: [],
    exports: [],
    relocations: [],
    evidence: [],
    diagnostics: [],
    capabilities: [],
  };
  // Partial discovery: each function's published range is only its first instruction.
  const fn = (name: string, offset: number): FunctionRecord => ({
    id: entityIdentity(slice, 'function', [BASE + BigInt(offset)]),
    original_name: name,
    display_name: null,
    evidence_ids: [],
    entry: at(offset),
    ranges: [{ start: at(offset), size: 4n }],
    boundary: 'established',
    signature: null,
    analysis: 'partial',
  });
  const functions = [
    fn('f', F),
    fn('g', G),
    fn('read', READ),
    fn('dead', DEAD),
    fn('forward', FORWARD),
    fn('tail_window', TAIL_WINDOW),
    fn('tail_site', TAIL_SITE),
    fn('branch', BRANCH),
    fn('table', TABLE),
    fn('copy', COPY),
    fn('dead_both', DEAD_BOTH),
  ];
  return { image, functions, at };
}

test('the ARM64 sweep lists every BL/B to an entry in instruction bytes, outside data', () => {
  const { image, functions, at } = arm64Fixture();
  const context = createOperationContext();
  const before = context.consumedWork?.() ?? 0;
  const references: ReferenceRecord[] = [];
  const index = callerSiteIndex(image, functions, references, false, context);
  // The build charges exactly the advertised amount, once per operation.
  assert.equal(
    (context.consumedWork?.() ?? 0) - before,
    callerSiteIndexWork(image, functions, references),
  );
  const again = (context.consumedWork?.() ?? 0) - before;
  callerSiteIndex(image, functions, references, false, context);
  assert.equal((context.consumedWork?.() ?? 0) - before, again);
  const sites = callerSites(index, at(F), context);
  assert.equal(sites.complete, true);
  assert.deepEqual(
    sites.sites.map((site) => [
      Number(site.address.value - BASE),
      site.kind,
      site.caller?.original_name,
    ]),
    [
      [READ, 'call', 'read'],
      [DEAD, 'call', 'dead'],
      [FORWARD, 'call', 'forward'],
      [TAIL_WINDOW, 'call', 'tail_window'],
      [TAIL_SITE, 'tail', 'tail_site'],
      [BRANCH, 'call', 'branch'],
      [TABLE, 'call', 'table'],
      [COPY, 'call', 'copy'],
      [DEAD_BOTH, 'call', 'dead_both'],
    ],
  );
  // A site in the published range is owned by discovery; a later instruction is
  // attributed to the nearest entry below it, bounded by the next entry.
  const g = callerSites(index, at(G), context).sites;
  assert.deepEqual(
    g.map((site) => [Number(site.address.value - BASE), site.kind, site.attribution]),
    [
      [TAIL_WINDOW + 4, 'tail', 'next_entry'],
      [COPY + 8, 'call', 'next_entry'],
    ],
  );
  assert.equal(g[1]!.caller?.original_name, 'copy');
  assert.equal(g[1]!.caller_extent, BigInt(DEAD_BOTH - COPY));
  assert.equal(sites.sites[0]!.attribution, 'ranges');
});

test('result-use windows classify read, write-before-read, forwarding, tails and tables', () => {
  const { image, functions, at } = arm64Fixture();
  const context = createOperationContext();
  const index = callerSiteIndex(image, functions, [], false, context);
  const decoder = new Arm64Decoder();
  const input = { index, decoder, lifter: new Arm64Lifter(), abi: darwinArm64Abi };
  const sites = new Map(
    callerSites(index, at(F), context).sites.map((site): [number, CallerSite] => [
      Number(site.address.value - BASE),
      site,
    ]),
  );
  const use = (offset: number) => classifyResultUse(input, sites.get(offset)!, context);
  try {
    // `str w0, [x1]` consumes exactly the low word.
    const read = use(READ);
    assert.equal(read.kind, 'semantic');
    if (read.kind === 'semantic')
      assert.deepEqual(
        read.registers.map((register) => [
          register.root,
          register.offset_bits,
          register.width_bits,
        ]),
        [['arm64:x0', 0, 32]],
      );
    assert.equal(use(BRANCH).kind, 'semantic');
    // w0 is overwritten first, but the FP carrier still reaches the caller's return.
    assert.deepEqual(use(DEAD), { kind: 'forwarded', returns: true, tails: [] });
    assert.deepEqual(use(DEAD_BOTH), { kind: 'dead' });
    assert.deepEqual(use(FORWARD), { kind: 'forwarded', returns: true, tails: [] });
    assert.deepEqual(use(TAIL_WINDOW), { kind: 'forwarded', returns: false, tails: [at(G)] });
    assert.deepEqual(use(TAIL_SITE), { kind: 'forwarded', returns: false, tails: [at(TAIL_SITE)] });
    assert.equal(use(TABLE).kind, 'unknown');
    // A copy whose consumer lies past a call is no evidence either way.
    assert.equal(use(COPY).kind, 'unknown');
    // A prepared caller body answers before any window is lifted.
    const prepared = classifyResultUse(
      {
        ...input,
        prepared: (site, instruction) => {
          assert.equal(site.address.value, BASE + BigInt(DEAD));
          assert.equal(
            instruction,
            entityIdentity(image.selected_slice_id, 'instruction', [BASE + BigInt(DEAD), 4]),
          );
          return { kind: 'semantic', registers: [] };
        },
      },
      sites.get(DEAD)!,
      context,
    );
    assert.equal(prepared.kind, 'semantic');
  } finally {
    decoder.dispose();
  }
});

test('x86-64 sites come from the discovered reference index and are complete only with it', () => {
  const { image, functions, at } = arm64Fixture();
  const x86: LoadedImage = {
    ...image,
    sections: [],
    target: { ...image.target, format: 'elf', architecture: 'x86_64', abi: 'sysv-amd64' },
  };
  const reference = (from: number, kind: ReferenceRecord['kind']): ReferenceRecord => ({
    id: entityIdentity(image.selected_slice_id, 'reference', [from]),
    from: at(from),
    from_function: functions[2]!.id,
    to: at(F),
    to_entity: functions[0]!.id,
    from_instruction: null,
    target_role: 'code',
    kind,
    status: 'established',
    evidence_ids: [],
  });
  const references = [
    reference(READ, 'call'),
    reference(TAIL_SITE, 'tail_call'),
    reference(DEAD, 'read'),
  ];
  for (const complete of [false, true]) {
    const index = callerSiteIndex(x86, functions, references, complete, createOperationContext());
    const sites = callerSites(index, at(F), createOperationContext());
    assert.equal(sites.complete, complete);
    assert.deepEqual(
      sites.sites.map((site) => [Number(site.address.value - BASE), site.kind, site.attribution]),
      [
        [READ, 'call', 'ranges'],
        [TAIL_SITE, 'tail', 'ranges'],
      ],
    );
  }
});

test('the ARM64 sweep records entries reached other than by a listed BL/B', () => {
  const { image, at } = arm64Fixture();
  const adr = (from: number, to: number, rd: number) => {
    const imm = (to - from) & 0x1fffff;
    return (0x10000000 | ((imm & 3) << 29) | (((imm >> 2) & 0x7ffff) << 5) | rd) >>> 0;
  };
  const cbz = (from: number, to: number, rt: number) =>
    (0xb4000000 | ((((to - from) / 4) & 0x7ffff) << 5) | rt) >>> 0;
  // ADR materializes `adr_target`; ADRP of its page plus `add #4` may materialize
  // `page_target` (VA 0x1004); a CBZ from `user` reaches `cond_target`; `fall_target`
  // follows a `mov` that may fall through; `loop` branches back to its own entry.
  const layout: readonly (readonly [string, number, readonly number[]])[] = [
    ['adr_target', 0x00, [RET]],
    ['page_target', 0x04, [RET]],
    ['cond_target', 0x08, [RET]],
    ['before_fall', 0x0c, [0x52800020 /* mov w0, #1 */]],
    ['fall_target', 0x10, [RET]],
    ['loop', 0x14, [0xb5000000 /* cbnz x0, loop */, RET]],
    ['clean', 0x1c, [RET]],
    [
      'user',
      0x20,
      [adr(0x20, 0x00, 0), 0x90000001 /* adrp x1, page */, 0x91001021 /* add x1, x1, #4 */],
    ],
  ];
  const end = 0x34;
  const bytes = Buffer.alloc(end);
  for (const [, offset, values] of layout)
    values.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, offset + index * 4));
  bytes.writeUInt32LE(cbz(0x2c, 0x08, 2), 0x2c);
  bytes.writeUInt32LE(RET, 0x30);
  const functions = layout.map(([name, offset]): FunctionRecord => ({
    id: entityIdentity(image.selected_slice_id, 'function', [BASE + BigInt(offset)]),
    original_name: name,
    display_name: null,
    evidence_ids: [],
    entry: at(offset),
    ranges: [{ start: at(offset), size: 4n }],
    boundary: 'established',
    signature: null,
    analysis: 'partial',
  }));
  const text = image.sections[0]!;
  const built = (starts: boolean) => {
    const variant: LoadedImage = {
      ...image,
      bytes: new ImmutableBytes(Uint8Array.from(bytes)),
      sections: [
        {
          ...text,
          virtual_range: { start: at(0), size: BigInt(end) },
          file_range: { ...text.file_range!, size: BigInt(end) },
        },
      ],
      hints: starts
        ? layout.map(([, offset]) => ({
            kind: 'function' as const,
            address: at(offset),
            size: null,
            evidence_ids: [],
          }))
        : [],
    };
    return callerSiteIndex(variant, functions, [], false, createOperationContext());
  };
  const escaped = (starts: boolean) =>
    [...built(starts).escaped.keys()].map((entry) => Number(entry - BASE)).sort((a, b) => a - b);
  const complete = built(true);
  assert.equal(complete.starts_complete, true);
  assert.deepEqual(escaped(true), [0x00, 0x04, 0x08, 0x10]);
  // Without complete function starts a branch to an entry may come from an
  // undiscovered function, so the loop's own back edge also escapes.
  assert.equal(built(false).starts_complete, false);
  assert.deepEqual(escaped(false), [0x00, 0x04, 0x08, 0x10, 0x14]);
});
