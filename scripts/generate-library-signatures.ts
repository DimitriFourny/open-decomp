#!/usr/bin/env node
// Builds a library signature file (src/metadata/library-signatures) from static libraries and
// relocatable objects (ELF64 x86-64 `.a` / `.o`), as FLIRT's sigmake does: every function
// symbol's body, with the bytes its relocations make position-dependent masked.
// Run: `bun run signatures -- --id glibc-2.41-x86_64 --title 'GNU C Library 2.41' \
//        --contracts libc.so.6 --out glibc.json /usr/lib/x86_64-linux-gnu/libc.a ...`
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  archiveMembers,
  buildSignatureLibrary,
  encodeSignatureLibrary,
  objectFunctions,
  type SignatureSource,
} from '../src/metadata/library-signatures/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    title: { type: 'string' },
    contracts: { type: 'string' },
    source: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.id || !values.title || !values.out || !positionals.length) {
  console.error(
    'usage: generate-library-signatures --id ID --title TEXT [--contracts LIBRARY] [--source TEXT] --out FILE INPUT.a|INPUT.o...',
  );
  process.exit(2);
}

function* sources(): Generator<SignatureSource> {
  for (const path of positionals) {
    const bytes = new Uint8Array(readFileSync(path));
    const members = path.endsWith('.o') ? [{ name: basename(path), bytes }] : archiveMembers(bytes);
    for (const member of members) {
      // Members that are not ELF x86-64 objects (linker scripts, other ISAs) carry no functions.
      if (member.bytes[0] !== 0x7f) continue;
      yield* objectFunctions(member);
    }
  }
}

const { library, stats } = buildSignatureLibrary(sources(), {
  id: values.id,
  title: values.title,
  architecture: 'x86_64',
  contracts: values.contracts ?? null,
  source: values.source ?? positionals.map((path) => basename(path)).join(', '),
});
const text = encodeSignatureLibrary(library);
writeFileSync(values.out, text);
console.log(
  `${values.out}: ${stats.signatures} signatures from ${stats.bodies} function bodies ` +
    `(${stats.shared} shared by several names, ${stats.skipped} skipped), ${text.length} bytes`,
);
