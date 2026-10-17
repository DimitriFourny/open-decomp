import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  contentHash,
  createOperationContext,
  imageIdentity,
  ImmutableBytes,
  type LoadedImage,
} from '../../../src/core/index.js';
import { MachOLoader } from '../../../src/loaders/macho/index.js';
import type { ExternalDebugInput } from '../../../src/metadata/debug/index.js';

export function fixtureImage(): LoadedImage {
  const input = readFileSync(new URL('./fixtures/debug-image.dylib', import.meta.url));
  const sha256 = contentHash(input),
    image_id = imageIdentity(sha256),
    bytes = new ImmutableBytes(input);
  const loader = new MachOLoader();
  const inspection = loader.inspect(bytes, image_id, createOperationContext());
  const slice = inspection.slices.find((candidate) => candidate.supported);
  assert.ok(slice);
  return loader.load({ bytes, sha256, image_id, slice_id: slice.id }, createOperationContext());
}
export function fixtureDebug(): ExternalDebugInput {
  const bytes = readFileSync(new URL('./fixtures/debug-image.dwarf', import.meta.url));
  const expectedSha256 = contentHash(bytes);
  return { bytes, expectedSha256, artifact_id: `artifact_${expectedSha256}` };
}
