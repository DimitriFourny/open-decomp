import type { AbiProfile, AbiSignature, AbiType, OperationContext } from '../../core/index.js';
import type { CallAnalysisResult, LocationObservation } from '../../analysis/calls/index.js';
import type { StackRecoveryResult } from '../../analysis/stack/index.js';
import {
  evaluateExpression,
  expressionOperands,
  type DataType,
  type Expression,
  type Instruction,
  type SSAForm,
  type Value,
} from '../../ir/index.js';
import type { LibraryContracts } from '../../metadata/library-contracts/index.js';
import type { SourceAddress } from '../../reconstruction/source-model.js';

/** Standard printf conversions only. Unsupported extensions, positional syntax,
 * malformed directives and long double retain an open argument list. */
export function printfArgumentTypes(format: string, abi: AbiProfile): readonly AbiType[] | null {
  const types: AbiType[] = [];
  const integer = (bits: number, signed = true): AbiType => ({ kind: 'integer', bits, signed });
  for (let cursor = 0; cursor < format.length; cursor++) {
    if (format[cursor] !== '%') continue;
    cursor++;
    if (format[cursor] === '%') continue;
    while (cursor < format.length && '-+ #0'.includes(format[cursor]!)) cursor++;
    if (format[cursor] === '*') {
      types.push(integer(32));
      cursor++;
    } else while (/[0-9]/.test(format[cursor] ?? '')) cursor++;
    if (format[cursor] === '.') {
      cursor++;
      if (format[cursor] === '*') {
        types.push(integer(32));
        cursor++;
      } else while (/[0-9]/.test(format[cursor] ?? '')) cursor++;
    }
    let length = '';
    if ('hljztL'.includes(format[cursor] ?? '\0')) {
      length = format[cursor++]!;
      if ((length === 'h' || length === 'l') && format[cursor] === length)
        length += format[cursor++]!;
    }
    const conversion = format[cursor];
    if (!conversion) return null;
    if ('diouxX'.includes(conversion) && length !== 'L') {
      const bits =
        length === 'll' || 'jzt'.includes(length || '\0')
          ? 64
          : length === 'l'
            ? abi.id === 'windows-x64'
              ? 32
              : 64
            : 32;
      types.push(integer(bits, conversion === 'd' || conversion === 'i'));
    } else if ('aAeEfFgG'.includes(conversion) && (length === '' || length === 'l'))
      types.push({ kind: 'float', bits: 64 });
    else if (conversion === 'c' && length === '') types.push(integer(32));
    else if ((conversion === 's' || conversion === 'p') && length === '')
      types.push({ kind: 'pointer' });
    else if (conversion === 'n' && length !== 'L') types.push({ kind: 'pointer' });
    else return null;
    if (types.length > 64) return null;
  }
  return types;
}

const MAX_CANDIDATES = 8;

/** Bounded finite value set of an integer SSA value: constants and addresses
 * joined through block parameters (phis), selects and pure integer operators
 * over small operand sets. Entry values, loads, call results, cycles and larger
 * sets are unknown (null). Every reaching value is a member; no member is chosen. */
export function constantCandidates(
  ir: SSAForm,
  stack: StackRecoveryResult | null,
  context: OperationContext,
): (value: Value) => readonly bigint[] | null {
  const definitions = new Map<string, { readonly type: DataType; readonly expression: Expression }>();
  const incoming = new Map<string, Value[]>();
  const entryParameters = new Set<string>();
  const parameters = new Map<string, Value>();
  const byId = new Map(ir.blocks.map((block) => [block.id, block]));
  for (const block of ir.blocks) {
    for (const parameter of block.parameters) {
      parameters.set(parameter.id, parameter);
      if (block.id === ir.entry) entryParameters.add(parameter.id);
    }
    for (const node of block.instructions)
      if (node.kind === 'assign')
        definitions.set(node.result.id, { type: node.result.type, expression: node.expression });
    const control = block.terminator;
    const edges =
      control.kind === 'jump'
        ? [control.edge]
        : control.kind === 'branch'
          ? [control.when_true, control.when_false]
          : control.kind === 'switch'
            ? [...control.cases.map((item) => item.edge), control.otherwise]
            : [];
    for (const edge of edges) {
      const target = byId.get(edge.target);
      for (const [index, source] of edge.arguments.entries()) {
        const parameter = target?.parameters[index];
        if (!parameter) continue;
        const sources = incoming.get(parameter.id) ?? [];
        sources.push(source);
        incoming.set(parameter.id, sources);
      }
    }
  }
  const memo = new Map<string, readonly bigint[] | null>();
  const active = new Set<string>();
  const union = (sets: readonly (readonly bigint[] | null)[]): readonly bigint[] | null => {
    const result = new Set<bigint>();
    for (const set of sets) {
      if (!set) return null;
      for (const item of set) result.add(item);
      if (result.size > MAX_CANDIDATES) return null;
    }
    return [...result].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };
  const evaluate = (value: Value): readonly bigint[] | null => {
    context.checkpoint(1);
    if (value.type.kind !== 'integer') return null;
    const known = memo.get(value.id);
    if (known !== undefined) return known;
    if (active.has(value.id)) return null;
    const fact = stack?.values.get(value.id)?.value;
    if (fact?.kind === 'constant') return [BigInt.asUintN(value.type.bits, fact.bits)];
    if (fact?.kind === 'address') return [BigInt.asUintN(value.type.bits, fact.address.value)];
    active.add(value.id);
    let result: readonly bigint[] | null = null;
    const definition = definitions.get(value.id);
    if (definition?.expression.kind === 'select')
      result = union([
        evaluate(definition.expression.when_true),
        evaluate(definition.expression.when_false),
      ]);
    else if (definition && definition.expression.kind !== 'indeterminate') {
      const operands = expressionOperands(definition.expression);
      const sets = operands.map(evaluate);
      if (sets.every((set): set is readonly bigint[] => set !== null)) {
        let combinations: Map<string, bigint>[] = [new Map()];
        for (const [index, set] of sets.entries()) {
          combinations = combinations.flatMap((combination) =>
            set.map((item) => new Map([...combination, [operands[index]!.id, item]])),
          );
          if (combinations.length > MAX_CANDIDATES * MAX_CANDIDATES) break;
        }
        if (combinations.length <= MAX_CANDIDATES * MAX_CANDIDATES) {
          const values: (readonly bigint[] | null)[] = combinations.map((combination) => {
            const evaluated = evaluateExpression(definition.type, definition.expression, (operand) =>
              combination.has(operand.id)
                ? { kind: 'bits', bits: combination.get(operand.id)! }
                : { kind: 'unknown', reason: 'unbound operand' },
            );
            return evaluated.kind === 'bits' ? [evaluated.bits] : null;
          });
          result = union(values);
        }
      }
    } else if (parameters.has(value.id) && !entryParameters.has(value.id)) {
      const sources = incoming.get(value.id);
      if (sources?.length) result = union(sources.map(evaluate));
    }
    active.delete(value.id);
    memo.set(value.id, result);
    return result;
  };
  return evaluate;
}

/** Possible values of one register ABI location at a call, composed from the
 * call's exact register-cell bindings; null unless every cell is finite. */
function locationCandidates(
  call: Extract<Instruction, { kind: 'call' }> | undefined,
  observation: LocationObservation | undefined,
  candidates: (value: Value) => readonly bigint[] | null,
): readonly bigint[] | null {
  if (!observation) return null;
  const fact = observation.fact.value;
  const width = observation.location.kind === 'register' ? observation.location.width_bits : 64;
  if (fact.kind === 'constant') return [BigInt.asUintN(width, fact.bits)];
  if (fact.kind === 'address') return [BigInt.asUintN(width, fact.address.value)];
  const location = observation.location;
  if (!call || location.kind !== 'register' || location.value_offset_bits !== 0) return null;
  const start = location.register.offset_bits,
    end = start + location.width_bits;
  const cells = call.register_inputs
    .filter(
      (binding) =>
        binding.register.root === location.register.root &&
        binding.register.offset_bits < end &&
        binding.register.offset_bits + binding.register.width_bits > start,
    )
    .sort((a, b) => a.register.offset_bits - b.register.offset_bits);
  let cursor = start,
    values: bigint[] = [0n];
  for (const cell of cells) {
    if (
      cell.register.offset_bits !== cursor ||
      cell.register.offset_bits + cell.register.width_bits > end
    )
      return null;
    const set = candidates(cell.value);
    if (!set) return null;
    values = values.flatMap((prefix) =>
      set.map((item) => prefix | (BigInt.asUintN(cell.register.width_bits, item) << BigInt(cursor - start))),
    );
    if (values.length > MAX_CANDIDATES) return null;
    cursor += cell.register.width_bits;
  }
  return cursor === end ? [...new Set(values)] : null;
}

/** Darwin `open` reads its mode argument exactly when `O_CREAT` (0x200 in the
 * Darwin `<sys/fcntl.h>`) is set and has no other mode-consuming flag. Other
 * targets use only the target-independent rule that zero flags take no mode. */
function openModeRequired(abi: AbiProfile, flags: readonly bigint[]): boolean | null {
  if (flags.every((value) => value === 0n)) return false;
  if (abi.id !== 'darwin-arm64') return null;
  const created = flags.map((value) => (value & 0x200n) !== 0n);
  return created.every(Boolean) ? true : created.some(Boolean) ? null : false;
}

/** One call's established variadic library rule and every possible value of
 * its rule argument. */
export interface VariadicRuleCall {
  readonly call_id: string;
  readonly contract: LibraryContracts['contracts'][number];
  readonly kind: 'format' | 'open_flags';
  readonly values: readonly bigint[];
}

/** Calls whose established, nonconflicting library contract has a format or
 * open-flags rule and whose rule argument has a finite value set. Callable-entry
 * and import resolutions can supply the same nominal contract twice; they agree
 * only when every established observation names that contract and proves the
 * identical value set. */
export function variadicRuleCalls(
  ir: SSAForm,
  analysis: CallAnalysisResult | null,
  library: LibraryContracts,
  context: OperationContext,
): readonly VariadicRuleCall[] {
  const result: VariadicRuleCall[] = [];
  if (!analysis) return result;
  const candidates = constantCandidates(ir, analysis.stack, context);
  const calls = new Map<string, Extract<Instruction, { kind: 'call' }>>();
  for (const block of ir.blocks)
    for (const node of block.instructions) if (node.kind === 'call') calls.set(node.id, node);
  for (const call of analysis.calls) {
    context.checkpoint(1);
    if (call.status !== 'established') continue;
    const observations = call.contracts.filter((item) => item.status === 'established');
    if (!observations.length) continue;
    const observation = observations[0]!;
    const contract = library.contracts.find(
      (item) =>
        item.id === observation.contract.id || `${item.id}:entry` === observation.contract.id,
    );
    const rule = contract?.variadic_rule;
    if (
      !contract ||
      !rule ||
      contract.conflicts_with.length ||
      (rule.kind !== 'format' && rule.kind !== 'open_flags') ||
      !contract.abi_signature.parameters
    )
      continue;
    let values: readonly bigint[] | null = null;
    for (const observed of observations) {
      context.checkpoint(1);
      const locations = observed.parameters.find((item) => item.index === rule.argument)?.locations;
      const current =
        (observed.contract.id === contract.id || observed.contract.id === `${contract.id}:entry`) &&
        locations?.length === 1
          ? locationCandidates(calls.get(call.node_id), locations[0], candidates)
          : null;
      if (!current) {
        values = null;
        break;
      }
      const sorted = [...current].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (values && values.join() !== sorted.join()) {
        values = null;
        break;
      }
      values = sorted;
    }
    if (values?.length) result.push({ call_id: call.node_id, contract, kind: rule.kind, values });
  }
  return result;
}

interface VariadicRuleFacts {
  /** Source-only complete actual types: a proven immutable printf-family format,
   * or Darwin `open` flags that all require the mode argument. */
  readonly signatures: ReadonlyMap<string, AbiSignature>;
  /** Proven complete actual counts for `open`-family calls without a mode. */
  readonly counts: ReadonlyMap<string, number>;
}

/** Existing nominal library rules may close a variadic prefix. Every possible
 * rule-argument value must lead to the same actual list. Literal bytes must
 * have immutable, terminated image provenance. Never use a nearby string,
 * mutable storage, a guessed library name or a conflicting contract. */
export function variadicRuleFacts(
  calls: readonly VariadicRuleCall[],
  addresses: readonly SourceAddress[],
  abi: AbiProfile,
  context: OperationContext,
): VariadicRuleFacts {
  const signatures = new Map<string, AbiSignature>(),
    counts = new Map<string, number>();
  for (const { call_id, contract, kind, values } of calls) {
    context.checkpoint(1);
    let additional: readonly AbiType[] | null = null;
    if (kind === 'format') {
      for (const address of values) {
        context.checkpoint(1);
        const literal = addresses.find(
          (item) => item.address.value === address && item.string !== undefined,
        );
        const types =
          literal?.string === undefined ? null : printfArgumentTypes(literal.string, abi);
        if (!types || (additional && JSON.stringify(types) !== JSON.stringify(additional))) {
          additional = null;
          break;
        }
        additional = types;
      }
    } else {
      const mode = openModeRequired(abi, values);
      if (mode === false) counts.set(call_id, contract.abi_signature.fixed_parameter_count);
      if (mode === true) additional = [{ kind: 'integer', bits: 32, signed: true }];
    }
    if (!additional) continue;
    signatures.set(call_id, {
      ...contract.abi_signature,
      parameters: [...contract.abi_signature.parameters!, ...additional],
      argument_list_complete: true,
    });
  }
  return { signatures, counts };
}
