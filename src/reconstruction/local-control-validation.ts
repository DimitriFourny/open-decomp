import type {
  ControlArm,
  ParallelTransfer,
  Region,
  StructuredFunction,
} from '../presentation/index.js';
import { LocalValidationSession, validateControlTarget } from './local-validation.js';

export type EmittedEdge =
  | { readonly kind: 'goto'; readonly target: string }
  | { readonly kind: 'fallthrough' | 'break' | 'continue' };
/** Consume recorded emitted actions, not the structurer's suggested transfer
 * modes. Derive lexical destinations from the rendered region layout. */
export function validateEmittedControl(
  fn: StructuredFunction,
  emitted: ReadonlyMap<ParallelTransfer, EmittedEdge>,
  language: 'c-like' | 'python-like',
  validation: LocalValidationSession,
): void {
  type Scope = { loop: string | null; after: string | null };
  let work = 0;
  const entry = (region: Region, fallback: string | null): string | null => {
    while (region.kind === 'sequence') {
      validation.allowance.charge();
      if (!region.regions.length) return fallback;
      region = region.regions[0]!;
    }
    return region.kind === 'loop' ? region.header : region.id;
  };
  const edge = (
    transfer: ParallelTransfer,
    follow: string | null,
    scopes: readonly Scope[],
    subject: string,
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
      if (action.kind === 'break') actual = scopes.at(-1)?.after ?? null;
      if (action.kind === 'continue')
        actual = [...scopes].reverse().find((scope) => scope.loop !== null)?.loop ?? null;
      return validateControlTarget(subject, transfer.target, actual);
    });
  };
  const arm = (
    arm: ControlArm,
    follow: string | null,
    scopes: readonly Scope[],
    subject: string,
  ): void => {
    edge(arm.transfer, arm.body ? entry(arm.body, follow) : follow, scopes, subject);
    if (arm.body) walk(arm.body, follow, scopes);
  };
  const walk = (region: Region, follow: string | null, scopes: readonly Scope[]): void => {
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
        walk(region.regions[i]!, next, scopes);
      }
    } else if (region.kind === 'loop')
      walk(region.body, region.header, [...scopes, { loop: region.header, after: follow }]);
    else {
      const control = region.control;
      if (control.kind === 'jump') edge(control.transfer, follow, scopes, control.id);
      if (control.kind === 'if') {
        arm(control.when_true, follow, scopes, control.id);
        arm(control.when_false, follow, scopes, control.id);
      }
      if (control.kind === 'switch') {
        const nested = language === 'c-like' ? [...scopes, { loop: null, after: follow }] : scopes;
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
