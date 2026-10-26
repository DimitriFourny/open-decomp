import { CParser } from './parser.js';
import type { CDeclarationTarget, CParseResult } from './types.js';

export type {
  CDeclarationTarget,
  CDiagnostic,
  CParsedType,
  CParseResult,
  CStructureField,
  CTypeDefinition,
} from './types.js';

/**
 * Parses C type declarations (struct/union/enum/typedef) into library-ready type definitions.
 * Pure and deterministic; problems are reported as diagnostics, never thrown.
 */
export function parseCDeclarations(source: string, target: CDeclarationTarget): CParseResult {
  return new CParser(source, target).parse();
}
