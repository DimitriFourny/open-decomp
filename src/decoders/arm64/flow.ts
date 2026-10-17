import type { Address, Arm64Payload, DecodedFlow, DecodedInstruction } from '../../core/index.js';
import type { DecodedInstruction as NativeInstruction } from '../../../vendor/a64js/src/types.js';
import { relativeAddress } from './operands.js';

export function instructionFlow(
  decoded: NativeInstruction,
  payload: Arm64Payload | null,
  validity: DecodedInstruction['validity'],
  pc: Address,
): DecodedFlow {
  const next = relativeAddress(pc, 4n);
  if (decoded.behavior === 'nop') return { kind: 'fallthrough', next };
  if (validity !== 'valid')
    return { kind: 'unknown', reason: `ARM64 ${validity} encoding`, may_fallthrough: true };
  const mnemonic = decoded.mnemonic ?? '';
  if (mnemonic === 'UDF' || mnemonic === 'BRK' || mnemonic === 'HLT')
    return { kind: 'trap', reason: mnemonic, conditional: false, fallthrough: null };
  if (['SVC', 'HVC', 'SMC', 'DCPS1', 'DCPS2', 'DCPS3'].includes(mnemonic))
    return {
      kind: 'unknown',
      reason: `${mnemonic} transfers to an external exception handler; resumption is not established`,
      may_fallthrough: true,
    };
  if (
    ['RET', 'RETAA', 'RETAB', 'RETAASPPC', 'RETABSPPC', 'RETAASPPCR', 'RETABSPPCR'].includes(
      mnemonic,
    )
  )
    return { kind: 'return' };
  if (
    ['BR', 'BRAA', 'BRAB', 'BRAAZ', 'BRABZ', 'ERET', 'ERETAA', 'ERETAB', 'DRPS'].includes(mnemonic)
  )
    return { kind: 'indirect_branch', conditional: false, fallthrough: null };
  if (['BLR', 'BLRAA', 'BLRAB', 'BLRAAZ', 'BLRABZ'].includes(mnemonic))
    return { kind: 'call', target: null, fallthrough: next, indirect: true };
  const relative = payload?.operands.find((operand) => operand.kind === 'relative');
  if (mnemonic === 'BL') {
    return relative?.kind === 'relative'
      ? { kind: 'call', target: relative.target, fallthrough: next, indirect: false }
      : { kind: 'unknown', reason: 'Direct call has no decoded target', may_fallthrough: true };
  }
  const conditional =
    ['CBZ', 'CBNZ', 'TBZ', 'TBNZ', 'BC'].includes(mnemonic) ||
    (mnemonic === 'B' && decoded.fields?.cond !== undefined);
  if (mnemonic === 'B' || conditional) {
    return relative?.kind === 'relative'
      ? {
          kind: 'branch',
          target: relative.target,
          conditional,
          fallthrough: conditional ? next : null,
        }
      : {
          kind: 'unknown',
          reason: 'Direct branch has no decoded target',
          may_fallthrough: conditional,
        };
  }
  return { kind: 'fallthrough', next };
}
