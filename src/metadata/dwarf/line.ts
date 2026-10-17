import { OperationError } from '../../core/index.js';
import type { DebugLine } from './model.js';
import {
  DwarfReader,
  DwarfTextBudget,
  DWARF_LIMITS,
  MAX_ADDRESS,
  number,
  sectionReader,
  type DwarfSections,
} from './reader.js';

interface SourceFile {
  name: string;
  directory: number;
  path?: string | undefined;
}

export function readLineProgram(
  sections: DwarfSections,
  offset: number,
  defaultAddressSize: number,
  compilationDirectory: string,
  little: boolean,
  rowLimit: number,
  spend?: () => void,
  textBudget = new DwarfTextBudget(),
): { lines: DebugLine[]; diagnostics: string[]; files: Map<number, string> } {
  const section = sectionReader(sections, '__debug_line', offset, little),
    contribution = section.initialLength();
  const r = new DwarfReader(section.bytes, section.position, contribution.end, little),
    version = r.u16();
  if (version < 2 || version > 5) throw new Error(`Unsupported line-program version ${version}`);
  const addressSize = version === 5 ? r.u8() : defaultAddressSize;
  if (addressSize !== 4 && addressSize !== 8)
    throw new Error('Unsupported line-program address size');
  if (version === 5 && r.u8() !== 0) throw new Error('Segmented line addresses are unsupported');
  const headerLength = number(r.uint(contribution.offsetSize)),
    headerEnd = r.position + headerLength;
  r.need(headerLength);
  const h = new DwarfReader(r.bytes, r.position, headerEnd, little);
  const minimumInstruction = h.u8(),
    maxOperations = version >= 4 ? h.u8() : 1;
  h.u8(); // default_is_stmt does not affect source-address mapping.
  const rawLineBase = h.u8(),
    lineBase = rawLineBase & 128 ? rawLineBase - 256 : rawLineBase;
  const lineRange = h.u8(),
    opcodeBase = h.u8();
  if (!minimumInstruction || !maxOperations || !lineRange || !opcodeBase)
    throw new Error('Invalid line-program opcode parameters');
  const operandCounts = [0];
  for (let i = 1; i < opcodeBase; i++) operandCounts.push(h.u8());
  const directories: string[] = [],
    files: SourceFile[] = [];
  const diagnostics: string[] = [];
  function tableValue(reader: DwarfReader, form: number): string | bigint | Uint8Array {
    if (form === 8) return reader.string(textBudget);
    if (form === 0xe || form === 0x1f)
      return sectionReader(
        sections,
        form === 0xe ? '__debug_str' : '__debug_line_str',
        number(reader.uint(contribution.offsetSize)),
        little,
      ).string(textBudget);
    if (form === 0xf) return reader.leb();
    if (form === 0xd) return reader.leb(true);
    if (form === 0xb || form === 0x5 || form === 0x6 || form === 0x7)
      return reader.uint(({ 11: 1, 5: 2, 6: 4, 7: 8 } as Record<number, number>)[form]!);
    if (form === 0x1e) return reader.block(16);
    if (form === 9) return reader.block(reader.nleb());
    throw new Error(`Unsupported DWARF5 line-table form 0x${form.toString(16)}`);
  }
  function readTable(directory: boolean): void {
    const formatCount = h.u8(),
      formats: { content: number; form: number }[] = [];
    for (let i = 0; i < formatCount; i++) formats.push({ content: h.nleb(), form: h.nleb() });
    const count = h.nleb();
    if (!formatCount && count) throw new Error('Empty DWARF5 line-table entry format');
    if (count > 100_000) throw new Error('Source-file table limit exceeded');
    for (let i = 0; i < count; i++) {
      spend?.();
      let name: string | undefined,
        index = 0;
      for (const format of formats) {
        const value = tableValue(h, format.form);
        if (format.content === 1) {
          if (typeof value !== 'string') throw new Error('Invalid source path form');
          name = value;
        }
        if (format.content === 2) {
          if (typeof value !== 'bigint') throw new Error('Invalid directory index form');
          index = number(value);
        }
      }
      if (name === undefined) throw new Error('Missing source path in line table');
      if (directory) directories.push(name);
      else files.push({ name, directory: index });
    }
  }
  function legacyFile(reader: DwarfReader, name: string): SourceFile {
    const directory = reader.nleb();
    reader.leb();
    reader.leb();
    return { name, directory };
  }
  if (version === 5) {
    readTable(true);
    readTable(false);
  } else {
    while (true) {
      const name = h.string(textBudget);
      if (!name) break;
      if (directories.length >= 100_000) throw new Error('Directory-table limit exceeded');
      directories.push(name);
    }
    while (true) {
      const name = h.string(textBudget);
      if (!name) break;
      if (files.length >= 100_000) throw new Error('Source-file table limit exceeded');
      files.push(legacyFile(h, name));
    }
  }
  if (h.position !== headerEnd) throw new Error('Line-program header length mismatch');
  r.position = headerEnd;
  let address = 0n,
    operation = 0,
    file = 1,
    line = 1n,
    column = 0,
    sequenceStarted = false;
  let previous: DebugLine | undefined;
  const lines: DebugLine[] = [];
  function advance(operations: bigint): void {
    const total = BigInt(operation) + operations;
    address += BigInt(minimumInstruction) * (total / BigInt(maxOperations));
    operation = Number(total % BigInt(maxOperations));
    if (address > MAX_ADDRESS) throw new Error('Line-program address overflows 64 bits');
  }
  function filePath(file: number): string {
    const source = files[version === 5 ? file : file - 1];
    if (!source) throw new Error(`Invalid source file index ${file}`);
    const directory =
      version === 5
        ? directories[source.directory]
        : source.directory
          ? directories[source.directory - 1]
          : compilationDirectory;
    let path = source.path;
    if (path === undefined) {
      path = source.name;
      if (!path.startsWith('/')) {
        if (directory === undefined)
          throw new Error(`Invalid source directory index ${source.directory}`);
        const directDirectory =
          directory.startsWith('/') || (version < 5 && source.directory === 0);
        const parentSize = directDirectory
          ? directory.length
          : compilationDirectory.length +
            directory.length +
            (compilationDirectory && directory ? 1 : 0);
        textBudget.consume(
          parentSize +
            path.length +
            (parentSize && path ? 1 : 0) +
            (directDirectory ? 0 : parentSize),
        );
        const parent = directDirectory
          ? directory
          : [compilationDirectory, directory].filter(Boolean).join('/');
        path = [parent, path].filter(Boolean).join('/');
      }
      source.path = path;
    }
    return path;
  }
  function emit(endSequence: boolean): void {
    if (previous) {
      if (address < previous.address)
        throw new Error('Line-program addresses decrease within a sequence');
      previous.endAddress = address;
    }
    if (endSequence) {
      previous = undefined;
      return;
    }
    if (line === 0n) {
      previous = undefined;
      sequenceStarted = true;
      return;
    }
    if (lines.length >= rowLimit) throw new Error('Source-line row limit exceeded');
    const path = filePath(file);
    if (line < 0n || line > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Invalid source line number');
    previous = { address, file: path, line: Number(line), column };
    lines.push(previous);
    sequenceStarted = true;
  }
  let steps = 0;
  while (r.position < r.end) {
    spend?.();
    if (++steps > DWARF_LIMITS.steps) throw new Error('Line-program operation limit exceeded');
    const opcode = r.u8();
    if (opcode === 0) {
      const size = r.nleb();
      if (!size) throw new Error('Empty extended line opcode');
      r.need(size);
      const end = r.position + size,
        ext = new DwarfReader(r.bytes, r.position, end, little),
        extended = ext.u8();
      if (extended === 1) {
        emit(true);
        address = 0n;
        operation = 0;
        file = 1;
        line = 1n;
        column = 0;
        sequenceStarted = false;
      } else if (extended === 2) {
        address = ext.uint(addressSize);
        operation = 0;
      } else if (extended === 3) {
        if (version === 5) throw new Error('DW_LNE_define_file with DWARF5 format is unsupported');
        if (files.length >= 100_000) throw new Error('Source-file table limit exceeded');
        files.push(legacyFile(ext, ext.string(textBudget)));
      } else if (extended === 4) ext.leb();
      else {
        if (diagnostics.length < 100)
          diagnostics.push(
            `Unknown extended line opcode ${extended} skipped using its explicit length.`,
          );
        ext.position = end;
      }
      if (ext.position !== end) throw new Error('Extended line opcode length mismatch');
      r.position = end;
    } else if (opcode >= opcodeBase) {
      const adjusted = opcode - opcodeBase;
      advance(BigInt(Math.floor(adjusted / lineRange)));
      line += BigInt(lineBase + (adjusted % lineRange));
      emit(false);
    } else {
      switch (opcode) {
        case 1:
          emit(false);
          break;
        case 2:
          advance(r.leb());
          break;
        case 3:
          line += r.leb(true);
          break;
        case 4:
          file = r.nleb();
          break;
        case 5:
          column = r.nleb();
          break;
        case 6:
        case 7:
        case 10:
        case 11:
          break;
        case 8:
          advance(BigInt(Math.floor((255 - opcodeBase) / lineRange)));
          break;
        case 9:
          address += BigInt(r.u16());
          operation = 0;
          if (address > MAX_ADDRESS) throw new Error('Line-program address overflow');
          break;
        case 12:
          r.leb();
          break;
        default:
          for (let i = 0; i < operandCounts[opcode]!; i++) r.leb();
          if (diagnostics.length < 100)
            diagnostics.push(
              `Unknown standard line opcode ${opcode} skipped using its operand count.`,
            );
      }
    }
  }
  if (sequenceStarted) throw new Error('Line program is missing end_sequence');
  const sourceFiles = new Map<number, string>();
  for (let i = 0; i < files.length; i++) {
    spend?.();
    const index = version === 5 ? i : i + 1;
    try {
      sourceFiles.set(index, filePath(index));
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (diagnostics.length < 100) diagnostics.push(`Source file ${index}: ${String(error)}`);
    }
  }
  return { lines, diagnostics, files: sourceFiles };
}
