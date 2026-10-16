import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { budgetSchema, DEFAULT_BUDGET } from '../../core/index.js';
import { containsPath } from '../../workers/paths.js';

const absolutePath = z.string().min(1).max(32768).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute local path');
const authority = z.string().min(1).max(255).refine(value => {
  try { const url = new URL(`https://${value}`); return url.host === value && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, 'Expected a canonical host authority, including a nondefault port');
const origin = z.string().max(512).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value; }
  catch { return false; }
}, 'Expected an exact nonopaque HTTP origin');

/** Operator-only configuration. Tool arguments cannot change any of these limits. */
export const httpConfigSchema = z.strictObject({
  host: z.string().refine(value => isIP(value) !== 0, 'Bind an explicit IP literal').default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(3000),
  allowed_hosts: z.array(authority).min(1).max(32).optional(),
  allowed_origins: z.array(origin).max(32).default([]),
  tls: z.strictObject({ cert_path: absolutePath, key_path: absolutePath }).optional(),
  limits: z.strictObject({
    max_connections: z.number().int().min(1).max(1024).default(64),
    max_requests: z.number().int().min(1).max(256).default(32),
    requests_per_minute: z.number().int().min(1).max(100000).default(600),
    header_bytes: z.number().int().min(1024).max(32768).default(8192),
    header_count: z.number().int().min(8).max(128).default(32),
    request_timeout_ms: z.number().int().min(100).max(600000).default(60000),
    body_timeout_ms: z.number().int().min(100).max(60000).default(10000),
    idle_timeout_ms: z.number().int().min(100).max(60000).default(10000),
  }).default({ max_connections: 64, max_requests: 32, requests_per_minute: 600, header_bytes: 8192, header_count: 32, request_timeout_ms: 60000, body_timeout_ms: 10000, idle_timeout_ms: 10000 }),
  principals: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    project_root: absolutePath,
    input_roots: z.array(absolutePath).min(1).max(32),
    max_workers: z.number().int().min(1).max(8).default(2),
    max_queued: z.number().int().min(0).max(64).default(8),
    max_requests: z.number().int().min(1).max(8).default(8),
    requests_per_minute: z.number().int().min(1).max(10000).default(120),
    work_admissions_per_minute: z.number().int().min(1).max(1000).default(60),
    max_work_admissions: z.number().int().min(1).max(1000000).default(10000),
    max_budget: budgetSchema.default(DEFAULT_BUDGET),
  })).min(1).max(32),
});
export type HttpConfig = z.input<typeof httpConfigSchema>;
export type ResolvedHttpConfig = z.output<typeof httpConfigSchema>;

export async function readBoundedLocalFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Configuration and TLS material must be regular files');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error('Local configuration file exceeds its byte limit');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function loadHttpConfig(path: string): Promise<HttpConfig> {
  absolutePath.parse(path);
  return httpConfigSchema.parse(JSON.parse((await readBoundedLocalFile(path, 262144)).toString('utf8')));
}

export async function resolveHttpConfig(input: HttpConfig): Promise<ResolvedHttpConfig> {
  const config = httpConfigSchema.parse(input);
  const loopback = config.host === '::1' || /^127\./.test(config.host);
  if (!loopback && !config.tls) throw new Error('Non-loopback binding requires native TLS');
  if (config.allowed_origins.some(value => !loopback && !value.startsWith('https://'))) throw new Error('Remote origins require HTTPS');
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const principal of config.principals) {
    if (ids.has(principal.id) || hashes.has(principal.token_sha256)) throw new Error('Principal identities and bearer hashes must be unique');
    ids.add(principal.id); hashes.add(principal.token_sha256);
    principal.project_root = await realpath(principal.project_root);
    principal.input_roots = await Promise.all(principal.input_roots.map(path => realpath(path)));
    for (const path of [principal.project_root, ...principal.input_roots]) {
      if (!(await stat(path)).isDirectory()) throw new Error('Provision existing project and input directories');
    }
  }
  for (const owner of config.principals) {
    for (const other of config.principals) {
      const roots = owner === other ? other.input_roots : [other.project_root, ...other.input_roots];
      if (roots.some(root => containsPath(owner.project_root, root) || containsPath(root, owner.project_root))) {
        throw new Error('Project roots must be private and disjoint from every input root');
      }
    }
  }
  return config;
}
