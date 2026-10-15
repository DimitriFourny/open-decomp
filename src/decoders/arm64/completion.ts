import type { DecodedInstruction, GeneratedEncoding, Operand } from '../../../vendor/a64js/src/types.js';

/** The original adapter's architectural completion, deliberately outside generated tables. */
export function completeLogical(decoded: DecodedInstruction): DecodedInstruction {
  const word = decoded.word;
  if (decoded.status !== 'unknown' || decoded.encoding || (word & 0x1f000000) !== 0x0a000000) return decoded;
  const fields = {
    sf: word >>> 31, opc: (word >>> 29) & 3, shift: (word >>> 22) & 3,
    N: (word >>> 21) & 1, Rm: (word >>> 16) & 31, imm6: (word >>> 10) & 63,
    Rn: (word >>> 5) & 31, Rd: word & 31,
  };
  const mnemonic = (fields.N ? ['BIC', 'ORN', 'EON', 'BICS'] : ['AND', 'ORR', 'EOR', 'ANDS'])[fields.opc]!;
  const width = fields.sf ? 64 : 32;
  const fileName = mnemonic === 'BICS' ? 'bics.xml' : `${mnemonic.toLowerCase()}_log_shift.xml`;
  const encoding: GeneratedEncoding = {
    instructionId: `${mnemonic}_log_shift`, encodingId: `${mnemonic}_${width}_log_shift`,
    mnemonic, className: 'Logical (shifted register)', fileName,
    mask: 0x7f200000, value: (word & 0x7f200000) >>> 0,
    fields: [
      { name: 'sf', lsb: 31, width: 1 }, { name: 'opc', lsb: 29, width: 2 },
      { name: 'shift', lsb: 22, width: 2 }, { name: 'N', lsb: 21, width: 1 },
      { name: 'Rm', lsb: 16, width: 5 }, { name: 'imm6', lsb: 10, width: 6 },
      { name: 'Rn', lsb: 5, width: 5 }, { name: 'Rd', lsb: 0, width: 5 },
    ], features: [], featureGuards: [], guards: [], operandFamilyId: 'logical-shifted-register',
  };
  if (!fields.sf && fields.imm6 >= 32) return {
    status: 'undefined', word, encoding, fields, mnemonic, availability: 'available',
    errors: ['32-bit logical shifts must be less than 32.'],
  };
  const register = (index: number): Operand => ({ kind: 'reg', index, width, zeroName: 'zr' });
  return {
    status: 'ok', availability: 'available', behavior: 'instruction', word, encoding, fields, mnemonic,
    operands: [
      register(fields.Rd), register(fields.Rn), register(fields.Rm),
      ...(fields.shift || fields.imm6 ? [{ kind: 'text' as const, text: `${['lsl', 'lsr', 'asr', 'ror'][fields.shift]} #${fields.imm6}` }] : []),
    ],
  };
}
