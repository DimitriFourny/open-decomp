import { OperationError, type CacheIdentity, type Target } from '../../core/index.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import { MachOLoader } from '../../loaders/macho/index.js';
import { PELoader } from '../../loaders/pe/index.js';
import { ELFLoader } from '../../loaders/elf/index.js';
import { Arm64Lifter } from '../../lifters/arm64/index.js';
import { X86Lifter } from '../../lifters/x86_64/index.js';
import { DarwinArm64Abi } from '../../abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../abi/windows-x64/index.js';
import { SysVAMD64Abi } from '../../abi/sysv-amd64/index.js';
import { C_EMITTER_VERSION } from '../../emitters/c/index.js';
import { PYTHON_LIKE_EMITTER_VERSION } from '../../emitters/python-like/index.js';

const x86Lifter = new X86Lifter();
const components = {
  darwin_arm64: Object.freeze({
    abi: new DarwinArm64Abi(),
    lifter: new Arm64Lifter(),
    loader: new MachOLoader(),
  }),
  windows_x64: Object.freeze({
    abi: new WindowsX64Abi(),
    lifter: x86Lifter,
    loader: new PELoader(),
  }),
  sysv_amd64: Object.freeze({
    abi: new SysVAMD64Abi(),
    lifter: x86Lifter,
    loader: new ELFLoader(),
  }),
};

/** Dispatch on the full target contract, not the host or ISA alone. Features
 * remain part of CacheIdentity and are consumed by decoding, not ABI selection. */
function targetPipeline(target: Target): keyof typeof components | undefined {
  if (target.endian !== 'little' || target.address_bits !== 64) return undefined;
  if (target.architecture === 'arm64' && target.format === 'macho' && target.abi === 'darwin-arm64')
    return 'darwin_arm64';
  if (target.architecture === 'x86_64' && target.format === 'pe' && target.abi === 'windows-x64')
    return 'windows_x64';
  if (target.architecture === 'x86_64' && target.format === 'elf' && target.abi === 'sysv-amd64')
    return 'sysv_amd64';
  return undefined;
}

export function pipelineComponents(target: Target): (typeof components)[keyof typeof components] {
  const key = targetPipeline(target);
  if (!key)
    throw new OperationError({
      code: 'unsupported_target',
      severity: 'error',
      message: 'No complete lifter/ABI pipeline is registered for the target',
      evidence_ids: [],
    });
  return components[key];
}

// Components without independent releases are explicitly versioned by this
// composition contract. Bump the corresponding entry when its semantics change.
const analysis =
  'pipeline/8;discovery/1;targets/1;ssa/3;values-effects/3;stack-calls/4;debug/1;library/2;types/5;annotations/1;structure/1;reconstruction/20';
const versionRecords = (() => {
  const arm = new Arm64Decoder(),
    x86 = new X86Decoder({ formatting: false });
  try {
    const versions = (
      pipeline: keyof typeof components,
      decoder: string,
    ): Readonly<Record<CacheIdentity['options']['emitter'], CacheIdentity['versions']>> => {
      const component = components[pipeline];
      const common = {
        backend: 'open-decomp/1',
        loader: `${component.loader.name}/${component.loader.version}`,
        decoder,
        lifter: `${component.lifter.name}/${component.lifter.version}`,
        analysis,
        abi: `${component.abi.id}/${component.abi.version}`,
      };
      return Object.freeze({
        'c-like': Object.freeze({ ...common, emitter: C_EMITTER_VERSION }),
        'python-like': Object.freeze({ ...common, emitter: PYTHON_LIKE_EMITTER_VERSION }),
      });
    };
    return Object.freeze({
      darwin_arm64: versions('darwin_arm64', arm.version),
      windows_x64: versions('windows_x64', x86.version),
      sysv_amd64: versions('sysv_amd64', x86.version),
    });
  } finally {
    arm.dispose();
    x86.dispose();
  }
})();

/** Lookup reuses immutable version records; no decoder is allocated per query. */
export function pipelineVersions(
  target: Target,
  emitter: CacheIdentity['options']['emitter'],
): CacheIdentity['versions'] {
  const key = targetPipeline(target);
  if (!key)
    throw new OperationError({
      code: 'unsupported_target',
      severity: 'error',
      message: 'No versioned pipeline is registered for the target',
      evidence_ids: [],
    });
  return versionRecords[key][emitter];
}

/** A current revision or a different presentation option cannot authorize stale
 * derived identities. The selected emitter must match its own current version. */
export function acceptsAnalysisIdentity(identity: CacheIdentity): boolean {
  const key = targetPipeline(identity.target);
  if (!key) return false;
  const current = versionRecords[key][identity.options.emitter],
    actual = identity.versions;
  if (!current) return false;
  return (
    actual.backend === current.backend &&
    actual.loader === current.loader &&
    actual.decoder === current.decoder &&
    actual.lifter === current.lifter &&
    actual.analysis === current.analysis &&
    actual.abi === current.abi &&
    actual.emitter === current.emitter
  );
}
