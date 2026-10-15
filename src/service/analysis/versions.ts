import type { CacheIdentity, Target } from '../../core/index.js';
import { Arm64Decoder } from '../../decoders/arm64/index.js';
import { X86Decoder } from '../../decoders/x86_64/index.js';
import { MachOLoader } from '../../loaders/macho/index.js';
import { PELoader } from '../../loaders/pe/index.js';
import { Arm64Lifter } from '../../lifters/arm64/index.js';
import { X86Lifter } from '../../lifters/x86_64/index.js';
import { DarwinArm64Abi } from '../../abi/darwin-arm64/index.js';
import { WindowsX64Abi } from '../../abi/windows-x64/index.js';
import { C_EMITTER_VERSION } from '../../emitters/c/index.js';

export const pipelineComponents = {
  arm64: { abi: new DarwinArm64Abi(), lifter: new Arm64Lifter(), loader: new MachOLoader() },
  x86_64: { abi: new WindowsX64Abi(), lifter: new X86Lifter(), loader: new PELoader() },
};

// Components without independent releases are explicitly versioned by this
// composition contract. Bump the corresponding entry when its semantics change.
const analysis = 'pipeline/1;discovery/1;targets/1;ssa/1;values-effects/1;stack-calls/1;debug/1;library/1;types/1;annotations/1;structure/1';
export const pipelineVersions: Record<Target['architecture'], CacheIdentity['versions']> = (() => {
  const arm = new Arm64Decoder(), x86 = new X86Decoder({ formatting: false });
  const versions = (architecture: Target['architecture'], decoder: string): CacheIdentity['versions'] => {
    const component = pipelineComponents[architecture];
    return { backend: 'open-decomp/1', loader: `${component.loader.name}/${component.loader.version}`, decoder,
      lifter: `${component.lifter.name}/${component.lifter.version}`, analysis,
      abi: `${component.abi.id}/${component.abi.version}`, emitter: C_EMITTER_VERSION };
  };
  const result = { arm64: versions('arm64', arm.version), x86_64: versions('x86_64', x86.version) };
  arm.dispose(); x86.dispose();
  return result;
})();

/** Current revision alone cannot authorize old software's derived identities.
 * All supported presentation options share these semantic component versions. */
export function acceptsAnalysisIdentity(identity: CacheIdentity): boolean {
  const current = pipelineVersions[identity.target.architecture], actual = identity.versions;
  return actual.backend === current.backend && actual.loader === current.loader && actual.decoder === current.decoder &&
    actual.lifter === current.lifter && actual.analysis === current.analysis && actual.abi === current.abi && actual.emitter === current.emitter;
}
