#include <stdint.h>
#include <stdio.h>

#define NOINLINE __attribute__((noinline))
struct context_record { uint64_t left; uint64_t right; };
struct observed_words { uint64_t first; uint64_t second; };
typedef uint64_t (*context_callback)(uint64_t);

NOINLINE uint64_t context_increment(uint64_t value) { return value + 7; }
NOINLINE uint64_t context_double(uint64_t value) { return value * 2; }
NOINLINE uint64_t context_choose(uint64_t mode, const struct context_record *record, context_callback callback) {
  return callback(mode == 0 ? record->left : record->right);
}
NOINLINE uint64_t context_two(const struct context_record *record) {
  uint64_t first = context_choose(0, record, context_increment);
  return first + context_choose(1, record, context_double);
}
NOINLINE uint64_t context_recursive(uint64_t count, uint64_t value) {
  if (count == 0) return value + 3;
  return context_recursive(count - 1, value + 5) + 1;
}
NOINLINE uint64_t context_recursive_caller(uint64_t value) { return context_recursive(9, value); }
NOINLINE uint64_t context_alias(const struct context_record *a, const struct context_record *b) {
  return a->left + b->right;
}
NOINLINE uint64_t context_same(const struct context_record *record) { return context_alias(record, record); }
NOINLINE uint64_t context_conflict(const uint64_t *a, const unsigned char *b) { return *a + *b; }
NOINLINE uint64_t context_conflict_caller(const struct context_record *record) {
  return context_conflict(&record->left, (const unsigned char *)&record->left);
}
NOINLINE struct observed_words context_words(uint64_t value) {
  struct observed_words result = { value + 11, value ^ UINT64_C(0xfedcba9876543210) };
  return result;
}
NOINLINE uint64_t context_words_caller(uint64_t value) {
  struct observed_words result = context_words(value);
  return result.first + result.second;
}
int main(void) {
#ifdef CONTEXT_TRUSTED_ORACLE
  const uint64_t values[] = { 0, 1, 0x7fffffff, 0x80000000, UINT64_C(0xffffffffffffffff), UINT64_C(0x1234567887654321) };
  for (unsigned index = 0; index < sizeof(values) / sizeof(values[0]); index++) {
    struct context_record record = { values[index], values[index] + 17 };
    printf("two %u %016llx\n", index, (unsigned long long)context_two(&record));
    printf("recursive %u %016llx\n", index, (unsigned long long)context_recursive_caller(values[index]));
    printf("same %u %016llx\n", index, (unsigned long long)context_same(&record));
    printf("conflict %u %016llx\n", index, (unsigned long long)context_conflict_caller(&record));
    printf("words %u %016llx\n", index, (unsigned long long)context_words_caller(values[index]));
    struct observed_words words = context_words(values[index]);
    printf("word_first %u %016llx\n", index, (unsigned long long)words.first);
    printf("word_second %u %016llx\n", index, (unsigned long long)words.second);
    printf("scalar %u %016llx\n", index, (unsigned long long)context_increment(values[index]));
  }
#endif
  return 0;
}
