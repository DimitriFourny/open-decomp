import type { Address, Diagnostic, Evidence, SymbolRecord } from '../../core/index.js';

export type RuntimeKind =
  | 'objc_class'
  | 'objc_metaclass'
  | 'objc_metaclass_link'
  | 'objc_category'
  | 'objc_protocol'
  | 'objc_protocol_adoption'
  | 'objc_method'
  | 'objc_method_declaration'
  | 'objc_ivar'
  | 'objc_selector'
  | 'objc_class_reference'
  | 'objc_superclass_reference'
  | 'swift_module'
  | 'swift_parent'
  | 'swift_class'
  | 'swift_structure'
  | 'swift_enum'
  | 'swift_protocol'
  | 'swift_extension'
  | 'swift_field_descriptor'
  | 'swift_field'
  | 'swift_enum_case'
  | 'swift_superclass';
export interface RuntimeRecord {
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly name: string;
  readonly address: Address;
  /** Size of the metadata record, never an instance/object layout claim. */
  readonly byte_length: bigint;
  readonly owner: string | null;
  readonly target: Address | null;
  readonly target_role: 'code' | 'metadata' | 'unresolved';
  readonly method_kind: 'class' | 'instance' | null;
  readonly type_name: string | null;
  readonly type_encoding: 'objc' | 'swift-mangled' | null;
  readonly flags: bigint | null;
  readonly evidence_ids: readonly string[];
}
export interface RuntimeMetadata {
  /** Complete covers only the documented static section/record families. */
  readonly state: 'absent' | 'complete' | 'partial';
  readonly records: readonly RuntimeRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly evidence: readonly Evidence[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface RuntimeLimits {
  readonly max_records: number;
  readonly max_entries: number;
  readonly max_depth: number;
  readonly max_string_bytes: number;
  readonly max_total_string_bytes: number;
}
export const runtimeLimits: RuntimeLimits = {
  max_records: 100_000,
  max_entries: 100_000,
  max_depth: 64,
  max_string_bytes: 4096,
  max_total_string_bytes: 8 * 1024 * 1024,
};
