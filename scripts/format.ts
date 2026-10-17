#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
if (args[0] === '--') args.shift();
const paths = args.length > 0 ? args : ['.'];
const steps = [
  { command: 'eslint', flags: check ? [] : ['--fix'] },
  { command: 'prettier', flags: [check ? '--check' : '--write'] },
];

for (const { command, flags } of steps) {
  const result = spawnSync(command, [...flags, '--', ...paths], { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
