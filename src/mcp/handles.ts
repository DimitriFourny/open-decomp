import { z } from 'zod';
import type { ToolName } from '../core/index.js';

/** MCP accepts a function handle where the core contract requires a full entity ID. The handle is
 * validated for shape here, replaced by this placeholder while the core schema validates every
 * other field, and resolved against the function index only after authorization. */
export const HANDLE_PLACEHOLDER = `entity_${'0'.repeat(64)}`;
const MAX_HANDLE = 4096;
const fullEntityId = /^entity_[0-9a-f]{64}$/;

const HANDLE_DESCRIPTION =
  'Function: exact name (e.g. _main), va:0x… / rva:0x… / file:0x… address, or entity_ID (full or unique prefix of at least 12 hex digits)';

const jsonObject = z.record(z.string(), z.unknown());
type Json = z.infer<typeof jsonObject>;

export interface HandleSite {
  readonly path: string;
  readonly handle: string;
  /** The request with the handle replaced by HANDLE_PLACEHOLDER. */
  readonly input: Json;
  /** Substitute the resolved full function ID into validated arguments. */
  readonly bind: <A extends object>(args: A, id: string) => A;
}
export type DetailMode = 'text' | 'full';
export interface PreparedRequest {
  readonly input: unknown;
  readonly site: HandleSite | undefined;
  readonly detail: DetailMode;
}
export interface RequestProblem {
  readonly path: string;
  readonly hint: string;
}

/** Split the MCP-only conveniences (function handles, `detail`, default wait:"auto") from the
 * core request. A request that is not an object, or whose handle is malformed, is passed on
 * unchanged for the core schema to reject. */
export function prepareRequest(name: ToolName, input: unknown): PreparedRequest | RequestProblem {
  const original = jsonObject.safeParse(input).data;
  if (original === undefined) return { input, site: undefined, detail: 'text' };
  let request: Json = original;
  let detail: DetailMode = 'text';
  if (name === 'function_decompile') {
    const { detail: requested, ...rest } = request;
    if (requested !== undefined && requested !== 'text' && requested !== 'full')
      return { path: 'detail', hint: 'detail must be "text" (default) or "full"' };
    detail = requested === 'full' ? 'full' : 'text';
    request = rest.wait === undefined ? { ...rest, wait: 'auto' } : rest;
  }
  let site: HandleSite | undefined;
  if (name === 'function_get' || name === 'function_decompile') {
    const handle = request['function_id'];
    if (typeof handle === 'string' && !fullEntityId.test(handle)) {
      if (handle.length === 0 || handle.length > MAX_HANDLE)
        return { path: 'function_id', hint: `A function handle has 1..${MAX_HANDLE} characters` };
      site = {
        path: 'function_id',
        handle,
        input: { ...request, function_id: HANDLE_PLACEHOLDER },
        bind: (args, id) => ({ ...args, function_id: id }),
      };
    }
  } else if (name === 'xrefs_get') {
    const target = jsonObject.safeParse(request['target']).data;
    if (target !== undefined && target['kind'] === 'entity') {
      const handle = target['id'];
      if (typeof handle === 'string' && !fullEntityId.test(handle)) {
        if (handle.length === 0 || handle.length > MAX_HANDLE)
          return { path: 'target.id', hint: `A function handle has 1..${MAX_HANDLE} characters` };
        site = {
          path: 'target.id',
          handle,
          input: { ...request, target: { ...target, id: HANDLE_PLACEHOLDER } },
          bind: (args, id) => ({ ...args, target: { ...target, id } }),
        };
      }
    }
  }
  return { input: site?.input ?? request, site, detail };
}

const targetSchema = z.looseObject({
  oneOf: z.array(z.looseObject({ properties: jsonObject })),
});

/** The JSON Schema MCP advertises: the core input schema with the MCP-only conveniences. */
export function advertisedInputSchema(name: ToolName, core: Json): Json {
  const properties = jsonObject.safeParse(core['properties']).data;
  if (properties === undefined) return core;
  const handle = { type: 'string', description: HANDLE_DESCRIPTION };
  const advertised: Json = { ...properties };
  if (name === 'function_get' || name === 'function_decompile') advertised['function_id'] = handle;
  if (name === 'function_decompile') {
    advertised['wait'] = {
      default: 'auto',
      anyOf: [{ type: 'boolean' }, { type: 'string', const: 'auto' }],
      description:
        '"auto" (default): return the result if it completes within seconds, else the durable job; true: await it; false: return the job',
    };
    advertised['detail'] = {
      default: 'text',
      type: 'string',
      enum: ['text', 'full'],
      description:
        '"text" (default): header + pseudocode, small. "full": structuredContent carries the complete envelope (emission mappings, evidence, inferences)',
    };
  }
  if (name === 'xrefs_get') {
    const target = targetSchema.safeParse(advertised['target']).data;
    if (target !== undefined)
      advertised['target'] = {
        ...target,
        oneOf: target.oneOf.map((option) =>
          jsonObject.safeParse(option.properties['kind']).data?.['const'] === 'entity'
            ? { ...option, properties: { ...option.properties, id: handle } }
            : option,
        ),
      };
  }
  return { ...core, properties: advertised };
}
