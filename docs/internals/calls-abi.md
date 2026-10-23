# ABIs, calls and callee summaries

Turns a function's SSA plus an `AbiProfile` into per-call interface facts: which registers and stack slots carry arguments and results, and whether that is proven by a supplied contract, observed at the call site, or summarized from the callee's own body. Physical call analysis runs inside type recovery; callee summaries run after structuring, before reconstruction. Output is _evidence_, not a prototype: whatever is unproven stays an explicit open argument list (`...`).

**Code:** `src/abi/`, `src/analysis/calls/`, `src/service/analysis/` (`calls.ts`, `native-*.ts`, `source-facts.ts`, `likely-arity.ts`, `objc-*.ts`, `source-variadic.ts`, `source-literal-candidates.ts`)

## Data model

- **`AbiProfile`** (darwin-arm64, sysv-amd64, windows-x64; stateless, never consults names or host): data layout, stack pointer, preserved registers, link register / pushed-return-address size, red-zone capability, clobbers of an unknown call (never the FP control state: FPCR, MXCSR[6:16] and the x87 control word survive calls), `environment_writer_clobbers` (that control state), one pure `classifyCall`. The service adds the writer clobbers to calls of fenv/MSVC/BSD environment-writer imports before SSA (`applyEnvironmentWriters` in `service/analysis/calls.ts`).
- **`AbiSignature` → `AbiCallLayout`**: per-parameter _locations_ — register (offset into the _source value_, so HFA members and split 128-bit values fit), stack (offset from callee-entry SP), indirect (pointer + pointee size) — plus hidden-result slot, return locations, stack bytes (lower bound if partial), implicit register inputs (SysV `AL`), and `complete | partial | unsupported`. `argument_count` is `null` for a known prefix.
- **Supplied contract / resolution**: signature + `noreturn` + evidence, keyed by `{address}` or `{import identity}` (never a pointer slot); a resolution says which target a call has (`established | candidate`).
- **`CallFact`** (per call node): targets, status (`unresolved | candidate | established | conflicting`), each matching contract's layout _observed_ in the caller's stack snapshot, noreturn.
- **`NativeInterface` / `NativeSummary`** (callee summary): observed parameter registers/types, stack parameters, written result registers, `parameter_state` (`observed | ambiguous`), closure marker, variadic-stack flag, `fp_environment_writer` (positive evidence of a changed exit FP control state: writer-import call or tail, explicit write reaching an exit binding, writer callee; opaque effects are not evidence; the body's local evidence is built once per prepared SSA and charged once per operation, and the definitions are traced only when an exit's control-state binding differs from the entry value); summary adds `reasons`, `complete`, `arity_complete`.
- **`SourceEvidence.callees` / `source_callees`**: one `InferredCallee` per call that [reconstruction](reconstruction.md) prints.

```mermaid
flowchart LR
  SSA["SSA + stack snapshots"] --> AC["analyzeCalls (in type recovery)"]
  CON["contracts: library, DWARF, annotations"] --> AC
  AC --> CF["CallFact[]"]
  CF --> OBS["caller prefix + result demand"]
  CF --> WL["native worklist: callee summaries"]
  OBS --> MERGE["merge per call"]
  WL --> MERGE
  MERGE --> SE["SourceEvidence callees"]
  VAR["variadic rules, ObjC selectors, library tails"] --> SE
```

## Algorithm

### 1. ABI classification

|            | SysV AMD64                                                                       | Win64                                     | Darwin ARM64                                                                                 |
| ---------- | -------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Arg regs   | rdi rsi rdx rcx r8 r9 / xmm0–7, independent banks                                | 4 positional slots rcx rdx r8 r9 / xmm0–3 | x0–x7 / v0–v7                                                                                |
| Aggregates | eightbyte classes (INTEGER/SSE/SSEUP/X87/MEMORY merge); misaligned leaf ⇒ MEMORY | size 1/2/4/8 → integer, else by pointer   | ≤4 homogeneous float/vector members → consecutive v regs; >16 B → pointer; else integer regs |
| Overflow   | whole argument to stack; first at SP+8                                           | 32 B home space; slot 4 at SP+40          | whole argument to stack (no split, no even-register rounding); first at SP+0                 |
| Result     | rax/rdx, xmm0/1; MEMORY → hidden ptr rdi, returned rax                           | rax / xmm0; indirect → rcx                | x0/x1 or v0–v3; indirect → x8                                                                |
| Variadic   | promote; `AL` = vector-register bound                                            | float also copied to int slot             | every anonymous actual on stack, 8-byte slots                                                |

An unclassifiable parameter on SysV/Darwin stops allocation (later parameters get no location, `stack_bytes` is a lower bound, state `partial`) — never "the rest is on the stack". Win64 allocates by slot position, so only that slot empties. Refused, not guessed: x87 values, AVX-wide aggregates, vectorcall/member functions/non-trivial C++, `_Float16` in variadic tails, other Win64 vector widths, Darwin unprototyped calls.

### 2. Call analysis (`analyzeCalls`)

1. Recover stack first (snapshot at each call and exit); work is shared.
2. Targets per call: direct address; indirect only if the target value is a _proven_ address; plus supplied resolutions. Duplicates are kept so contradictions stay visible.
3. Trust only contracts whose own target is established. Two distinct established targets, or trusted contracts disagreeing on return/parameters/variadic/convention/noreturn ⇒ `conflicting`.
4. `classifyCall` per matching contract, then _observe_ each location in the caller's snapshot (register cells, SP-relative stack reads, pointee reads ≤64 KiB); returns from the call's output snapshot; implicit inputs become satisfied/violated/unknown.
5. `noreturn` only from unopposed contracts; CFG and effects are never edited.

Contracts come from [types-metadata](types-metadata.md#algorithm): library prototypes (import identity _and_ callable stub address), DWARF (direct-call address equals debug function), annotations, ObjC encodings. Names never establish a signature.

### 3. Caller-side prefix and result demand

For calls without an established contract, scan ABI argument slots in order. A slot counts if its whole carrier is covered and some cell was _prepared_ (loaded, computed, constant, or a different incoming value forwarded; untouched entry state, clobbers and the call-target alias do not count). First gap ends the prefix; the tail stays open. Result registers are those whose bits are semantically consumed (backward slice from effects, branches, stores, arguments, returns; bit ranges tracked through extract/truncate/concat), restricted to the primary return register.

The same scan runs over the exit register state of each unresolved indirect exit (`observePreparedTailInterfaces`, the branch target taking the call target's place). Those prefixes are published only as source-view `source_callees`, never as native call interfaces or summaries; reconstruction uses one only when it proves the exit a tail call ([reconstruction](reconstruction.md)).

Demand roots carry a tag (`CallResultDemands` in `result-demands.ts`): a root taken from a return-exit snapshot (primary register changed since entry, no explicit return values) is _forwarded_; every other root — loads, stores, call arguments, branch/switch/indirect targets, explicit return values, supplied roots — is _semantic_. The semantic closure runs first, so a slice reached from both is semantic; each slice key is still visited once. `all` feeds observed call interfaces and `NativeDependency.return_demand`; `semantic` feeds `return_demand_semantic`. When source facts fold prepared units' demand on the selected function into `function_return_demands`, the selected function's own unit (its self-calls) contributes only `return_demand_semantic`; every other unit contributes `return_demand`. Prepared units persist this shape (`NATIVE_SUMMARY_FORMAT` 2).

Incoming callers (`src/analysis/calls/caller-sites.ts`, `service/analysis/caller-result-use.ts`): `callerSiteIndex` is built once per image snapshot through `buildOnce` (cost `callerSiteIndexWork`: one per swept ARM64 instruction word or x86 reference, one per function, three per function range, one per loader hint). ARM64 sweeps Mach-O instruction sections minus data hints for BL (`call`) and B (`tail`) words whose target is a function entry, `complete: true`; x86-64 takes `call`/`tail_call` references, `complete` only when the caller passes a complete reference index. `callerSites(index, entry)` returns every site with its caller (`attribution: 'ranges'` when discovery owns it, `'next_entry'` when only the nearest entry below bounds it) and `caller_extent`. `classifyResultUse` gives `semantic` (registers from `observeCallResultDemands` on the SSA of the call plus a ≤ 64-instruction window, or from a prepared caller unit), `forwarded` (`returns`, `tails`: the result still live into the caller's return or a tail transfer), `dead` (both the integer and FP result roots written first, or a trap) or `unknown` (a call, unknown effect, indirect branch or jump table, the window bound, or a read whose consumer is outside the window). Source facts expose it to the planner as the lazy `caller_result_demands` (see CORE "Caller result use").

### 4. Callee summaries

```mermaid
flowchart TD
  R["calls of selected body"] --> D["dependencies: exact single-function targets"]
  D --> L["load units: arity-demanded closure first, then deferred"]
  L --> S["SCCs, callees first"]
  S --> O["observe once (acyclic)"]
  S --> F["recursive: seed, iterate, coinductive close"]
  O --> P["propagate reasons and arity completeness"]
  F --> P
  P --> SUM["NativeSummary per call"]
```

1. **Dependencies**: direct calls and tail calls (and indirect ones whose target folds to a constant) resolving to exactly one function; imports skipped (contracts cover them). Constant/aliased argument carriers become _context assumptions_ specializing the callee body.
2. **Load**: each callee runs the full pipeline (graph → lift → SSA → types → call analysis); reuse is in [project-cache](project-cache.md#algorithm). Demand-first: callees an _unobserved_ entry argument may reach load first (only they can widen arity); effects/results/shapes callees after.
3. **Budget**: optional pool = half the work left after the selected body, but never the selected body's tail reserve (300 work per IR node, `optionalWorkPool`): with nothing above the reserve the pool is 0 and the worklist stops at its first charge (`Native dependency worklist stopped at its work sub-budget (0)`); the worklist gets ¾ of the pool. A load gets ≤¼ of what remains; no new body starts once under half the initial allowance remains; 64 functions, capacity caps, ≤4 contexts per function (then generic body + reason).
4. **Observe a body**: parameters = non-preserved ABI registers read before written by a _semantic_ use (spills, preservation, phi transport don't count). `ambiguous` on: a gap in a bank (x2 read, x1 not), unknown effect/terminator, direct callee without interface, incoming-stack read. Returns = registers written with meaningful bits on _every_ exit (consumption alone is not a write). An exact pointer into the incoming area that escapes ⇒ `va_list`-style variadic.
   - **Context result root** (`generic_result` on the context unit, `prepareNativeContext`; applied by `inheritGenericResult` in `observeNativeUnit`): a context keeps only some exits, so its own result can switch storage. Example: SysV `-O2` `matrix_variadic(0)` keeps only the `xorpd %xmm0,%xmm0; ret` exit; a literal zero has no IEEE type, so xmm0 is skipped and the `va_list` setup's rax is claimed, while `matrix_variadic(2)` returns xmm0 f64. The context unit therefore stores the baseline body's result, proven on _every_ baseline exit, where an FP/vector exit with a proven but untyped write (a literal zero) counts as a write of the root that another exit types (all typed exits agree; untyped writes cover the type width). When the context result and the generic result are both non-empty and name different roots, the context takes the generic roots, for the summary and its `source_interface`; widths/types on a root both prove stay the context's, and an empty context result stays empty. Context units are never persisted, so the stored summary shape is unchanged.
   - **Slot-typed result** (`reloadedSlotType` in `nativeReturnInterface`, `createSlotTyper` in `reconstruction/source-slot-types.ts`): an `-O0` function returns a reload of a frame slot (`movsd -0x28(%rbp),%xmm0`, `ldr d0,[sp,#8]`), which has no expression type, so the FP root was skipped and a loop counter in `eax` became the result. The root is typed when the exit's low 64/32 bits are a load of an exact local slot whose direct stores are all typed FP of that width, literals (at least one typed store required) or typed slot reloads; an integer store, partial/dynamic stack write, or a load a frame address may already have reached a call/unresolved memory before (`StackSnapshot.escaped` at that load, flow-sensitive; dead-end FPCR `unknown_effect` paths do not reach it) keeps the integer root. The planner (`source-results.ts`) uses the same typer. The typed-result precedence then replaces the integer root.
5. **Closure**: not ambiguous, no stack parameters/escape, every callee that unobserved arguments reach is itself closed. Otherwise open.
6. **Order and fixpoint**: SCCs callees-first; acyclic bodies observed once against final callee interfaces. Recursive groups: seed with locally authored return witnesses, iterate (changed member re-queues in-group callers; ≤64 visits; equality = fingerprint of the whole interface). A least fixpoint never closes a group waiting on itself, so a **coinductive check** assumes all members closed with current parameters, re-observes once, keeps the result only if self-consistent. Memory shapes are not exchanged along recursive edges (no convergence).
7. **Reasons**: partial/limit reasons propagate to callers as a bounded fixpoint; `arity_complete` is inherited only through argument-reaching calls. Budget-worded reasons yield "cut by budget", others "partial".

### 5. Call-site resolution and special cases

- Strongest first: complete established contract ⇒ rendered from it; else callee summary merged with the caller prefix (callee-proven locations win, caller slots fill gaps, ABI order; the merge never closes arity). A refined `source_interface` (context, library tail) sits beside it and is used only when the summary is arity-complete. Else physical call with `...`.
- **Variadics**: allocation is `classifyCall`; closing is separate and evidence-gated. Only an established library rule (`format`, `scanf_format`, `open_flags`) whose argument has a finite value set (≤8 constants/addresses through phis/selects/pure ops) naming an immutable terminated literal closes the tail, and only if every candidate agrees.
- **Objective-C** (Mach-O): selector from a stub entry, or from an exact `__objc_selrefs` load in SEL of `objc_msgSend*`; keyword arity = colons; types from a unique agreeing method encoding, else pointer-sized. Rejected if the caller prepared more registers than the selector names. Indirect tail jumps through an established import likewise bind that contract's register interface.
- **Opt-in `likely` mode**: `callee_reads` (closure ignoring unobserved arguments forwarded to indirect calls) and `caller_consensus` (all discovered direct sites prepare the same prefix). A gate table decides what prints; failing guesses are only recorded.

## Design decisions

- **Evidence, not prototypes.** Call analysis is non-rewriting; a layout never initializes registers or memory. Contracts are explicit typed inputs; observations supplement but cannot create a complete signature.
- **Refuse over guess.** Partial layouts stop allocation; an unobserved callee is `unresolved` (ambiguous, open), never zero-argument; candidates never establish arity or types; conflicts survive as alternatives.
- **Callee bodies are the arity oracle.** Arity closes from the callee's complete reads, not from what callers pass (callers may write unread slots).
- **Determinism under budgets.** Nested fair shares and reserves; limits only stop work and leave explicit reasons; reuse replays the original work charge.

## Limits and improvement levers

- **Open arity is the dominant loss.** Stack-argument reads, `va_list` escapes, ambiguous callees, unused-parameter gaps in a bank and unresolved indirect calls inside the callee all leave `...`. Levers: accept gaps the body proves unread [inference]; closable stack parameters (`observeParameters`).
- **Indirect calls/callbacks**: only proven constants or bounded discovery establish a target; `indirect_call_target` has no passing heuristic. Lever: earlier target resolution (discovery/value analysis).
- **`likely` coverage**: `caller_consensus` is recorded but gated off (pooled precision ~86% < 95%); abstains above 32 callers, on tail calls, on disagreeing prefixes; SQLite closes 76 of 889 open sites.
- **Cost**: each callee repeats lift/SSA/types/calls (~32% of worker CPU in one profile); units over ~8k size are not persisted. Summaries depend on demand/context, so a summary-only cache is hard [inference].
- **Budget-dependent results**: the load reserve decides which callees load, hence summaries and merged image types.
- **Granularity**: return recovery targets primary registers (plus demanded second words); x87/aggregate returns and multi-exit type disagreement are dropped; context caps push hubs onto generic bodies.
- **Coverage**: three profiles only (no Linux/Windows ARM64, no x86-32); noreturn only from contracts.
