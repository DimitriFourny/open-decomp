import { readFileSync } from 'node:fs';
import {
  AddressMap,
  ImmutableBytes,
  contentHash,
  createOperationContext,
  imageIdentity,
  sliceIdentity,
  type LoadedImage,
  type Loader,
} from '../../src/core/index.js';
import { Arm64Decoder } from '../../src/decoders/arm64/index.js';
import { X86Decoder } from '../../src/decoders/x86_64/index.js';
import { discoverFunctions } from '../../src/analysis/discovery/index.js';

export function loadNavigationFixture(path: string, loader: Loader): LoadedImage {
  const bytes = readFileSync(path);
  const sha256 = contentHash(bytes);
  return loader.load(
    { bytes: new ImmutableBytes(bytes), image_id: imageIdentity(sha256), sha256, slice_id: null },
    createOperationContext(),
  );
}
export function discoverNavigationFixture(image: LoadedImage) {
  const decoder =
    image.target.architecture === 'arm64'
      ? new Arm64Decoder()
      : new X86Decoder({ formatting: false });
  try {
    return discoverFunctions({ image, decoder, revision: 0 }, createOperationContext());
  } finally {
    decoder.dispose();
  }
}
/** Real decoder input, with separate executable/data mappings; no mocked operands. */
export function navigationBytes(
  code: Uint8Array,
  data: Uint8Array,
  architecture: 'arm64' | 'x86_64' = 'x86_64',
  dataName = '.rdata',
): LoadedImage {
  const bytes = Buffer.concat([code, data]);
  const sha256 = contentHash(bytes);
  const id = imageIdentity(sha256);
  const slice = sliceIdentity(id, 0n, BigInt(bytes.length), architecture);
  const mappings = [
    {
      id: 'code',
      va: 0x1000n,
      memory_size: BigInt(code.length),
      file_offset: 0n,
      file_size: BigInt(code.length),
      permissions: ['read', 'execute'] as const,
    },
    {
      id: 'data',
      va: 0x2000n,
      memory_size: BigInt(data.length) + 32n,
      file_offset: BigInt(code.length),
      file_size: BigInt(data.length),
      permissions: ['read', 'write'] as const,
    },
  ];
  return {
    id,
    sha256,
    selected_slice_id: slice,
    bytes: new ImmutableBytes(bytes),
    image_base: 0x1000n,
    slices: [
      {
        id: slice,
        image_id: id,
        offset: 0n,
        size: BigInt(bytes.length),
        architecture,
        subtype: 'all',
        supported: true,
      },
    ],
    target:
      architecture === 'arm64'
        ? {
            format: 'macho',
            architecture,
            abi: 'darwin-arm64',
            endian: 'little',
            address_bits: 64,
            features: [],
          }
        : {
            format: 'pe',
            architecture,
            abi: 'windows-x64',
            endian: 'little',
            address_bits: 64,
            features: [],
          },
    mappings,
    address_map: new AddressMap({
      image_id: id,
      image_base: 0x1000n,
      byte_length: BigInt(bytes.length),
      slice_offset: 0n,
      slice_size: BigInt(bytes.length),
      mappings,
    }),
    entry_points: [{ image_id: id, space: 'va', value: 0x1000n }],
    hints: [],
    headers: [],
    sections: [
      {
        id: 'data-section',
        kind: 'section',
        name: dataName,
        segment_id: null,
        virtual_range: {
          start: { image_id: id, space: 'va', value: 0x2000n },
          size: BigInt(data.length),
        },
        file_range: {
          start: { image_id: id, space: 'file', value: BigInt(code.length) },
          size: BigInt(data.length),
        },
        permissions: ['read', 'write'],
        flags: 0n,
        evidence_ids: [],
      },
    ],
    symbols: [],
    imports: [],
    exports: [],
    relocations: [],
    evidence: [],
    diagnostics: [],
    capabilities: [],
  };
}
export function armWords(words: readonly number[]): Uint8Array {
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  return bytes;
}
