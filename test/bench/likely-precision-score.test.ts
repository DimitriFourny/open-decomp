import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_SITES,
  gate,
  guessableSites,
  parseDeclaration,
  parseDwarf,
  scoreArity,
  scoreType,
  tally,
  typePopulation,
} from '../../scripts/bench/likely-precision-score.js';
import type {
  ArityGuessRow,
  CallRow,
  GuessRow,
  Truth,
  TypeGuessRow,
} from '../../scripts/bench/likely-precision-score.js';

// Shaped like `dwarfdump --debug-info` output of an -O1 compile: header lines carry the DIE
// offset and tag, nesting is two columns per level, attributes are `DW_AT_name (value)`.
const DUMP = `
0x0000000b: DW_TAG_compile_unit
              DW_AT_name	("x.c")

0x00000020:   DW_TAG_base_type
                DW_AT_name	("unsigned int")
                DW_AT_encoding	(DW_ATE_unsigned)
                DW_AT_byte_size	(0x04)

0x00000030:   DW_TAG_base_type
                DW_AT_name	("double")
                DW_AT_encoding	(DW_ATE_float)
                DW_AT_byte_size	(0x08)

0x00000040:   DW_TAG_pointer_type
                DW_AT_type	(0x00000020 "unsigned int")

0x00000050:   DW_TAG_typedef
                DW_AT_name	("handle")
                DW_AT_type	(0x00000040 "unsigned int *")

0x00000060:   DW_TAG_structure_type
                DW_AT_name	("pair")
                DW_AT_byte_size	(0x10)

0x00000070:   DW_TAG_subprogram
                DW_AT_name	("scale")
                DW_AT_type	(0x00000030 "double")
                DW_AT_external	(true)

0x00000080:     DW_TAG_formal_parameter
                  DW_AT_name	("h")
                  DW_AT_type	(0x00000050 "handle")

0x00000090:     DW_TAG_formal_parameter
                  DW_AT_name	("n")
                  DW_AT_type	(0x00000020 "unsigned int")

0x000000a0:     DW_TAG_lexical_block
0x000000b0:       DW_TAG_formal_parameter
                    DW_AT_name	("not a parameter of scale")
                    DW_AT_type	(0x00000020 "unsigned int")

0x000000c0:   DW_TAG_subprogram
                DW_AT_name	("log_line")
                DW_AT_declaration	(true)

0x000000d0:     DW_TAG_formal_parameter
                  DW_AT_type	(0x00000040 "unsigned int *")

0x000000e0:     DW_TAG_unspecified_parameters

0x000000f0:   DW_TAG_subprogram
                DW_AT_name	("swap_pair")
                DW_AT_type	(0x00000060 "pair")

0x00000100:     DW_TAG_formal_parameter
                  DW_AT_type	(0x00000060 "pair")
`;

test('DWARF truth: parameters, result, variadic and by-value aggregates', () => {
  const truth = parseDwarf(DUMP);
  assert.deepEqual(truth['scale'], {
    params: [
      { kind: 'pointer', bits: 64 },
      { kind: 'int', bits: 32 },
    ],
    result: { kind: 'float', bits: 64 },
    variadic: false,
    complex: false,
  });
  assert.equal(truth['log_line']!.variadic, true);
  assert.equal(truth['log_line']!.result, null);
  assert.equal(truth['swap_pair']!.complex, true);
});

const word = { kind: 'int', bits: 64 } as const;
const truth: Truth = {
  two: { params: [word, word], result: null, variadic: false, complex: false },
  log: { params: [{ kind: 'pointer', bits: 64 }], result: null, variadic: true, complex: false },
  pair: { params: [], result: null, variadic: false, complex: true },
};
const guess = (name: string | null, arity: number, id = `c${arity}${name}`): ArityGuessRow => ({
  subject: 'argument_list',
  caller: 'f',
  call_id: id,
  target_address: '1',
  target_name: name,
  heuristics: ['caller_consensus'],
  applied: true,
  arity,
  sites: 2,
});

test('arity scoring: exact count is correct; over, under, variadic and unknown targets are not', () => {
  assert.equal(scoreArity(guess('two', 2), truth).outcome, 'correct');
  assert.equal(scoreArity(guess('two', 3), truth).outcome, 'over');
  assert.equal(scoreArity(guess('two', 1), truth).outcome, 'under');
  // Closing the list of a variadic function is wrong however many arguments the site passes.
  assert.equal(scoreArity(guess('log', 1), truth).outcome, 'variadic');
  assert.equal(scoreArity(guess('pair', 0), truth).outcome, 'complex');
  assert.equal(scoreArity(guess('missing', 1), truth).outcome, 'unscored');
  assert.equal(scoreArity(guess(null, 1), truth).outcome, 'unscored');
});

test('the gate needs both site and callee precision at 95% on enough scored guesses', () => {
  const right = Array.from({ length: MIN_SITES - 1 }, (_, index) => guess('two', 2, `r${index}`));
  const passing = gate(tally([...right, guess('two', 2, 'last')], truth));
  assert.equal(passing.find((v) => v.heuristic === 'caller_consensus')!.passes, true);
  // One wrong site among MIN_SITES keeps the site precision at 95%, but it makes its callee
  // wrong, so the callee-level precision fails the gate.
  const oneWrong = gate(tally([...right, guess('two', 3, 'wrong')], truth));
  const consensus = oneWrong.find((v) => v.heuristic === 'caller_consensus')!;
  assert.equal(consensus.precision_sites, (MIN_SITES - 1) / MIN_SITES);
  assert.equal(consensus.precision_callees, 0);
  assert.equal(consensus.passes, false);
  // Too few scored guesses cannot show 95%, and unscored guesses do not count.
  const few = gate(tally([guess('two', 2), guess('missing', 5)], truth));
  assert.equal(few.find((v) => v.heuristic === 'caller_consensus')!.passes, false);
  assert.equal(few.find((v) => v.heuristic === 'callee_reads')!.sites, 0);
});

test('guessable sites are open direct calls to fixed-arity functions with source truth', () => {
  const call = (name: string | null, complete: boolean, address: string | null = '1'): CallRow => ({
    caller: 'f',
    call_id: `${name}${complete}${address}`,
    target_address: address,
    target_name: name,
    arity_complete: complete,
  });
  const calls = [
    call('two', false),
    call('two', true),
    call('log', false),
    call('pair', false),
    call('two', false, null),
    call('missing', false),
  ];
  assert.equal(guessableSites(calls, truth), 1);
});

const pointer = { kind: 'pointer', bits: 64 } as const;
const typed: Truth = {
  mixed: { params: [pointer, word, pointer], result: pointer, variadic: false, complex: false },
  floaty: {
    params: [{ kind: 'float', bits: 64 }, pointer],
    result: null,
    variadic: false,
    complex: false,
  },
  pair: { params: [], result: null, variadic: false, complex: true },
};
const typeGuess = (
  caller: string,
  subject: TypeGuessRow['subject'],
  ordinal: number | null,
  printed = 3,
  heuristic: TypeGuessRow['heuristics'][number] = 'opaque_word_formal',
): TypeGuessRow => ({
  subject,
  caller,
  ordinal,
  printed_params: printed,
  heuristics: [heuristic],
  applied: true,
  sites: null,
});

test('type scoring: a guessed pointer is right only for a declared pointer', () => {
  assert.equal(scoreType(typeGuess('mixed', 'parameter_type', 0), typed).outcome, 'correct');
  assert.equal(scoreType(typeGuess('mixed', 'parameter_type', 1), typed).outcome, 'wrong');
  assert.equal(scoreType(typeGuess('mixed', 'result_type', null), typed).outcome, 'correct');
  // A void function has no pointer result to guess.
  assert.equal(scoreType(typeGuess('floaty', 'result_type', null), typed).outcome, 'wrong');
  // Positions only line up when the printed and declared counts agree and no formal is a float.
  assert.equal(scoreType(typeGuess('mixed', 'parameter_type', 0, 4), typed).outcome, 'unscored');
  assert.equal(scoreType(typeGuess('floaty', 'parameter_type', 1, 2), typed).outcome, 'unscored');
  assert.equal(scoreType(typeGuess('pair', 'result_type', null), typed).outcome, 'complex');
  assert.equal(scoreType(typeGuess('missing', 'result_type', null), typed).outcome, 'unscored');
});

test('the gate judges a type heuristic on its own guesses, per formal and result', () => {
  // 20 correct formals pass; a 21st that is wrong takes the heuristic below 95% by sites.
  const formals: GuessRow[] = Array.from({ length: MIN_SITES }, () =>
    typeGuess('mixed', 'parameter_type', 0),
  );
  const passing = gate(tally(formals, typed)).find((v) => v.heuristic === 'opaque_word_formal')!;
  assert.equal(passing.passes, true);
  const failing = gate(tally([...formals, typeGuess('mixed', 'parameter_type', 1)], typed)).find(
    (v) => v.heuristic === 'opaque_word_formal',
  )!;
  assert.equal(failing.precision_callees, 0.5);
  assert.equal(failing.passes, false);
  // Another heuristic's guesses never count for this one.
  assert.equal(
    gate(tally(formals, typed)).find((v) => v.heuristic === 'indirect_call_target')!.sites,
    0,
  );
});

test('printed declarations: pointer spelling per formal and result', () => {
  assert.deepEqual(
    parseDeclaration(
      'const char* name(uint32_t count, void (*cb)(int, int), likely_type(uint8_t*) p) {',
    ),
    { result_pointer: true, params: [false, true, true] },
  );
  assert.deepEqual(parseDeclaration('uint64_t f(void) {'), { result_pointer: false, params: [] });
  assert.deepEqual(parseDeclaration('def f(a: uint64_t, b: pointer[uint8_t]) -> uint64_t:'), {
    result_pointer: false,
    params: [false, true],
  });
  assert.equal(parseDeclaration('no parentheses'), null);
});

test('type population separates proven pointers from those only a guess made pointers', () => {
  const observations = [
    { name: 'mixed', result_pointer: false, params: [true, false, false] },
    { name: 'floaty', result_pointer: false, params: [false, true] },
    { name: 'pair', result_pointer: false, params: [] },
  ];
  // `mixed` prints formal 0 as a pointer on its own; formal 2 and the result are open, one of
  // them pointer only because an applied guess made it so. The float function lines up with
  // nothing and the aggregate is not scored.
  const guesses = [typeGuess('mixed', 'parameter_type', 2)];
  assert.deepEqual(typePopulation(observations, typed, guesses), {
    proven_params: 1,
    open_params: 1,
    proven_results: 0,
    open_results: 1,
  });
});
