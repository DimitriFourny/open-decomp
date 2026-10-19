import type {
  ControlArm,
  ParallelTransfer,
  Region,
  StructuredFunction,
} from '../presentation/index.js';
import { LocalValidationSession, validateControlTarget } from './local-validation.js';

export type EmittedEdge =
  | { readonly kind: 'goto'; readonly target: string }
  | { readonly kind: 'loop-exit'; readonly loop: string; readonly through: readonly string[] }
  /** A short-circuit operand edge entering the shared arm body of its head. */
  | { readonly kind: 'shared-arm' }
  | { readonly kind: 'fallthrough' | 'break' | 'continue' };
export interface EmittedLoopExits {
  readonly initialized: ReadonlySet<string>;
  readonly guards: ReadonlyMap<string, ReadonlySet<string>>;
}
/** Consume recorded emitted actions, not the structurer's suggested transfer
 * modes. Derive lexical destinations from the rendered region layout. */
export function validateEmittedControl(
  fn: StructuredFunction,
  emitted: ReadonlyMap<ParallelTransfer, EmittedEdge>,
  language: 'c-like' | 'python-like',
  validation: LocalValidationSession,
  exits?: EmittedLoopExits,
): void {
  /** `test`: a do-while's test control, the only site whose `continue` repeats.
   * `once`: a block run once, which `continue` never targets. */
  type Scope = {
    loop: string | null;
    after: string | null;
    test?: string;
    once?: true;
    id: string;
  };
  let work = 0;
  const entry = (region: Region, fallback: string | null): string | null => {
    while (region.kind === 'sequence') {
      validation.allowance.charge();
      if (!region.regions.length) return fallback;
      region = region.regions[0]!;
    }
    return region.kind === 'loop' ? region.header : region.id;
  };
  /** `shared`: entry of the shared arm body an operand of the chain being
   * walked may enter (`shared-arm`); null off an operand chain. */
  const edge = (
    transfer: ParallelTransfer,
    follow: string | null,
    scopes: readonly Scope[],
    subject: string,
    shared: string | null = null,
  ): void => {
    validation.check('control', subject, 'rendered edge target', () => {
      validation.allowance.charge();
      const action = emitted.get(transfer);
      if (!action)
        return {
          kind: 'control',
          subject,
          scope: 'rendered edge target',
          status: 'unverified',
          reason: 'edge has no recorded emitted action',
        };
      let actual = follow;
      if (action.kind === 'goto') actual = action.target;
      if (action.kind === 'shared-arm') actual = shared;
      if (action.kind === 'break') actual = scopes.at(-1)?.after ?? null;
      if (action.kind === 'continue') {
        const scope = [...scopes].reverse().find((item) => item.loop !== null);
        actual =
          scope && !scope.once && (scope.test === undefined || scope.test === subject)
            ? scope.loop
            : null;
      }
      if (action.kind === 'loop-exit') {
        const outer = scopes.findIndex((scope) => scope.loop === action.loop);
        const through = outer < 0 ? [] : scopes.slice(outer).reverse();
        actual =
          through.length > 1 &&
          through.length === action.through.length &&
          through.every((scope, index) => scope.id === action.through[index]) &&
          exits?.initialized.has(action.loop) &&
          through.slice(0, -1).every((scope) => exits.guards.get(scope.id)?.has(action.loop))
            ? scopes[outer]!.after
            : null;
      }
      return validateControlTarget(subject, transfer.target, actual);
    });
  };
  const arm = (
    arm: ControlArm,
    follow: string | null,
    scopes: readonly Scope[],
    subject: string,
    shared: string | null = null,
    chain: string | null = null,
  ): void => {
    edge(arm.transfer, arm.body ? entry(arm.body, follow) : follow, scopes, subject, shared);
    if (arm.body) walk(arm.body, follow, scopes, chain);
  };
  /** `chain`: the region is an operand chain position of a shared-arm head
   * (silent jumps then the next operand); its operands may enter that arm. */
  const walk = (
    region: Region,
    follow: string | null,
    scopes: readonly Scope[],
    chain: string | null = null,
  ): void => {
    validation.allowance.charge();
    if (++work > 1024) {
      validation.check('control', fn.id, 'rendered control layout', () => ({
        kind: 'control',
        subject: fn.id,
        scope: 'rendered control layout',
        status: 'unverified',
        reason: 'control region bound exceeded',
      }));
      return;
    }
    if (region.kind === 'sequence') {
      for (let i = 0; i < region.regions.length; i++) {
        let next = follow;
        for (let j = i + 1; j < region.regions.length; j++) {
          const candidate = entry(region.regions[j]!, null);
          if (candidate !== null) {
            next = candidate;
            break;
          }
        }
        // Only the last element, after jumps alone, continues an operand chain.
        const link =
          i === region.regions.length - 1 &&
          region.regions
            .slice(0, -1)
            .every((item) => item.kind === 'block' && item.control.kind === 'jump');
        walk(region.regions[i]!, next, scopes, link ? chain : null);
      }
    } else if (region.kind === 'loop') {
      // A block run once falls through to its follow; falling off a do-while
      // body reaches its test, never the header directly.
      const test = region.form?.kind === 'do_while' ? region.form.test : undefined;
      walk(region.body, region.once ? follow : test === undefined ? region.header : null, [
        ...scopes,
        {
          loop: region.header,
          id: region.header,
          after: follow,
          ...(test === undefined ? {} : { test }),
          ...(region.once ? { once: true as const } : {}),
        },
      ]);
    } else {
      const control = region.control;
      if (control.kind === 'jump') edge(control.transfer, follow, scopes, control.id);
      if (control.kind === 'if') {
        // A head's other arm starts an operand chain entering its shared arm;
        // an operand's staying arm continues the chain it belongs to.
        const head = [control.when_true, control.when_false].find((item) => item.shared);
        const operand = control.when_true.joins || control.when_false.joins ? chain : null;
        for (const item of [control.when_true, control.when_false])
          arm(
            item,
            follow,
            scopes,
            control.id,
            item.joins ? operand : null,
            head && item !== head ? entry(head.body!, null) : item.shared ? null : operand,
          );
      }
      if (control.kind === 'switch') {
        const nested =
          language === 'c-like'
            ? [...scopes, { loop: null, id: control.id, after: follow }]
            : scopes;
        for (const item of control.cases) arm(item.arm, follow, nested, control.id);
        arm(control.otherwise, follow, nested, control.id);
      }
    }
  };
  validation.check('control', fn.id, 'whole-function equivalence', () => {
    walk(fn.body, null, []);
    return {
      kind: 'control',
      subject: fn.id,
      scope: 'whole-function equivalence',
      status: 'unverified',
      reason:
        'Only local rewrite, move, storage and edge fragments are checked; conditions, calls and complete function behavior are not proved.',
    };
  });
}
