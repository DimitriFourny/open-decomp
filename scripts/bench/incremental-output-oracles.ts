import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contentHash, type WireEmission } from '../../src/core/index.js';
import { emittedFormals, execute } from '../../test/emitters/c/support.js';
import { strnicmpCases, strnicmpOracle } from '../../test/emitters/c/strnicmp-fixture.js';
import { loadBytes } from '../../test/metadata/fixture.js';

export type IncrementalOracleKind = 'maximum' | 'sum-loop' | 'threadsafe' | 'strnicmp';
export interface IncrementalOutputOracle {
  readonly kind: IncrementalOracleKind;
  readonly binary_sha256: string;
  readonly cases: number;
  readonly provenance: string;
  check(emission: WireEmission): void;
}
function putWord(memory: Map<bigint, number>, address: bigint, value: bigint, bytes: number): void {
  for (let offset = 0; offset < bytes; offset++)
    memory.set(address + BigInt(offset), Number((value >> BigInt(offset * 8)) & 255n));
}
function formals(emission: WireEmission, values: readonly bigint[]) {
  const declarations = emittedFormals(emission);
  assert.equal(declarations.length, values.length, 'Trusted source inputs must bind all actual emitted formals, not guessed arg names');
  return new Map(declarations.map((formal, index) => [formal.statement_id, values[index]!]));
}
const maximumCases = [[0, 0], [1, 7], [-5, -3], [2147483647, -2147483648], [-2147483648, -2147483648]] as const;
const loopWords = [0xffffffffn, 1n, 0x80000000n, 0x80000000n, 0xffffffffn, 2n];
const loopCounts = [0, 1, 2, 5, 6];

/** Independent source/output evaluation only: never executes the analyzed target or production IR. */
export async function prepareIncrementalOutputOracle(binary: string, kind: IncrementalOracleKind): Promise<IncrementalOutputOracle> {
  const bytes = await readFile(binary), binary_sha256 = contentHash(bytes);
  let lowerTable: { address: bigint; bytes: Uint8Array } | undefined;
  if (kind === 'strnicmp') {
    // Resolve the actual reviewed binary's static table; never guess/rewrite a
    // generated address or use an output-derived constant as an oracle fact.
    const image = loadBytes(bytes);
    const candidates = image.symbols.filter((symbol) => symbol.original_name === '_sqlite3UpperToLower');
    assert.equal(candidates.length, 1, 'The public SQLite oracle requires its exact static lookup-table symbol');
    const symbol = candidates[0]!;
    assert.ok(symbol.address !== null);
    const address = image.address_map.translate(symbol.address, 'va');
    const file = image.address_map.translate(symbol.address, 'file');
    assert.equal(address.kind, 'mapped'); assert.equal(file.kind, 'mapped');
    assert.ok(address.kind === 'mapped' && file.kind === 'mapped');
    const table = image.bytes.read(file.address.value, 256);
    for (let byte = 0; byte < 256; byte++)
      assert.equal(table[byte], byte >= 65 && byte <= 90 ? byte + 32 : byte,
        'File-backed SQLite table must match the independently declared ASCII oracle');
    lowerTable = { address: address.address.value, bytes: table };
  }
  const cases = kind === 'maximum' ? maximumCases.length : kind === 'sum-loop' ? loopCounts.length : kind === 'strnicmp' ? strnicmpCases.length : 1;
  return { kind, binary_sha256, cases,
    provenance: kind === 'maximum' || kind === 'sum-loop'
      ? 'Checked-in fixtures/source/corpus.c; independent signed maximum / modulo-uint32 bounded sum'
      : kind === 'strnicmp'
        ? 'Reviewed SQLite sqlite3.c:37261-37271 source algorithm, all retained NULL/count/mismatch/equal/high-byte cases; actual binary lookup-table bytes validated independently'
        : 'Reviewed public SQLite SQLITE_THREADSAFE=1 constant-return body',
    check(emission) {
      if (kind === 'maximum') {
        for (const [left, right] of maximumCases) {
          const result = execute(emission, formals(emission, [BigInt.asUintN(32, BigInt(left)), BigInt.asUintN(32, BigInt(right))]));
          assert.equal(result.exit, 'machine_return'); assert.equal(result.values.length, 1);
          assert.equal(BigInt.asUintN(32, result.values[0]!), BigInt.asUintN(32, BigInt(Math.max(left, right))));
          assert.deepEqual(result.calls, []);
        }
      } else if (kind === 'threadsafe') {
        const result = execute(emission, formals(emission, []));
        assert.equal(result.exit, 'machine_return'); assert.deepEqual(result.values, [1n]);
        assert.deepEqual(result.calls, []);
      } else if (kind === 'sum-loop') {
        for (const count of loopCounts) {
          const memory = new Map<bigint, number>();
          for (let index = 0; index < count; index++) putWord(memory, 0x2000n + BigInt(index * 4), loopWords[index]!, 4);
          const before = new Map(memory);
          const result = execute(emission, formals(emission, [count ? 0x2000n : 0xdead0000n, BigInt(count)]), memory);
          assert.equal(result.exit, 'machine_return', `sum-loop/${count}`);
          assert.deepEqual(result.values, [BigInt.asUintN(32, loopWords.slice(0, count).reduce((sum, word) => sum + word, 0n))]);
          assert.deepEqual(result.events, Array.from({ length: count }, () => 'load'), 'Only the source-valid extent is readable; no spare bytes conceal an extra iteration');
          assert.deepEqual(result.memory, before); assert.deepEqual(result.calls, []);
        }
      } else {
        assert.ok(lowerTable);
        for (const [left, right, count] of strnicmpCases) {
          const memory = new Map<bigint, number>();
          const putString = (address: bigint, text: string | null): bigint => {
            if (text === null) return 0n;
            for (let index = 0; index <= text.length; index++) memory.set(address + BigInt(index), text.charCodeAt(index) || 0);
            return address;
          };
          const values = [putString(0x2000n, left), putString(0x3000n, right), BigInt.asUintN(32, BigInt(count))];
          for (let byte = 0; byte < lowerTable.bytes.length; byte++) memory.set(lowerTable.address + BigInt(byte), lowerTable.bytes[byte]!);
          const before = new Map(memory), result = execute(emission, formals(emission, values), memory);
          const description = `sqlite-strnicmp/${JSON.stringify([left, right, count])}`;
          assert.equal(result.exit, 'machine_return', description);
          assert.deepEqual(result.values, [BigInt.asUintN(32, strnicmpOracle(left, right, count))], description);
          assert.deepEqual(result.memory, before, description); assert.deepEqual(result.calls, [], description);
        }
      }
    },
  };
}
