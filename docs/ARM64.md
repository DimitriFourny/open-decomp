# ARM64 decoder adapter

`Arm64Decoder` implements the core `Decoder` contract with the pinned a64js runtime in `vendor/a64js`. Requests select A64 mode, bounded image regions and explicit atomic architectural feature names. The adapter does not infer target features from the host or inject PAuth features by default.

Instructions and flow addresses use static VAs; ordinary byte references use original-container file offsets, including selected-slice offsets. A word spanning adjacent VA mappings with noncontiguous backing instead retains a VA byte range, resolvable through `AddressMap.spans`; it never claims nonexistent contiguous file bytes. File/RVA requests are translated through the image mapping contract. Overlapping requested regions are combined. Known data, holes/zero-fill, misaligned/incomplete instruction fragments and instruction-budget remainder are explicit gaps. Cancellation/work/deadline failures propagate from the operation context.

The payload retains canonical and selected encoding identities, alias relationships, raw word, every extracted field, availability and the upstream execution-behavior distinction. In particular, feature-disabled HINT-space instructions that architecturally act as NOP retain their identity and fall through; unavailable non-HINT instructions are not treated as established traps. `UDF`, `BRK` and `HLT` are explicit traps. Authenticated calls/branches remain unresolved indirect transfers and authenticated returns terminate; authentication-modifier labels are not CFG edges. Calls do not carry invented signatures or argument counts.

Common integer modifiers, memory operands, scalar FP and the compiler corpus's vector operations are structured from decoded fields. Upstream structured scalable registers/groups/addresses and ZA operands are retained. Specialized text operands are explicitly `opaque`, retain canonical fields, and produce a limitation diagnostic. They are presentation data, **never semantic input**. Upstream does not supply general register-effect metadata, so operand accesses are `unknown` unless a load/store family establishes the access; the register-effect list is not presented as complete. Unknown memory widths use zero, not an invented machine width.

The original adapter's logical shifted-register completion is preserved separately from the pinned tables, and is used only for genuinely unrecognized words without a selected upstream encoding. All eight operations, four shift types, W/X widths and W shift-limit failures have boundary coverage. Broad recognition and successful formatting are not claims about semantic lifting or exhaustive ISA conformance. Upstream combines some reserved-bit failures and undefined encodings under `undefined`; this adapter preserves that evidence rather than guessing a finer classification.

Formatting is optional, does not run during decode and can reconstruct presentation from a serialized payload. Each returned payload owns its objects; vendor table/operand objects are not exposed and no image bytes are copied per instruction. The adapter has no WASM/native allocations. `dispose()` is idempotent and prohibits subsequent use.

Data-hint normalization is cached per decoder and immutable `LoadedImage` object, not per content ID: two metadata snapshots of identical bytes can have different data boundaries. Only fully checked preparation enters the weak cache; failed preparation can be retried, and disposal releases it. Every request still applies its own regions, cancellation and work/instruction limits. This removes the measured full-hint scan on every single-instruction discovery request without treating data as code.

## Observed initialization ordering

The SQLite 3.54.0 `sqlite3_initialize` fast path contains `DMB ISH`
(`0xd5033bbf`, at `0x100039288` in the retained ARM64 comparison input).
The source calls `sqlite3MemoryBarrier()` before returning `SQLITE_OK`
(`sqlite3.c:188657-188660`); that helper uses `__sync_synchronize()`
(`sqlite3.c:31056-31060`). This encoding is lifted to an ordered
`memory_fence` IR node, not an unknown instruction, register clobber, memory
write, or no-op.

The node orders prior explicit reads and writes before subsequent explicit
reads and writes within the inner-shareable domain. Its `acquire_release`
label does **not** claim the global total order of a C sequentially-consistent
atomic fence or the completion guarantees of `DSB`. The effect token, source
statement, helper contract and provenance retain this event in both output
dialects. The fixture interpreter records it in its ordered effect trace;
the interpreter is single-threaded and does not simulate concurrent weak-memory
executions. Other barrier encodings/domains remain unsupported.

Discovery-established ARM64 tail-call exits retain a typed tail-call marker.
Presentation keeps the actual target and changed physical input bits while
explicitly marking unknown source arguments, calling convention and results.
A discovered code target alone is not a recovered prototype, and an empty
changed-state overlay is not a zero-argument call.

## SIMD register-move aliases

The lifter models `ORR_asimdsame_only` from its canonical `Rd`, `Rn`, `Rm` and `Q` fields, including the compiler's `MOV` alias (`Rn == Rm`) when the decoder exposes only opaque display operands. It preserves the entire selected bit pattern without interpreting FP payloads or lane text. The 64-bit form clears the high half of the 128-bit root; the 128-bit form replaces the whole root. This is the specific register-move family exercised by mixed integer/FP call preservation, not general support for opaque SIMD operands or lane-indexed moves.

Scalar SIMD `SCVTF_asisdmisc_R` / `UCVTF_asisdmisc_R` support same-width 32/64-bit integer-to-FP conversion from canonical register fields. The destination replaces its scalar and clears the rest of Vd, preserving NZCV. Existing FPCR guards and unknown exception-status effects remain. Packed and FP16 variants are not implied; the measured-family source/rounding evidence is recorded in `PERFORMANCE.md`.

## Float-to-integer, fixed-point and canonical-field vector operations

These encodings expose some operands as opaque display text in the pinned decoder; the lifter reads their canonical fields (`sf`, `ftype`, `scale`, `Q`, `size`, `imm5`, `Rd`, `Rn`, `Rm`) and never the text.

- `FCVTZS` / `FCVTZU` (`*_float2int`, W/X destination from S/D source): round toward zero regardless of `FPCR.RMode`, NaN becomes 0, out-of-range values saturate (INT/UINT minimum and maximum). The IR's `float_to_signed` / `float_to_unsigned` casts are undefined out of range, so the lift selects the saturated constant first and applies the cast only on the in-range arm. FP16 is not modeled. The conversion joins the existing FPCR guard (`FCVTZS|FCVTZU` in `needsFpGuard`) and writes `FPSR` as unknown.
- `SCVTF` / `UCVTF` fixed-point (`*_float2fix`, `fbits = 64 - scale`, 1..32 for W sources): the integer converts once (round-to-nearest-even under the FPCR guard) and is multiplied by the exact power of two `2^-fbits`; no FP32/FP64 result of a 32/64-bit input is subnormal, so this equals one rounding of the real quotient (the tests include a case where rounding through binary64 first would be wrong).
- `DUP` (general register, `DUP_asimdins_DR_r`): broadcasts the low 8/16/32/64 bits of Wn/Xn (element size from the lowest set bit of `imm5`) over 64 or 128 bits; `Q=0` with a 64-bit element and `imm5` without a set bit in 0..3 are reserved and stay unknown effects.
- `CMEQ` register (`CMEQ_asimdsame_only`): per-lane all-ones/zero equality mask for 8/16/32/64-bit lanes (`Q=0` with 64-bit lanes is reserved).
- `AND` register (`AND_asimdsame_only`) joins `ORR_asimdsame_only` in the canonical-field logical handler (64-bit forms clear the high half).

- `INS` (general register, `INS_asimdins_IR_r`): inserts the low 8/16/32/64 bits of Wn/Xn into the lane of Vd that `imm5` selects (element size from its lowest set bit, index from the bits above) and keeps every other bit of the 128-bit root; `imm5` without a set bit in 0..3 is reserved and stays an unknown effect.

- `ST1` / `LD1` single structure, one lane (`ST1_asisdlso_*`, `ST1_asisdlsop_*`, `LD1_…`): the decoder shows these operands as opaque text, so the lifter reads `Q`, `S`, `size`, `opcode` (8-bit lane `Q:S:size`, 16-bit `Q:S:size<1>`, 32-bit `Q:S`, 64-bit `Q`), `Rn` (31 is SP), `Rt` and, for the post-indexed form, `Rm` (31: add the element size in bytes, else add `X[Rm]`). `ST1` stores `extract(V[Rt], lane*esize, esize)` little-endian; `LD1` inserts the loaded element into `V[Rt]` and keeps every other bit. The writeback adds to the base after the access. The multi-register forms (`asisdlse`, `asisdlsep`), `LD1R` and `ST2`–`ST4` / `LD2`–`LD4` stay unknown effects with all memory clobbered; they are not bounded (`asisdls` is excluded from `boundedUnknownClobbers`).

Other encodings of the same mnemonic families (e.g. `FCVTZS` fixed-point, `FCVT{N,M,P,A}*`, FP16, lane-indexed `DUP`) remain unknown effects.

## Bounded effects of unlifted SIMD&FP data processing

An unlifted encoding normally becomes an `unknown_effect` that clobbers every modeled register, SP, FPCR and all memory. A valid instruction that falls through and whose canonical encoding has an `_`-separated class segment starting with `asimd`, `asisd`, `float` or `crypto` (but not `asisdls`, the SIMD loads and stores) gets the ISA bound instead (`boundedUnknownClobbers`): registers V0–V31, plus GP `Rd` for the to-general forms (`UMOV`/`SMOV`, and `*_float2int`/`*_float2fix` with opcode not 010, 011 or 111) when `Rd` is not 31; flags NZCV and FPSR; memory `none`; never SP, x19–x28 or FPCR. The A64 "Data Processing – Scalar Floating-Point and Advanced SIMD" and cryptographic groups access no memory, never name SP (register 31 is ZR) and read FPCR without writing it. Forms that read a general register (`INS`/`DUP` from general, `SCVTF`/`UCVTF` and `FMOV` from general) keep the unbounded effect: the IR records no dependence from an effect's inputs to its outputs, so a frame address read from Rn could not be followed. Instructions the decoder marks undefined (e.g. `AESE` without FEAT_AES) also keep it. The diagnostic and coverage reason are unchanged. Because FPCR is not an output, FP-guard presentation survives these effects, and a memory-free effect is no frame escape (only a frame address in one of its vector inputs is exposed), so frame saves are elided across it. Measured on SQLite (A1): `isDate` (`FMADD_D_floatdp3`, `FCVTZS_asisdmisc_R`, `FCCMP_D_floatccmp`) and `sqlite3VdbeDisplayComment` (`INS_asimdins_IV_v`) print no save lines; `unicodeNext` keeps its exposed frame because of its `ST1_asisdlsop_S1_i1s` store.

## Conformance evidence and integration commands

The behavioral tests consume the actual extracted ARM64 fixture ranges. Selected arithmetic, loop, call, stack, scalar FP, vector and ADRP expectations were adjudicated against the existing LLVM 23.1.3 evidence in `fixtures/metadata/macho-arm64-symbols.disassembly.txt`; LLVM output is not parsed into instructions or semantics. LLVM renders `add/fadd/eor` vector arrangements as mnemonic suffixes and immediate MOV aliases differently from a64js; comparisons assert encoding fields, widths, arrangements and targets instead of incidental spelling. PAuth/PAuth_LR regression words additionally come from the previous adapter's `test/decompiler-core/pauth.test.js`; these are decoder/discovery-flow regressions, not adoption of the old lifter's authentication abstraction.

Run from the repository root after integration (not executed by this implementation slice):

```sh
node --import tsx --test test/decoders/arm64/decoder.test.ts
node --import tsx test/decoders/arm64/smoke.ts
```

The smoke script is source-only (`tsconfig.build.json` compiles `src`, `vendor` and the release/smoke/benchmark drivers that run from `dist`, not `test/`). It loads the real Mach-O image and exercises the adapter's missing-EOR completion through actual loader/address-map output. No sibling checkout, external decoder, Arm XML or target execution is needed.
