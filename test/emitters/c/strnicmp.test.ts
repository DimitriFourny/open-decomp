import test from 'node:test';
import { checkStrnicmp } from './strnicmp-fixture.js';

test('SQLite source-backed native multi-exit loop preserves mismatch, equal, count and NULL results in both dialects', () => {
  checkStrnicmp();
});

test('SQLite split pointer cells recombine in source view, including carry across the low word', () => {
  checkStrnicmp('source');
  checkStrnicmp('source', 0xfffffffen);
});
