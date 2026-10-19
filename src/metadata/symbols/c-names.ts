import type { Target } from '../../core/index.js';

/** Mach-O prefixes each C linkage symbol with one underscore; ELF and PE keep C names unchanged. */
export function cSourceName(format: Target['format'], nativeName: string): string {
  return format === 'macho' && nativeName.startsWith('_') ? nativeName.slice(1) : nativeName;
}

/** The C name under which a native import is looked up in the library declarations:
 * the C source name without loader decoration. Mach-O: the leading underscore and any
 * `$INODE64` / `$UNIX2003` / `$DARWIN_EXTSN` / `$NOCANCEL` variant suffix; ELF: the
 * `@VERSION` / `@@VERSION` suffix; PE: the `__imp_` import-thunk prefix. Windows `A` and
 * `W` spellings stay distinct names. */
export function libraryLookupName(format: Target['format'], nativeName: string): string {
  if (format === 'macho') {
    const name = cSourceName(format, nativeName);
    const suffix = name.indexOf('$');
    return suffix > 0 ? name.slice(0, suffix) : name;
  }
  if (format === 'elf') {
    const version = nativeName.indexOf('@');
    return version > 0 ? nativeName.slice(0, version) : nativeName;
  }
  return nativeName.startsWith('__imp_') ? nativeName.slice(6) : nativeName;
}
