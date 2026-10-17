import {
  AddressMap,
  ImmutableBytes,
  contentHash,
  imageIdentity,
  sliceIdentity,
  type AddressRange,
  type ImageMapping,
  type LoadedImage,
} from '../../../src/core/index.js';

export function imageFromBytes(
  input: Uint8Array,
  options: {
    base?: bigint;
    fileOffset?: bigint;
    mappings?: readonly ImageMapping[];
    hints?: LoadedImage['hints'];
  } = {},
): LoadedImage {
  const bytes = new ImmutableBytes(input);
  const sha256 = contentHash(input);
  const id = imageIdentity(sha256);
  const base = options.base ?? 0x1000n;
  const offset = options.fileOffset ?? 0n;
  const mappings: readonly ImageMapping[] = options.mappings ?? [
    {
      id: 'code',
      va: base,
      memory_size: BigInt(input.length) - offset,
      file_offset: offset,
      file_size: BigInt(input.length) - offset,
      permissions: ['read', 'execute'],
    },
  ];
  const selected = sliceIdentity(id, 0n, BigInt(input.length), 'x86_64');
  return {
    id,
    sha256,
    bytes,
    selected_slice_id: selected,
    slices: [
      {
        id: selected,
        image_id: id,
        offset: 0n,
        size: BigInt(input.length),
        architecture: 'x86_64',
        subtype: 'generic',
        supported: true,
      },
    ],
    target: {
      format: 'pe',
      architecture: 'x86_64',
      abi: 'windows-x64',
      endian: 'little',
      address_bits: 64,
      features: [],
    },
    image_base: base,
    address_map: new AddressMap({
      image_id: id,
      image_base: base,
      byte_length: BigInt(input.length),
      slice_offset: 0n,
      slice_size: BigInt(input.length),
      mappings,
    }),
    mappings,
    headers: [],
    sections: [],
    entry_points: [],
    symbols: [],
    imports: [],
    exports: [],
    relocations: [],
    hints: options.hints ?? [],
    evidence: [],
    diagnostics: [],
    capabilities: [],
  };
}
export function region(
  image: LoadedImage,
  start = image.image_base,
  size = image.bytes.length,
): AddressRange {
  return { start: { image_id: image.id, space: 'va', value: start }, size: BigInt(size) };
}
