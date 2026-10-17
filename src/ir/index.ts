/**
 * Typed semantic IR.
 *
 * Lifter-facing API:
 *   const build = new IRBuilder(sliceId, functionId, instructionProvenance(first));
 *   const block = build.block(['entry', first.address.value]);
 *   block.source(instructionProvenance(instruction));
 *   const a = block.readRegister(decodedRegister);
 *   block.writeRegister(decodedRegister, block.int('add', a, block.constant(a.type, 1n)));
 *   block.return([a]);
 *   const ir: RegisterIR = build.finish(block, [a.type]);
 *
 * Use core RegisterDescriptor for all architectural slices. Integer machine bits
 * are signless: signedness belongs to operations. Shift counts are NOT masked;
 * lifters emit ISA masks explicitly. Division by zero/signed overflow produces
 * undefined values, not traps: lifters select ARM results or explicit x86 trap
 * paths. Add carry input is carry-in; sub carry input is borrow-in. Sub `carry`
 * means no-borrow; `borrow` means borrow. Omitted flag writes preserve flags;
 * indeterminate('undefined'|'unknown') followed by a register write distinguishes
 * undefined from unknown flags. Full-register/zero-extension writes follow the
 * core descriptor; narrower preserving writes retain the other root bits.
 * concat assembles integer slices low-bits-first; any undefined slice dominates
 * unknown slices, preserving architectural read semantics after SSA partitioning.
 *
 * FP32/64 operations use IEEE nearest-even with gradual underflow, no fused
 * operations and no floating-environment exception state. Arithmetic NaNs are
 * canonical quiet NaNs; bitcasts, loads/stores, abs/neg preserve payload bits.
 * FP-to-integer conversion truncates toward zero; out-of-range/NaN is undefined.
 * Other rounding modes, trapping FP environments, FP16/80/128 and scalable or
 * wider-than-2048-bit vector semantics must use explicit unknown boundaries.
 * Vectors have fixed typed lanes; lane zero occupies the least-significant bits.
 * Memory endian is explicit, alignment is required (1 permits unaligned access).
 *
 * Every state access (including register/memory reads) consumes/produces the
 * linear effect token. Edge arguments carry values simultaneously, including at
 * loop backedges; each block has its own effect parameter. Data references are
 * block-local: cross-block values MUST pass through typed block parameters.
 * This region-SSA convention makes joins/unreachable blocks unambiguous without
 * a dominance solver. SSA construction eliminates architectural register nodes
 * while retaining the effect chain and explicit disjoint register-slice state.
 * Each block's register_states entry binds physical inputs to parameters; exit
 * bindings remain observable roots even with no reconstructed formal returns.
 * Calls/unknown effects expose register_inputs/register_outputs independently
 * of source arguments/results. Loads/stores snapshot register_inputs so a fault
 * preserves earlier physical writes. Bindings use preserve_other_bits; partial
 * unknown clobbers must not erase unaffected slices. Unknown effects remain
 * mandatory boundaries, never no-ops or traps.
 *
 * Identity uses core entityIdentity(slice, kind, birth); block births are stable
 * caller-owned keys. Builder node IDs are stable for deterministic emission.
 * Rewrites retain surviving IDs and use withOrigins/mergeProvenance to union
 * instruction/range/evidence origins. verifyIR/assertValidIR are public pass
 * boundaries. evaluateIR is a bounded offline trusted-fixture oracle, not a
 * service path for execution of user binaries. It never loads or invokes native
 * code; explicit test-owned call oracles are keyed by exact call node ID. Their
 * readRegister/register_writes bridge physical callee state without inventing
 * signatures; writes are limited to declared clobbers and applied afterward.
 */
export * from './model.js';
export * from './provenance.js';
export * from './builder.js';
export * from './verify.js';
export * from './semantics.js';
export * from './interpreter.js';
