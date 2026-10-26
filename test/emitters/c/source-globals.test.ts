import assert from 'node:assert/strict';
import test from 'node:test';
import { expandEmission, globalDataIdentity, type Address } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import type { SourceAddress } from '../../../src/reconstruction/source-model.js';
import { navigationBytes } from '../../analysis/navigation-fixture.js';
import { builder } from '../../ir/support.js';
import { emit, execute } from './support.js';

const LOADED = navigationBytes(Uint8Array.of(0xc3), Buffer.alloc(16));
const IMAGE = LOADED.id;
const at = (value: bigint): Address => ({ image_id: IMAGE, space: 'va', value });
const entity = (address: Address): string => globalDataIdentity(LOADED.selected_slice_id, address);
const SLOT = at(0x2010n);
const slot: SourceAddress = {
  address: SLOT,
  object: {
    address: SLOT,
    entity_id: entity(SLOT),
    byte_length: 8n,
    offset: 0n,
    mutable: true,
    kind: 'bytes',
    evidence_ids: ['slot-evidence', 'bind-evidence'],
  },
  import: {
    id: 'import-stderr',
    name: '___stderrp',
    source_name: '__stderrp',
    library: '/usr/lib/libSystem.B.dylib',
    evidence_ids: ['bind-evidence'],
  },
};
const u32 = integer(32),
  u64 = integer(64);

function ssaOf(
  name: string,
  body: (block: ReturnType<ReturnType<typeof builder>['block']>) => unknown[],
  results: (typeof u64)[] = [u64],
): SSAForm {
  const b = builder(name),
    block = b.block('entry');
  block.return(body(block) as never);
  const ssa = constructSSA(b.finish(block, results)).value;
  assert.equal(ssa.form, 'ssa');
  return ssa as SSAForm;
}

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} a load through a binding slot names the imported object, not the slot`, () => {
    const b = builder('through-slot'),
      block = b.block('entry');
    const pointer = block.load(u64, block.address(SLOT));
    block.return([block.load(u64, pointer)]);
    const ssa = constructSSA(b.finish(block, [u64])).value as SSAForm;
    const output = emit(
      ssa,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot] } },
      language,
    );
    const text = output.emission.text;
    assert.doesNotMatch(text, /data_address/);
    if (language === 'c-like') {
      // The bind record carries the library: the declaration prints no comment for it.
      assert.match(text, /^extern uint64_t __stderrp;$/m);
      assert.match(text, /return __stderrp;/);
    } else {
      assert.match(
        text,
        /__stderrp = import_view\("\/usr\/lib\/libSystem\.B\.dylib", "___stderrp", "uint64_t"\)$/m,
      );
      assert.match(text, /return __stderrp\[0\]/);
    }
    // The bind record, not only the slot bytes, evidences the declaration and the access.
    const mappings = expandEmission(output.emission).mappings;
    assert.ok(mappings.some((mapping) => mapping.evidence_ids.includes('bind-evidence')));
  });

  test(`${language} the slot's own read is the imported object's address`, () => {
    const b = builder('slot-address'),
      block = b.block('entry');
    block.return([block.load(u64, block.address(SLOT))]);
    const ssa = constructSSA(b.finish(block, [u64])).value as SSAForm;
    const output = emit(
      ssa,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot] } },
      language,
    );
    const text = output.emission.text;
    assert.doesNotMatch(text, /data_address|0x2010\)/);
    if (language === 'c-like') {
      assert.match(text, /extern uint8_t __stderrp\[\];/);
      assert.match(text, /return \(uintptr_t\)__stderrp;/);
    } else assert.match(text, /return address_of\(__stderrp, 0x0\)/);
  });

  test(`${language} a store through a binding slot writes the imported object`, () => {
    const b = builder('store-through-slot'),
      block = b.block('entry');
    const pointer = block.load(u64, block.address(SLOT));
    block.store(pointer, block.constant(u32, 7n));
    block.return([block.constant(u64, 0n)]);
    const ssa = constructSSA(b.finish(block, [u64])).value as SSAForm;
    const output = emit(
      ssa,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot] } },
      language,
    );
    const text = output.emission.text;
    if (language === 'c-like') {
      assert.match(text, /extern uint32_t __stderrp;/);
      assert.match(text, /__stderrp = 7;/);
    } else assert.match(text, /__stderrp\[0\] = 7/);
  });
}

test('a slot written by the function is no import binding: reads stay explicit memory accesses', () => {
  const b = builder('written-slot'),
    block = b.block('entry');
  block.store(block.address(SLOT), block.constant(u64, 5n));
  block.return([block.load(u64, block.address(SLOT))]);
  const ssa = constructSSA(b.finish(block, [u64])).value as SSAForm;
  const output = emit(ssa, { source: { abi: sysvAMD64Abi, callees: [], addresses: [slot] } });
  assert.doesNotMatch(output.emission.text, /return \(uintptr_t\)__stderrp/);
  assert.match(output.emission.text, /got___stderrp/);
});

const GLOBAL = at(0x3000n);
const object = (
  byteLength: bigint | null,
  offset = 0n,
  base = GLOBAL,
): NonNullable<SourceAddress['object']> => ({
  address: base,
  entity_id: entity(base),
  byte_length: byteLength,
  offset,
  mutable: true,
  kind: 'bytes',
  evidence_ids: ['global-evidence'],
});
const global = (offset: bigint, byteLength: bigint | null = null): SourceAddress => ({
  address: at(GLOBAL.value + offset),
  name: '_counters',
  source_name: 'counters',
  object: object(byteLength, offset),
});
const memoryOf = (bytes: readonly number[]): Map<bigint, number> =>
  new Map(bytes.map((byte, index) => [GLOBAL.value + BigInt(index), byte]));

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} one scalar read of a named global is that global, not an address helper`, () => {
    const ssa = ssaOf('scalar-global', (block) => [block.load(u32, block.address(GLOBAL))], [u32]);
    const output = emit(
      ssa,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [global(0n)] } },
      language,
    );
    assert.doesNotMatch(output.emission.text, /data_address/);
    if (language === 'c-like') {
      assert.match(output.emission.text, /extern uint32_t counters; \/\* VA 0x3000 \*\//);
      assert.match(output.emission.text, /return counters;/);
    } else assert.match(output.emission.text, /counters = memory_view\(0x3000, "uint32_t", True\)/);
    const result = execute(output.emission, new Map(), memoryOf([1, 2, 3, 4, 5, 6, 7, 8]));
    assert.deepEqual(result.values, [0x04030201n]);
    assert.ok(
      expandEmission(output.emission).mappings.some((mapping) =>
        mapping.evidence_ids.includes('global-evidence'),
      ),
    );
  });

  test(`${language} several same-width reads at element offsets become one array`, () => {
    const ssa = ssaOf(
      'array-global',
      (block) => {
        const first = block.load(u32, block.address(GLOBAL));
        const second = block.load(u32, block.address(at(GLOBAL.value + 8n)));
        return [
          block.int(
            'add',
            block.cast('zero_extend', u64, first),
            block.cast('zero_extend', u64, second),
          ),
        ];
      },
      [u64],
    );
    const output = emit(
      ssa,
      {
        source: {
          abi: sysvAMD64Abi,
          callees: [],
          addresses: [global(0n), { ...global(8n), name: undefined as never }],
        },
      },
      language,
    );
    assert.doesNotMatch(output.emission.text, /data_address/);
    if (language === 'c-like') {
      assert.match(output.emission.text, /extern uint32_t counters\[\];/);
      assert.match(output.emission.text, /counters\[0\]/);
      assert.match(output.emission.text, /counters\[2\]/);
    }
    const result = execute(
      output.emission,
      new Map(),
      memoryOf([1, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0]),
    );
    assert.deepEqual(result.values, [6n]);
  });

  test(`${language} mixed access widths keep explicit casts over byte storage`, () => {
    const ssa = ssaOf(
      'bytes-global',
      (block) => {
        const wide = block.load(u32, block.address(GLOBAL));
        const narrow = block.load(integer(16), block.address(at(GLOBAL.value + 4n)));
        return [
          block.int(
            'add',
            block.cast('zero_extend', u64, wide),
            block.cast('zero_extend', u64, narrow),
          ),
        ];
      },
      [u64],
    );
    const output = emit(
      ssa,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [global(0n), global(4n)] } },
      language,
    );
    assert.doesNotMatch(output.emission.text, /data_address/);
    if (language === 'c-like') assert.match(output.emission.text, /extern uint8_t counters\[\];/);
    const result = execute(output.emission, new Map(), memoryOf([1, 0, 0, 0, 2, 1, 0, 0]));
    assert.deepEqual(result.values, [259n]);
  });
}

test('a known extent that an access would exceed keeps byte storage', () => {
  const ssa = ssaOf(
    'past-extent',
    (block) => [
      block.cast('zero_extend', u64, block.load(u32, block.address(at(GLOBAL.value + 4n)))),
    ],
    [u64],
  );
  const output = emit(ssa, {
    source: { abi: sysvAMD64Abi, callees: [], addresses: [global(4n, 6n)] },
  });
  assert.match(output.emission.text, /extern uint8_t counters\[\];/);
  assert.doesNotMatch(output.emission.text, /counters\[1\]/);
});

test('checked view keeps the explicit helper and declares nothing', () => {
  const ssa = ssaOf(
    'checked-global',
    (block) => [block.cast('zero_extend', u64, block.load(u32, block.address(GLOBAL)))],
    [u64],
  );
  const output = emit(
    ssa,
    { source: { abi: sysvAMD64Abi, callees: [], addresses: [global(0n)] } },
    'c-like',
    'checked',
  );
  assert.match(output.emission.text, /data_address\(/);
  assert.doesNotMatch(output.emission.text, /extern /);
});

// SQLite's `aSyscall[i].pCurrent`: a bind in writable `__DATA,__data` with no
// covering symbol, 0x80 bytes after the size-less `_config` object symbol.
const RELATIVE = at(0x3080n);
const relativeSlot: SourceAddress = {
  address: RELATIVE,
  symbol_relative: {
    symbol_id: 'symbol-config',
    name: '_config',
    source_name: 'config',
    offset: 0x80n,
    evidence_ids: ['config-symbol-evidence'],
  },
  initial_import: 'fstat',
  object: {
    address: RELATIVE,
    entity_id: entity(RELATIVE),
    byte_length: null,
    offset: 0n,
    mutable: true,
    kind: 'bytes',
    evidence_ids: ['config-evidence'],
  },
};
// The program rewrote the slot at run time (`unixSetSystemCall`): a read yields
// the stored pointer, never the load-time import.
const REWRITTEN = 0x7766554433221100n;
const slotMemory = (value: bigint): Map<bigint, number> =>
  new Map(
    Array.from({ length: 8 }, (_, index) => [
      RELATIVE.value + BigInt(index),
      Number((value >> BigInt(index * 8)) & 0xffn),
    ]),
  );

for (const language of ['c-like', 'python-like'] as const)
  test(`${language} a writable bound slot is read as storage named after its preceding symbol`, () => {
    const ssa = ssaOf('rewritten-slot', (block) => [block.load(u64, block.address(RELATIVE))]);
    const output = emit(
      ssa,
      { source: { abi: sysvAMD64Abi, callees: [], addresses: [relativeSlot] } },
      language,
    );
    const text = output.emission.text;
    assert.doesNotMatch(text, /data_address|data_3080|import_view|\(uintptr_t\)fstat/);
    if (language === 'c-like') {
      assert.match(
        text,
        /^extern uint64_t config_0x80; \/\* VA 0x3080, config\+0x80, initially fstat \*\/$/m,
      );
      assert.match(text, /return config_0x80;/);
    } else
      assert.match(
        text,
        /^config_0x80 = memory_view\(0x3080, "uint64_t", True\) {2}# config\+0x80, initially fstat$/m,
      );
    assert.ok(
      output.emission.local_validation?.some(
        (record) => record.kind === 'presentation' && record.rule === 'symbol_relative_name',
      ),
    );
    // The preceding symbol's records evidence the printed name.
    assert.ok(
      expandEmission(output.emission).mappings.some((mapping) =>
        mapping.evidence_ids.includes('config-symbol-evidence'),
      ),
    );
    assert.deepEqual(execute(output.emission, new Map(), slotMemory(REWRITTEN)).values, [
      REWRITTEN,
    ]);
  });

test('checked view states the relative identity in its data_address helper', () => {
  const ssa = ssaOf('checked-relative', (block) => [block.load(u64, block.address(RELATIVE))]);
  const output = emit(
    ssa,
    { source: { abi: sysvAMD64Abi, callees: [], addresses: [relativeSlot] } },
    'c-like',
    'checked',
  );
  assert.match(output.emission.text, /data_address\("_config\+0x80", 0x3080, 0x0, "unknown"/);
  assert.doesNotMatch(output.emission.text, /extern /);
  assert.deepEqual(execute(output.emission, new Map(), slotMemory(REWRITTEN)).values, [REWRITTEN]);
});
