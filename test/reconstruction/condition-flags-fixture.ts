/** Trusted condition-code oracle source. Inline assembly pins every ARM64 and
 * x86-64 condition code and flag producer; plain C exercises compiler-chosen
 * conditional-compare chains, cset/csel, setcc/cmov and FP compares. The host
 * (darwin-arm64) runs the ARM64 functions themselves; each x86-64 function has
 * a C reference computing EFLAGS as the Intel SDM defines them. */

export type Target = 'arm64' | 'x86_64';
export interface ConditionFunction {
  readonly name: string;
  readonly targets: readonly Target[];
  /** Compared operands: two 64-bit integers or two IEEE doubles. */
  readonly float: boolean;
  /** Two extra select arms (`x`, `y`), doubles only for FCSEL. */
  readonly arms: 'none' | 'integer' | 'float';
  /** The condition reads V/OF or PF alone, which keeps its exact flag helper. */
  readonly helper: boolean;
  readonly body: string;
  /** Host-evaluated C equivalent, for x86-64 assembly that cannot run here. */
  readonly reference?: string;
}

const u64 = (value: bigint): bigint => BigInt.asUintN(64, value);
export const integerInputs: readonly bigint[] = [
  0n,
  1n,
  u64(-1n),
  0x7fffffffn,
  0x80000000n,
  0x7fffffffffffffffn,
  0x8000000000000000n,
];
const view = new DataView(new ArrayBuffer(8));
export const floatInputs: readonly bigint[] = [
  0,
  -0,
  1,
  -2.5,
  Infinity,
  -Infinity,
  NaN,
  5e-324,
].map((value) => {
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
});

/** Argument bit patterns of case (i, j); the generated oracle uses the same rule. */
export function conditionArguments(item: ConditionFunction, i: number, j: number): bigint[] {
  const pool = item.float ? floatInputs : integerInputs;
  const arms = item.arms === 'float' ? floatInputs : integerInputs;
  const values = [pool[i]!, pool[j]!];
  if (item.arms !== 'none')
    values.push(arms[(i + j) % arms.length]!, arms[(i * 3 + j + 1) % arms.length]!);
  return values;
}

export const ARM_CODES = [
  'eq',
  'ne',
  'hs',
  'lo',
  'mi',
  'pl',
  'vs',
  'vc',
  'hi',
  'ls',
  'ge',
  'lt',
  'gt',
  'le',
];
export const X86_CODES = [
  'o',
  'no',
  'b',
  'ae',
  'e',
  'ne',
  'be',
  'a',
  's',
  'ns',
  'p',
  'np',
  'l',
  'ge',
  'le',
  'g',
];
/** x86 EFLAGS condition (Intel SDM Jcc table) over the reference flag model. */
const X86_CONDITION: Record<string, string> = {
  o: 'of',
  no: '!of',
  b: 'cf',
  ae: '!cf',
  e: 'zf',
  ne: '!zf',
  be: '(cf || zf)',
  a: '(!cf && !zf)',
  s: 'sf',
  ns: '!sf',
  p: 'pf',
  np: '!pf',
  l: '(sf != of)',
  ge: '(sf == of)',
  le: '(zf || sf != of)',
  g: '(!zf && sf == of)',
};
const branch = (test: string): string =>
  `${test} 1f\\n mov %0, #0x22\\n b 2f\\n1: mov %0, #0x11\\n2:`;
const x86Branch = (test: string): string =>
  `${test} 1f\\n movq $0x22, %0\\n jmp 2f\\n1: movq $0x11, %0\\n2:`;

export function conditionFunctions(): readonly ConditionFunction[] {
  const functions: ConditionFunction[] = [];
  for (const code of ARM_CODES) {
    const overflow = code === 'vs' || code === 'vc';
    const integer = (form: string, body: string, arms: 'none' | 'integer' = 'none'): void =>
      void functions.push({
        name: `cf_arm_${form}_${code}`,
        targets: ['arm64'],
        float: false,
        arms,
        // ANDS clears V. ADDS with a register addend has no relational V, so
        // every condition reading V keeps its helper there.
        helper:
          (overflow && form !== 'tst') ||
          (form === 'cmn' && ['ge', 'lt', 'gt', 'le'].includes(code)),
        body,
      });
    integer(
      'cset',
      `u64 r; __asm__("cmp %1, %2\\n cset %0, ${code}" : "=r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
    );
    integer(
      'cset32',
      `u64 r; __asm__("cmp %w1, %w2\\n cset %w0, ${code}" : "=r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
    );
    integer(
      'branch',
      `u64 r; __asm__("cmp %1, %2\\n ${branch(`b.${code}`)}" : "=r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
    );
    integer(
      'csel',
      `u64 r; __asm__("cmp %1, %2\\n csel %0, %3, %4, ${code}" : "=r"(r) : "r"(a), "r"(b), "r"(x), "r"(y) : "cc"); return r;`,
      'integer',
    );
    integer(
      'cmn',
      `u64 r; __asm__("cmn %1, %2\\n cset %0, ${code}" : "=r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
    );
    integer(
      'cmnimm',
      `u64 r; (void)b; __asm__("cmn %1, #7\\n cset %0, ${code}" : "=r"(r) : "r"(a) : "cc"); return r;`,
    );
    integer(
      'tst',
      `u64 r; __asm__("tst %1, %2\\n cset %0, ${code}" : "=r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
    );
    const float = (form: string, body: string, arms: 'none' | 'float' = 'none'): void =>
      void functions.push({
        name: `cf_arm_${form}_${code}`,
        targets: ['arm64'],
        float: true,
        arms,
        helper: false,
        body,
      });
    float(
      'fcmp',
      `u64 r; __asm__("fcmp %d1, %d2\\n cset %0, ${code}" : "=r"(r) : "w"(a), "w"(b) : "cc"); return r;`,
    );
    float(
      'fcmpz',
      `u64 r; (void)b; __asm__("fcmp %d1, #0.0\\n cset %0, ${code}" : "=r"(r) : "w"(a) : "cc"); return r;`,
    );
    float(
      'fbranch',
      `u64 r; __asm__("fcmp %d1, %d2\\n ${branch(`b.${code}`)}" : "=r"(r) : "w"(a), "w"(b) : "cc"); return r;`,
    );
    float(
      'fcsel',
      `double r; __asm__("fcmp %d1, %d2\\n fcsel %d0, %d3, %d4, ${code}" : "=w"(r) : "w"(a), "w"(b), "w"(x), "w"(y) : "cc"); return r;`,
      'float',
    );
  }
  // Each condition guards one CCMP and one CCMN chain; the default NZCV and
  // the final condition vary so that every code also ends a chain.
  ARM_CODES.forEach((code, index) => {
    const final = ARM_CODES[(index * 5 + 3) % ARM_CODES.length]!;
    for (const [compare, operand] of [
      ['ccmp', '%4'],
      ['ccmn', '#3'],
    ] as const)
      functions.push({
        name: `cf_arm_${compare}_${code}_${final}_${(index * 7) % 16}`,
        targets: ['arm64'],
        float: false,
        arms: 'integer',
        // A V-reading guard or final condition keeps its overflow helper.
        helper: ['vs', 'vc'].includes(code) || ['vs', 'vc'].includes(final),
        body: `u64 r; __asm__("cmp %1, %2\\n ${compare} %3, ${operand}, #${(index * 7) % 16}, ${code}\\n cset %0, ${final}" : "=r"(r) : "r"(a), "r"(b), "r"(x), "r"(y) : "cc"); return r;`,
      });
  });
  // A three-stage chain.
  functions.push({
    name: 'cf_arm_ccmp_chain3',
    targets: ['arm64'],
    float: false,
    arms: 'integer',
    helper: false,
    body: 'u64 r; __asm__("cmp %1, %2\\n ccmp %3, %4, #2, lt\\n ccmp %1, %4, #8, hi\\n cset %0, le" : "=r"(r) : "r"(a), "r"(b), "r"(x), "r"(y) : "cc"); return r;',
  });
  for (const code of X86_CODES) {
    const condition = X86_CONDITION[code]!;
    const lone = ['o', 'no', 'p', 'np'].includes(code);
    // `outcome` is what the reference returns for a true : false condition.
    const integer = (form: string, body: string, model: string, outcome = '1 : 0'): void =>
      void functions.push({
        name: `cf_x86_${form}_${code}`,
        targets: ['x86_64'],
        float: false,
        arms: outcome === 'x : y' ? 'integer' : 'none',
        // TEST clears OF; ADD with a register addend has no relational OF/SF mix.
        helper:
          (lone && !(form === 'test' && (code === 'o' || code === 'no'))) ||
          (form === 'add' && ['l', 'ge', 'le', 'g'].includes(code)),
        body,
        reference: `cf_x86_flags_${model}(a, b); return ${condition} ? ${outcome};`,
      });
    integer(
      'set',
      `u64 r = 0; __asm__("cmpq %2, %1\\n set${code} %b0" : "+r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
      'sub64',
    );
    integer(
      'set32',
      `u64 r = 0; __asm__("cmpl %k2, %k1\\n set${code} %b0" : "+r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
      'sub32',
    );
    integer(
      'jcc',
      `u64 r; __asm__("cmpq %2, %1\\n ${x86Branch(`j${code}`)}" : "=r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
      'sub64',
      '0x11 : 0x22',
    );
    integer(
      'cmov',
      `u64 r = y; __asm__("cmpq %2, %1\\n cmov${code}q %3, %0" : "+r"(r) : "r"(a), "r"(b), "r"(x) : "cc"); return r;`,
      'sub64',
      'x : y',
    );
    integer(
      'test',
      `u64 r = 0; __asm__("testq %2, %1\\n set${code} %b0" : "+r"(r) : "r"(a), "r"(b) : "cc"); return r;`,
      'and64',
    );
    integer(
      'add',
      `u64 r = 0, t = a; __asm__("addq %2, %1\\n set${code} %b0" : "+r"(r), "+r"(t) : "r"(b) : "cc"); return r;`,
      'add64',
    );
    for (const [form, body] of [
      [
        'ucomisd',
        `u64 r = 0; __asm__("ucomisd %2, %1\\n set${code} %b0" : "+r"(r) : "x"(a), "x"(b) : "cc"); return r;`,
      ],
      [
        'comisd',
        `u64 r = 0; __asm__("comisd %2, %1\\n set${code} %b0" : "+r"(r) : "x"(a), "x"(b) : "cc"); return r;`,
      ],
      [
        'fjcc',
        `u64 r; __asm__("ucomisd %2, %1\\n ${x86Branch(`j${code}`)}" : "=r"(r) : "x"(a), "x"(b) : "cc"); return r;`,
      ],
    ] as const)
      functions.push({
        name: `cf_x86_${form}_${code}`,
        targets: ['x86_64'],
        float: true,
        arms: 'none',
        helper: false,
        body,
        reference: `cf_x86_fflags(a, b); return ${condition} ? ${form === 'fjcc' ? '0x11 : 0x22' : '1 : 0'};`,
      });
  }
  for (const [name, float, body] of cFunctions)
    functions.push({
      name,
      targets: ['arm64', 'x86_64'],
      float,
      arms: 'integer',
      helper: false,
      body,
    });
  return functions;
}

/** Plain C: compilers choose CCMP chains, cset/csel, setcc/cmov/jcc, fcmp/ucomisd. */
const cFunctions: readonly (readonly [string, boolean, string])[] = [
  ['cf_c_and_signed', false, 'return ((s64)a < (s64)b && (s64)x > 7) ? x : y;'],
  ['cf_c_or_unsigned', false, 'return (a <= b || x == 42) ? 3 : y;'],
  ['cf_c_range', false, 'return ((s64)a > -5 && (s64)a < 100 && b != 3) ? x : y;'],
  ['cf_c_three', false, 'return (a == b && x != y && (s64)a >= (s64)x) ? 1 : 0;'],
  ['cf_c_mixed32', false, 'return ((s32)a < (s32)b || (u32)x > (u32)y) ? 9 : 4;'],
  ['cf_c_branch_chain', false, 'if ((s64)a < 0 || b > x) return y * 3 + a; return x ^ b;'],
  ['cf_c_minus', false, 'return (s64)a == -9 || (s64)b < -3 ? x : y;'],
  ['cf_c_flt', true, 'return a < b ? x : y;'],
  ['cf_c_fle', true, 'return a <= b ? x : y;'],
  ['cf_c_fgt', true, 'return a > b ? x : y;'],
  ['cf_c_fge', true, 'return a >= b ? x : 7;'],
  ['cf_c_feq', true, 'return a == b ? x : y;'],
  ['cf_c_fne', true, 'return a != b ? x : y;'],
  ['cf_c_fnlt', true, 'return !(a < b) ? x : y;'],
  ['cf_c_fnle', true, 'return !(a <= b) ? x : y;'],
  ['cf_c_fngt', true, 'return !(a > b) ? x : y;'],
  ['cf_c_fnge', true, 'return !(a >= b) ? x : y;'],
  ['cf_c_funordered', true, 'return __builtin_isunordered(a, b) ? x : y;'],
  ['cf_c_fisnan', true, 'return __builtin_isnan(a) ? x : y;'],
  ['cf_c_flessgreater', true, 'return __builtin_islessgreater(a, b) ? x : y;'],
  ['cf_c_fzero', true, 'if (a > 0.0) return x; return y + 1;'],
];

/** One translation unit for the host oracle and both analyzed targets. */
export function conditionSource(): string {
  const functions = conditionFunctions();
  const parameters = (item: ConditionFunction): string => {
    const scalar = item.float ? 'double' : 'u64',
      arm = item.arms === 'float' ? 'double' : 'u64';
    return `${scalar} a, ${scalar} b${item.arms === 'none' ? '' : `, ${arm} x, ${arm} y`}`;
  };
  const lines = [
    '#include <stdint.h>',
    'typedef uint64_t u64; typedef int64_t s64; typedef uint32_t u32; typedef int32_t s32;',
    '#define NOINLINE __attribute__((noinline, used))',
  ];
  for (const item of functions) {
    const result = item.arms === 'float' ? 'double' : 'u64';
    const guard =
      item.targets.length === 2 ? null : item.targets[0] === 'arm64' ? '__aarch64__' : '__x86_64__';
    if (guard) lines.push(`#if defined(${guard})`);
    lines.push(`NOINLINE ${result} ${item.name}(${parameters(item)}) { ${item.body} }`);
    if (guard) lines.push('#endif');
  }
  // Oracle only: x86 EFLAGS models (Intel SDM) and references, then the cases.
  lines.push(
    '#ifdef CF_ORACLE',
    '#include <stdio.h>',
    '#include <string.h>',
    'static int cf, zf, sf, of, pf;',
    'static int parity(u64 r) { return !(__builtin_popcount((unsigned)(r & 0xff)) & 1); }',
    'static void cf_x86_flags_sub64(u64 a, u64 b) { u64 r = a - b; cf = a < b; zf = r == 0; sf = (int)(r >> 63); of = (int)((((a ^ b) & (a ^ r)) >> 63) & 1); pf = parity(r); }',
    'static void cf_x86_flags_sub32(u64 a, u64 b) { u32 x = (u32)a, y = (u32)b, r = x - y; cf = x < y; zf = r == 0; sf = (int)(r >> 31); of = (int)((((x ^ y) & (x ^ r)) >> 31) & 1); pf = parity(r); }',
    'static void cf_x86_flags_and64(u64 a, u64 b) { u64 r = a & b; cf = 0; of = 0; zf = r == 0; sf = (int)(r >> 63); pf = parity(r); }',
    'static void cf_x86_flags_add64(u64 a, u64 b) { u64 r = a + b; cf = r < a; zf = r == 0; sf = (int)(r >> 63); of = (int)((((~(a ^ b)) & (a ^ r)) >> 63) & 1); pf = parity(r); }',
    // UCOMISD/COMISD: ZF,PF,CF = 111 unordered, 000 greater, 001 less, 100 equal.
    'static void cf_x86_fflags(double a, double b) { int u = __builtin_isunordered(a, b); zf = u || a == b; pf = u; cf = u || a < b; of = 0; sf = 0; }',
  );
  for (const item of functions)
    if (item.reference)
      lines.push(`static u64 reference_${item.name}(${parameters(item)}) { ${item.reference} }`);
  lines.push(
    `static const u64 ints[] = {${integerInputs.map((v) => `0x${v.toString(16)}ULL`).join(', ')}};`,
    `static const u64 floats[] = {${floatInputs.map((v) => `0x${v.toString(16)}ULL`).join(', ')}};`,
    'static double fp(u64 v) { double d; memcpy(&d, &v, 8); return d; }',
    'static u64 raw(double d) { u64 v; memcpy(&v, &d, 8); return v; }',
    'int main(void) {',
  );
  for (const item of functions) {
    const pool = item.float ? 'floats' : 'ints',
      count = item.float ? floatInputs.length : integerInputs.length;
    const arm = item.arms === 'float' ? 'floats' : 'ints',
      arms = item.arms === 'float' ? floatInputs.length : integerInputs.length;
    const operand = (index: string, values: string): string =>
      values === 'floats' ? `fp(floats[${index}])` : `ints[${index}]`;
    const args = [operand('i', pool), operand('j', pool)];
    if (item.arms !== 'none')
      args.push(operand(`(i + j) % ${arms}`, arm), operand(`(i * 3 + j + 1) % ${arms}`, arm));
    const call = `${item.targets.includes('arm64') ? item.name : `reference_${item.name}`}(${args.join(', ')})`;
    lines.push(
      `  for (unsigned i = 0; i < ${count}; i++) for (unsigned j = 0; j < ${count}; j++) printf("${item.name} %u %u %016llx\\n", i, j, (unsigned long long)${item.arms === 'float' ? `raw(${call})` : call});`,
    );
  }
  lines.push('  return 0;', '}', '#endif');
  return `${lines.join('\n')}\n`;
}
