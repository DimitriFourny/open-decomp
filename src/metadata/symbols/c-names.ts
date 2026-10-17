import type { Target } from '../../core/index.js';

/** Mach-O prefixes each C linkage symbol with one underscore; ELF and PE keep C names unchanged. */
export function cSourceName(format: Target['format'], nativeName: string): string {
  return format === 'macho' && nativeName.startsWith('_') ? nativeName.slice(1) : nativeName;
}
