# ARM64 decoder adapter

`Arm64Decoder` implements the core `Decoder` contract with the pinned a64js runtime in `vendor/a64js`. Requests select A64 mode, bounded image regions and explicit atomic architectural feature names. The adapter does not infer target features from the host or inject PAuth features by default.

Instructions and flow addresses use static VAs; ordinary byte references use original-container file offsets, including selected-slice offsets. A word spanning adjacent VA mappings with noncontiguous backing instead retains a VA byte range, resolvable through `AddressMap.spans`; it never claims nonexistent contiguous file bytes. File/RVA requests are translated through the image mapping contract. Overlapping requested regions are combined. Known data, holes/zero-fill, misaligned/incomplete instruction fragments and instruction-budget remainder are explicit gaps. Cancellation/work/deadline failures propagate from the operation context.

The payload retains canonical and selected encoding identities, alias relationships, raw word, every extracted field, availability and the upstream execution-behavior distinction. In particular, feature-disabled HINT-space instructions that architecturally act as NOP retain their identity and fall through; unavailable non-HINT instructions are not treated as established traps. `UDF`, `BRK` and `HLT` are explicit traps. Authenticated calls/branches remain unresolved indirect transfers and authenticated returns terminate; authentication-modifier labels are not CFG edges. Calls do not carry invented signatures or argument counts.

Common integer modifiers, memory operands, scalar FP and the compiler corpus's vector operations are structured from decoded fields. Upstream structured scalable registers/groups/addresses and ZA operands are retained. Specialized text operands are explicitly `opaque`, retain canonical fields, and produce a limitation diagnostic. They are presentation data, **never semantic input**. Upstream does not supply general register-effect metadata, so operand accesses are `unknown` unless a load/store family establishes the access; the register-effect list is not presented as complete. Unknown memory widths use zero, not an invented machine width.

The original adapter's logical shifted-register completion is preserved separately from the pinned tables, and is used only for genuinely unrecognized words without a selected upstream encoding. All eight operations, four shift types, W/X widths and W shift-limit failures have boundary coverage. Broad recognition and successful formatting are not claims about semantic lifting or exhaustive ISA conformance. Upstream combines some reserved-bit failures and undefined encodings under `undefined`; this adapter preserves that evidence rather than guessing a finer classification.

Formatting is optional, does not run during decode and can reconstruct presentation from a serialized payload. Each returned payload owns its objects; vendor table/operand objects are not exposed and no image bytes are copied per instruction. The adapter has no WASM/native allocations. `dispose()` is idempotent and prohibits subsequent use.

## Conformance evidence and integration commands

The behavioral tests consume the actual extracted ARM64 fixture ranges. Selected arithmetic, loop, call, stack, scalar FP, vector and ADRP expectations were adjudicated against the existing LLVM 23.1.3 evidence in `fixtures/metadata/macho-arm64-symbols.disassembly.txt`; LLVM output is not parsed into instructions or semantics. LLVM renders `add/fadd/eor` vector arrangements as mnemonic suffixes and immediate MOV aliases differently from a64js; comparisons assert encoding fields, widths, arrangements and targets instead of incidental spelling. PAuth/PAuth_LR regression words additionally come from the previous adapter's `test/decompiler-core/pauth.test.js`; these are decoder/discovery-flow regressions, not adoption of the old lifter's authentication abstraction.

Run from the repository root after integration (not executed by this implementation slice):

```sh
node --import tsx --test test/decoders/arm64/decoder.test.ts
node --import tsx test/decoders/arm64/smoke.ts
# After the coordinator's production build:
node dist/test/decoders/arm64/smoke.js
```

The compiled smoke loads the real Mach-O image and exercises the adapter's missing-EOR completion through actual loader/address-map output. No sibling checkout, external decoder, Arm XML or target execution is needed.
