import { OperationError, type LoadedImage, type OperationContext } from '../../core/index.js';
import { recoverCodeViewReferences } from '../codeview/index.js';
import { readPdbIdentity, type PdbFrame, type PdbIdentity } from '../pdb/index.js';

/** CodeView register numbers of the x64 unwind register encoding (RAX, RCX, ... R15). */
const CODEVIEW_REGISTER = [
  328, 330, 331, 329, 335, 334, 332, 333, 336, 337, 338, 339, 340, 341, 342, 343,
];

/** The PDB's identity when it is the one the image's RSDS record names (same GUID and
 * age); otherwise a `conflicting_evidence` error. Paths in the record are never used. */
export function matchPdb(
  image: LoadedImage,
  bytes: Uint8Array,
  context: OperationContext,
): PdbIdentity {
  let pdb: PdbIdentity;
  try {
    pdb = readPdbIdentity(bytes, context);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError({
      code: 'invalid_input',
      severity: 'error',
      message: `Debug input is not a readable PDB: ${error instanceof Error ? error.message : String(error)}`,
      evidence_ids: [],
    });
  }
  const references = recoverCodeViewReferences({ image, revision: 0 }, context);
  const identities = references.references.flatMap((reference) =>
    reference.identity?.kind === 'rsds' && reference.status === 'identity'
      ? [reference.identity]
      : [],
  );
  const named = `PDB GUID ${pdb.guid} age ${pdb.age}`;
  if (!identities.length)
    throw new OperationError({
      code: 'conflicting_evidence',
      severity: 'error',
      message: `The image has no CodeView (RSDS) PDB reference to match ${named} against`,
      evidence_ids: [],
    });
  const own = identities[0]!;
  if (own.guid !== pdb.guid || own.age !== BigInt(pdb.age))
    throw new OperationError({
      code: 'conflicting_evidence',
      severity: 'error',
      message: `${named} does not match the image's PDB reference (GUID ${own.guid} age ${own.age})`,
      evidence_ids: [],
    });
  return pdb;
}

/**
 * The frame of each function after its prologue, from the image's x64 unwind data
 * (UNWIND_INFO v1, already validated by the loader): the stack pointer and, when the
 * prologue sets one (UWOP_SET_FPREG), the frame register, both relative to the entry stack
 * pointer. A function without unwind data in an image that has some is a leaf whose stack
 * pointer never moves. Chained or machine-frame unwind data establishes no frame.
 */
export function unwindFrames(image: LoadedImage): (address: bigint) => PdbFrame | null {
  const records = new Map<bigint, { offset: bigint; size: number }>();
  for (const hint of image.hints)
    if (hint.kind === 'unwind' && hint.encoding === 'PE_AMD64_UNWIND_INFO_V1')
      records.set(hint.range.start.value, {
        offset: hint.record.start.value,
        size: Number(hint.record.size),
      });
  return (address) => {
    const record = records.get(address);
    if (!record) return records.size ? { stack: 0n } : null;
    const bytes = image.bytes.read(record.offset, record.size);
    const flags = bytes[0]! >> 3,
      count = bytes[2]!,
      frame = bytes[3]!;
    if (flags & 4) return null;
    // Unwind codes list the prologue's operations last first; replay them in order.
    const operations: { op: number; info: number; operand: number }[] = [];
    for (let slot = 0; slot < count;) {
      const op = bytes[4 + slot * 2 + 1]! & 15,
        info = bytes[4 + slot * 2 + 1]! >> 4;
      const operand = (index: number) => bytes[4 + index * 2]! | (bytes[4 + index * 2 + 1]! << 8);
      let size = 1,
        value = 0;
      if (op === 1) {
        size = info === 0 ? 2 : 3;
        value = info === 0 ? operand(slot + 1) * 8 : operand(slot + 1) + operand(slot + 2) * 65536;
      } else if (op === 4 || op === 8) size = 2;
      else if (op === 5 || op === 9) size = 3;
      else if (op === 10) return null;
      operations.unshift({ op, info, operand: value });
      slot += size;
    }
    let allocated = 0n;
    let fp: PdbFrame['frame'];
    for (const { op, info, operand } of operations) {
      if (op === 0) allocated += 8n;
      else if (op === 1) allocated += BigInt(operand);
      else if (op === 2) allocated += BigInt(info * 8 + 8);
      else if (op === 3)
        fp = {
          register: CODEVIEW_REGISTER[frame & 15]!,
          value: -allocated + BigInt((frame >> 4) * 16),
        };
    }
    return { stack: -allocated, ...(fp ? { frame: fp } : {}) };
  };
}
