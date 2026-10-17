/* SQLite sqlite3_strnicmp excerpt: SQLite 3.54.0 sqlite3.c:37261-37271,
 * public domain (https://sqlite.org/copyright.html). ASCII configuration.
 * Other harness functions are MIT, like fixtures/source/corpus.c.
 * This file is compiled only in an isolated test directory; no baseline target
 * is executed. Instrumentation records native call order and pointed-to memory.
 */
#include "corpus.h"

static const unsigned char UpperToLower[256] = {
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
  32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,
  48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,
  64,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,
  112,113,114,115,116,117,118,119,120,121,122,91,92,93,94,95,
  96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,
  112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,
  128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,
  144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,
  160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,
  176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,
  192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,
  208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,
  224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,
  240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255
};

API NOINLINE int quality_strnicmp(const char *zLeft, const char *zRight, int N) {
  const unsigned char *a = (const unsigned char *)zLeft;
  const unsigned char *b = (const unsigned char *)zRight;
  if (zLeft == 0) return zRight ? -1 : 0;
  if (zRight == 0) return 1;
  while (N-- > 0 && *a && UpperToLower[*a] == UpperToLower[*b]) { a++; b++; }
  return N < 0 ? 0 : UpperToLower[*a] - UpperToLower[*b];
}

u64 quality_call_args[4], quality_call_results[4], quality_call_memory[4];
u32 quality_call_count;
u64 *quality_observed_pointer;

API NOINLINE u64 quality_record(u64 value) {
  const u32 slot = quality_call_count++;
  quality_call_args[slot] = value;
  quality_call_memory[slot] = *quality_observed_pointer;
  const u64 result = value * 3 + 1;
  quality_call_results[slot] = result;
  return result;
}

API NOINLINE u64 quality_effects(u64 *pointer, u64 branch) {
  const u64 value = *pointer;
  *pointer = value + 1;
  const u64 first = quality_record(value);
  if (branch == 0) return first;
  *pointer = first;
  const u64 second = quality_record(branch);
  *pointer = second;
  return first + second;
}
