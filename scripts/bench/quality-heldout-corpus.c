/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Open Decomp contributors.
 * HELD-OUT: do not use this file or its resulting outputs to tune reconstruction.
 * Analyze only. This suite is separate from the broader quality-matrix workload.
 * Valid inputs: all arrays cover the stated counts/capacities; distinct output
 * arrays unless aliasing is explicitly allowed; unsigned arithmetic is modular.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
#define KEEP __attribute__((noinline,used))
#if defined(_WIN32)
int _fltused = 0;
#endif

/* Packed state: high word consumed count, low word rolling checksum. */
KEEP u64 heldout_roll(const u8 *data, u32 count, u32 seed, u8 terminator) {
    u32 hash = seed;
    u32 consumed = 0;
    while (consumed < count) {
        u8 value = data[consumed];
        if (value == terminator) break;
        hash = ((hash << 5) | (hash >> 27)) ^ value;
        ++consumed;
    }
    return ((u64)consumed << 32) | hash;
}

/* Adjacent equal bytes are encoded as (run length, value), at most 255/run. */
KEEP u32 heldout_runs(const u8 *input, u32 count, u8 *output, u32 capacity) {
    u32 position = 0;
    u32 used = 0;
    while (position < count) {
        u8 value = input[position];
        u32 run = 1;
        while (run < 255 && run < count - position && input[position + run] == value) ++run;
        if (capacity - used < 2) return 0xffffffffu;
        output[used++] = (u8)run;
        output[used++] = value;
        position += run;
    }
    return used;
}

/* Stable merge: left wins ties. Caller supplies capacity left_count+right_count. */
KEEP void heldout_merge(u32 *output, const u32 *left, u32 left_count,
                       const u32 *right, u32 right_count) {
    u32 l = 0;
    u32 r = 0;
    u32 written = 0;
    while (l < left_count && r < right_count) {
        if (left[l] <= right[r]) output[written++] = left[l++];
        else output[written++] = right[r++];
    }
    while (l < left_count) output[written++] = left[l++];
    while (r < right_count) output[written++] = right[r++];
}

KEEP u32 heldout_saturate(u16 *values, u32 count, u16 delta) {
    u32 changed = 0;
    for (u32 i = 0; i < count; ++i) {
        u32 sum = (u32)values[i] + delta;
        u16 next = sum > 65535u ? 65535u : (u16)sum;
        changed += next != values[i];
        values[i] = next;
    }
    return changed;
}

/* Weights/values are ordinary finite doubles; default supported FP environment. */
KEEP double heldout_weighted(const double *values, const double *weights, u32 count) {
    double total = 0;
    double weight = 0;
    for (u32 i = 0; i < count; ++i) {
        if (weights[i] <= 0) continue;
        total += values[i] * weights[i];
        weight += weights[i];
    }
    return weight == 0 ? 0 : total / weight;
}

/* Analysis root only; not a platform process-startup implementation. */
KEEP u64 heldout_entry(void) { return 0; }
