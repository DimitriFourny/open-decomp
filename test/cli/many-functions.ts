import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeBytes } from '../metadata/fixture.js';

/** Real Mach-O symbols and RET instructions force multiple CLI query pages and
 * duplicate-name selection without substituting a fake query service or SDK.
 * `prefix` is the linkage prefix of every symbol: Mach-O C symbols carry one underscore. */
export async function manyFunctions(root: string, prefix = ''): Promise<string> {
  const { bytes, u32, u64 } = runtimeBytes([]);
  const command = 32 + bytes.readUInt32LE(36);
  u32(16, 2);
  u32(20, bytes.readUInt32LE(20) + 24);
  u32(command, 2);
  u32(command + 4, 24);
  u32(command + 8, 0x5000);
  u32(command + 12, 205);
  u32(command + 16, 0x7000);
  let stringOffset = 1;
  for (let index = 0; index < 205; index++) {
    const name = `${prefix}${index >= 203 ? 'duplicate' : `task_${index.toString().padStart(3, '0')}`}`;
    const symbol = 0x5000 + index * 16;
    u32(symbol, stringOffset);
    bytes[symbol + 4] = 0x0f;
    bytes[symbol + 5] = 3;
    u64(symbol + 8, 0x100006000n + BigInt(index * 4));
    stringOffset += bytes.write(name, 0x7000 + stringOffset, 'utf8') + 1;
    u32(0x6000 + index * 4, 0xd65f03c0);
  }
  u32(command + 20, stringOffset);
  const binary = join(root, 'many-functions');
  await writeFile(binary, bytes);
  return binary;
}
