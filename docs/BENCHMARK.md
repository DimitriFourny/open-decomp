# Benchmark (odbench)

odbench measures an Open Decomp build against Ghidra's headless decompiler on a corpus of compiled functions whose C source is known. Code: `scripts/bench/odbench/` (entry point `cli.ts`, run as `bun run bench <command>`; `bun run bench --help` lists every flag).

## What it measures

Three kinds of lane decompile every corpus function:

- `od-<label>`: one process per binary imports a checkout's built `dist/src/api/index.js`, opens the binary in a fresh cache and decompiles each function by address (C-like source view, `proven` inference, default budget), timing open and every call. `--repeat N` re-runs and checks that the text is identical; `--jobs N` sets request workers per binary (default `min(4, cores/2)`).
- `ghidra`: `analyzeHeadless` with default auto-analysis, then a post-script (`ghidra/*.java`) decompiles each function, located by name, address or ELF rebase (created at the entry if analysis found none there). Cached per binary by binary hash, Ghidra version, scripts and function list.
- `source`: the function's C definition with comments removed. It is the calibration anchor: the judge must prefer it to Ghidra (score ≥ 0.7), otherwise the readability rows are not trusted.

Measures (`bench report`):

| measure                                                                                                                                                                                       | needs a model |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| coverage: functions with text, partial, failed, not found                                                                                                                                     | no            |
| size: lexical C tokens, bytes, lines; per-function geometric-mean ratios against the reference lane with bootstrap 95% CIs                                                                    | no            |
| structure counters: `goto`, loops, nesting, decision points, casts, declarations, placeholder names, each tool's artifacts (`unknown_*` …; `CONCAT44`, `undefined8`, `extraout_` …)           | no            |
| signature against source (return kind, parameter count), Open Decomp diagnostics, counted work per function                                                                                   | no            |
| speed: per binary cold time (process, open/import, analysis, every decompile), per-function time, open time, peak RSS                                                                         | no            |
| Claude tokens of each listing (the judge model's tokenizer)                                                                                                                                   | yes           |
| readability: the judge compares two listings blind, in both orders, on control flow, data, expressions, noise and overall; 1 / 0.5 / 0 per order for win / tie / loss                         | yes           |
| comprehension: the judge explains the function from the listing alone; a second call grades the explanation against the original source (claims correct / wrong / unverifiable, coverage 0–4) | yes           |
| QA: the 42 frozen questions of `scripts/bench/llm-tasks/questions.json`, 3 samples each, decompiler lanes only                                                                                | yes           |

**Speed rows (D8).** Open Decomp analyzes per function, Ghidra analyzes the whole program first, so per-function times are not comparable. The report instead compares Open Decomp's decompile time after open with Ghidra's whole run (JVM start, import, analysis, decompiles) per binary and in total, against the project target 1.25×, and the time from open to the 10th corpus function of `sqlite3-arm64` against 5 s. Section 8 also lists every binary's cold, open and first-10 times.

**Judge.** Default model `anthropic/claude-haiku-5-5` (`--model`). Every call is cached by task, model, exact prompt and sample under the data store, so unchanged listings are never judged twice and `report` never calls a model.

**Caveats.** The corpus is a development set: its sources were known and its outputs were read while tuning Open Decomp, so it does not show how results generalise. Readability and comprehension are one small model's opinion, not human review; both presentation orders cancel position bias, and single dimensions are noisier than `overall`. The QA set is small and written by one author.

## Result (2026-10-23)

Open Decomp `1239ec9`, full tier (237 functions), `--repeat 2` (texts and counted work identical across repeats), 4 request workers; Ghidra 12.1.4. Judge Haiku, 3 comprehension samples. One run on a shared 12-core Apple M6, load average 6.7 at start. Quality rows cover the 232 functions every lane printed.

| measure                                                          |                Open Decomp |      Ghidra |               source |
| ---------------------------------------------------------------- | -------------------------: | ----------: | -------------------: |
| functions with text (of 237)                                     |                        235 |         237 |                  237 |
| lexical tokens vs Ghidra (geomean, 95% CI)                       |       1.176 [1.133, 1.220] |           1 | 0.570 [0.512, 0.631] |
| Claude tokens vs Ghidra                                          |       1.252 [1.194, 1.309] |           1 | 0.518 [0.469, 0.573] |
| readability vs Ghidra (overall)                                  |       0.878 [0.845, 0.907] |           — | 0.987 [0.976, 0.996] |
| strict wins / ties / losses vs Ghidra                            |               180 / 46 / 6 |           — |          226 / 6 / 0 |
| readability by dimension: control flow, data, expressions, noise | 0.698, 0.888, 0.816, 0.564 |           — |                    — |
| comprehension coverage (0–4)                                     |                      2.790 |       2.757 |                3.632 |
| comprehension coverage − Ghidra (paired)                         |      0.033 [−0.036, 0.101] |           — |                    — |
| wrong claims per function                                        |                       2.34 |        2.22 |                 0.46 |
| QA correct rate (126 samples)                                    |                        77% |         67% |                    — |
| QA Claude tokens per correct answer                              |                      3,879 |       3,528 |                    — |
| static counters: `goto` / casts                                  |                717 / 5,863 | 781 / 5,428 |                    — |

| speed                             |              Open Decomp cold |                                              Ghidra cold | Open Decomp decompile after open ÷ Ghidra cold (D8) |
| --------------------------------- | ----------------------------: | -------------------------------------------------------: | --------------------------------------------------: |
| SQLite (114 functions)            |                        46.3 s |                                                   38.7 s |                                               0.86× |
| brotli (15 functions)             |                         4.3 s |                                                    3.9 s |                                               0.79× |
| 9 matrix binaries (108 functions) |                        16.1 s |                                                   44.0 s |                                        ≤ 0.33× each |
| total                             |                        66.8 s |                                                   86.7 s |                                               0.52× |
| first 10 SQLite functions         | 17.4 s (open 12.9 s + 4.55 s) | ~36.3 s (import 4.2 s + analysis 31.9 s + 10 decompiles) |                                                   — |

Open Decomp's open includes the open-time unit job (10.8 s on SQLite); peak RSS of its largest process was 2.0 GB. The two functions without text (`sqlite3Select`, `sqlite3Pragma`) stop at the 10M work limit; with 100M they stop at the IR-node budget, the proof catalog bound or the 16 MiB artifact bound instead.

## Our inputs (not distributed)

The data store `.odbench/` is gitignored. Its binaries cannot be redistributed or rebuilt byte for byte, so the numbers above are reproducible only with these files; with your own inputs the numbers will differ.

- SQLite 3.54.0 shell, Mach-O arm64, built locally from `sqlite-autoconf-3540000.tar.gz`; source: the amalgamation `sqlite3.c`.
- brotli 1.2.0 command-line tool, Mach-O arm64, from Homebrew; source: `c/tools/brotli.c` at tag v1.2.0.
- 9 "matrix" binaries built by `scripts/bench/quality-matrix-build.py` from `scripts/bench/quality-matrix-corpus.c` and zlib 1.3.1 `adler32.c` / `crc32.c` (`Z_SOLO`): Apple clang 21 symbol-bearing Mach-O arm64, ELF x86-64 and PE x86-64 at `-O0` and `-O2`, and LLVM clang 23 `-O2` stripped builds of the same three targets.

`scripts/bench/odbench/corpus.json` (committed, frozen 2026-10-21) pins every file's SHA-256 and the selected functions: names with exactly one definition in the source, excluding import stubs, `.cold` pieces and code outside 16–32,768 bytes; SQLite drawn stratified by size (seed 20261021), every brotli candidate, the 12 corpus functions of each matrix binary, plus every function a QA question asks about. Tiers: `quick` 68 functions (34 SQLite, 10 brotli, 24 matrix), `full` 237 (114, 15, 108). `bun run bench inputs` verifies the files. `bun run bench select --check` rebuilds the corpus with the current build and compares; selection reads that build's function index and code sizes, so builds after the freeze report differences (on 2026-10-23: 29 SQLite functions swapped, 7 other records changed). The corpus stays frozen; it is not re-selected.

## Reproduce with your own inputs

Prerequisites: Node 24+, Bun 1.4.3, a checkout built with `bun install --frozen-lockfile && bun run build`. For the Ghidra lane: a Ghidra installation (we used 12.1.4) and a JDK it supports. For the judge: an Anthropic API key, or any command that reads a prompt on stdin and writes the reply on stdout.

1. Choose a data store and put each binary under `inputs/` and its C sources under `sources/`:

   ```sh
   export OPEN_DECOMP_BENCH_DIR=$HOME/odbench-mine   # default: .odbench/ in the main checkout
   mkdir -p $OPEN_DECOMP_BENCH_DIR/inputs $OPEN_DECOMP_BENCH_DIR/sources
   ```

2. Describe them in `$OPEN_DECOMP_BENCH_DIR/inputs.json`. With this file present, every command uses `$OPEN_DECOMP_BENCH_DIR/corpus.json` instead of the committed corpus. Paths are relative to `inputs/` and `sources/`.

   ```json
   {
     "schema": "odbench-inputs/1",
     "sources": [{ "id": "zlib", "path": "zlib/inflate.c", "origin": "zlib 1.3.1" }],
     "binaries": [
       {
         "id": "app",
         "path": "app",
         "format": "elf",
         "arch": "x86_64",
         "opt": "O2",
         "sources": ["zlib"],
         "full": 100,
         "quick": 20
       },
       {
         "id": "app-strip",
         "path": "app.stripped",
         "format": "elf",
         "arch": "x86_64",
         "opt": "O2",
         "symbols": "app"
       }
     ]
   }
   ```

   `format` is `macho`, `elf` or `pe`; `arch` is `arm64` or `x86_64`. Optional fields: `opt` (default `unknown`), `group` (report breakdowns; default the id), `origin`, `seed` and `frozen` (a label recorded in the corpus). A symbol-bearing binary's candidates are functions whose symbol names exactly one top-level C definition across its `sources` (Mach-O leading underscore dropped), with the exclusions above; `full` draws that many of them (default all), `quick` draws from those (default all). A stripped binary names its symbol-bearing twin in `symbols` (the same build before stripping) and gets the twin's functions at the same addresses.

3. Build and check the corpus. Selection uses the function index of this checkout's `dist/`, so rebuild the corpus only on purpose; lanes record the corpus hash and the report warns about lanes from another corpus.

   ```sh
   bun run bench select           # writes $OPEN_DECOMP_BENCH_DIR/corpus.json
   bun run bench select --check   # the same build reproduces it
   bun run bench inputs           # verifies binary and source hashes
   ```

4. Run the lanes. No model is involved.

   ```sh
   bun run bench run od --label mine --tier full     # --repo PATH measures another built checkout
   bun run bench run source --tier full
   bun run bench run ghidra --tier full --install /path/to/ghidra_12.1.4_PUBLIC --java-home /path/to/jdk
   ```

   `--install` falls back to `GHIDRA_INSTALL_DIR`, then `~/Downloads/ghidra_12.1.4_PUBLIC`; `--java-home` to `JAVA_HOME`, then Homebrew's `openjdk`.

5. Report coverage, size, counters and speed without a model (`--reference source` works without Ghidra):

   ```sh
   bun run bench report --lanes od-mine,source --reference ghidra --tier full
   ```

6. Judge, then report again:

   ```sh
   bun run bench judge --lanes od-mine,ghidra,source --tier full --dry-run    # count the calls
   ANTHROPIC_API_KEY=... bun run bench judge --lanes od-mine,ghidra,source --tier full
   bun run bench judge --lanes od-mine,ghidra,source --backend cmd --command 'my-llm --model X'
   ```

   `--pairs A:B,...` chooses readability pairs (default: every lane against `ghidra`). The `cmd` backend reports no token usage, so the Claude-token task is skipped. `bun run bench all --label mine --tier full` runs steps 4–6 in one go (it needs Ghidra). Reports go to `$OPEN_DECOMP_BENCH_DIR/reports/<time>-<lane>-<tier>/report.{md,json}`.

QA rows stay empty for your inputs: the questions are tied to our SQLite and brotli binaries by id and address. The scorecard's first-10 row reads the binary with id `sqlite3-arm64`; section 8 lists first-10 times for every binary.

## QA questions (`scripts/bench/llm-tasks/`)

`questions.json` holds 42 questions written on 2026-10-19, before any decompiler output for them existed: 26 on 14 SQLite functions, 16 on 7 brotli functions (return values, constants and limits, struct field offsets, error texts, flags, call order, loop bounds, branch conditions, callees). Gold answers come from the source with the configuration the binary embeds, offsets checked against `llvm-objdump`; each question has a machine scoring rule (`numeric`, `exact`, `set`, `regex` or `rubric`). odbench reuses the questions, prompt wording and scoring. `run.ts` is the standalone harness they came from (`verify --sources DIR` re-checks every gold span; `build` and `score` package and score answers outside odbench).

## Likely-inference precision

`options.inference: "likely"` prints guesses (argument counts, pointer types) that proven analysis does not establish. A heuristic may change the printed text only if it reaches 95% precision per call site and per callee on at least 20 scored guesses, pooled over targets (`LIKELY_PRECISION_GATE` and `LIKELY_GATE` in `src/core/inference.ts`). `scripts/bench/likely-precision.ts` decides this: it decompiles binaries in `likely` mode and scores every guess against a DWARF dump of a separate `-O1 -g` compile of the same sources, never against the analyzed binary.

```sh
node --import tsx scripts/bench/likely-precision.ts --label NAME [--only matrix,fixtures,sqlite,brotli,brotli-lib] [--sample N] [--out DIR] [--work DIR]
```

It needs clang and `dwarfdump` (macOS). The target paths are fixed in the script (`fixtures/bin`, `/opt/homebrew/bin/brotli`, the brotli 1.2.0 sources it downloads and builds, and our SQLite and matrix builds under `.local/`); targets whose inputs are missing are skipped.

Result behind the current gate (2026-10-20, all targets):

| heuristic                                          |                scored guesses |                  precision | gate            |
| -------------------------------------------------- | ----------------------------: | -------------------------: | --------------- |
| `callee_reads` (arity)                             | 76 sites, 43 callees (SQLite) |                       100% | enabled         |
| `caller_consensus` (arity)                         |                      44 sites | 86.4% sites, 77.8% callees | disabled        |
| `carried_word_formal` (pointer formal)             |                            25 |       100% (coverage 6.8%) | enabled         |
| `indirect_call_target` (pointer formal)            |                             8 |                       100% | disabled (< 20) |
| `opaque_word_formal` (pointer formal)              |                            85 | 70.6% sites, 68.8% formals | disabled        |
| `caller_argument_pointer`, `caller_result_pointer` |                             0 |                          — | disabled        |

The samples are small: zero errors in 43 callees is consistent with a true precision of about 92% or better at 95% confidence, zero in 25 with about 89%. Disabled heuristics still record their guesses (`applied: false`).
