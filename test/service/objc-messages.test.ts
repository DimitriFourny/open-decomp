import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openBinary } from '../../src/api/index.js';
import type { BinarySession } from '../../src/api/index.js';

// Trusted, source-built Foundation fixtures (test/metadata/fixtures/objc-foundation.m);
// statically analyzed only, never executed.
async function open(t: TestContext, fixture: string): Promise<BinarySession> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-objc-')));
  const input = join(root, fixture);
  await copyFile(resolve('test/metadata/fixtures', fixture), input);
  const session = await openBinary(input);
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  return session;
}
async function text(
  session: BinarySession,
  name: string,
  emitter: 'c-like' | 'python-like' = 'c-like',
): Promise<string> {
  const result = await session.decompile({ name }, { emitter });
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  return result.data.emission.text;
}

for (const fixture of ['objc-foundation', 'objc-foundation-classic'])
  test(`${fixture}: resolved selectors render as messages in both dialects`, { timeout: 120000 }, async (t) => {
    const session = await open(t, fixture);
    const c = await text(session, '_ODMakeSummary');
    // Receiver class from its class-reference load; keyword arguments in order.
    assert.match(c, /\[ODCounter counterWithLabel:\w+\]/);
    assert.match(c, /\[(\w+) increment\];[\s\S]*\[\1 addValue:3 times:4\];[\s\S]*\[\1 summary\]/);
    // ARC runtime calls stay explicit, in order, with their results.
    assert.match(c, /objc_release\(\w+\);/);
    assert.match(c, /return objc_autoreleaseReturnValue\(/);
    assert.doesNotMatch(c, /objc_msgSend/);
    const python = await text(session, '_ODMakeSummary', 'python-like');
    assert.match(python, /ODCounter\.counterWithLabel_\(\w+\)/);
    assert.match(python, /(\w+)\.increment\(\)[\s\S]*\1\.addValue_times_\(3, 4\)/);
  });

test('method implementations, NSString literals, variadic and super sends', { timeout: 120000 }, async (t) => {
  const session = await open(t, 'objc-foundation');
  const summary = await text(session, '-[ODCounter(Describe) summary]');
  assert.match(summary, /-\[ODCounter summary\]\(\w+ self\b/);
  // A known variadic selector keeps its explicit open remainder.
  assert.match(
    summary,
    /\[NSString stringWithFormat:@"%@=%ld", [^\]]*unknown_argument_remainder\(\)\]/,
  );
  assert.match(summary, /\[self label\]/);
  assert.match(await text(session, '+[ODCounter greeting]'), /return @"hello, fixture";/);
  // Super sends stay explicit dispatcher calls with their selector.
  const init = await text(session, '-[ODCounter initWithLabel:]');
  assert.match(init, /objc_msgSendSuper2\([^;]*@selector\(init\)\)/);
  // objc_alloc + init stub: a nested message on the class receiver.
  assert.match(
    await text(session, '+[ODCounter counterWithLabel:]'),
    /\[\[self alloc\] initWithLabel:\w+\]/,
  );
  const python = await text(session, '+[ODCounter counterWithLabel:]', 'python-like');
  assert.match(python, /@classmethod\ndef ODCounter\.counterWithLabel_\(self\b/);
  assert.match(python, /self\.alloc\(\)\)?\.initWithLabel_\(\w+\)/);
});
