#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import {
  computeFingerprints,
  FINGERPRINT_FILE,
  type Fingerprints,
} from '../test/support/output-fingerprints.js';

// Regenerates test/service/fixtures/output-fingerprints.json. Run it (and review the diff)
// after bumping versions.ts / the emitter versions for an intentional output change:
//   bun run fingerprints
const previous = await readFile(FINGERPRINT_FILE, 'utf8')
  .then((text) => JSON.parse(text) as Fingerprints)
  .catch(() => undefined);
const next = await computeFingerprints();
await writeFile(FINGERPRINT_FILE, `${JSON.stringify(next, null, 2)}\n`);

let changed = 0;
for (const [key, record] of Object.entries(next.records)) {
  const old = previous?.records[key];
  if (old?.identity !== record.identity) console.log(`${key}: identity ${old ? 'changed' : 'new'}`);
  for (const [name, hash] of Object.entries(record.functions))
    if (old?.functions[name] !== hash) {
      changed++;
      console.log(`${key}: ${name} output ${old?.functions[name] ? 'changed' : 'new'}`);
    }
}
console.log(
  `Wrote ${FINGERPRINT_FILE} (${changed} output fingerprint(s) differ from the previous file)`,
);
