import { z } from 'zod';

export const memoryFactsSchema = z.strictObject({
  rss_bytes: z.number().nonnegative(),
  heap_total_bytes: z.number().nonnegative(),
  heap_used_bytes: z.number().nonnegative(),
  external_bytes: z.number().nonnegative(),
  array_buffers_bytes: z.number().nonnegative(),
  lifetime_max_rss_bytes: z.number().nonnegative().nullable(),
});
export type MemoryFacts = z.output<typeof memoryFactsSchema>;

/** Node reports maxRSS in KiB, including on macOS. Windows reports zero when unavailable. */
export function memoryFacts(): MemoryFacts {
  const usage = process.memoryUsage();
  const maximum = process.resourceUsage().maxRSS;
  return {
    rss_bytes: usage.rss,
    heap_total_bytes: usage.heapTotal,
    heap_used_bytes: usage.heapUsed,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
    lifetime_max_rss_bytes: maximum > 0 ? maximum * 1024 : null,
  };
}

export const workerMemorySchema = z.strictObject({
  pid: z.number().int().positive(),
  job_id: z.string().nullable(),
  phase: z.string(),
  uptime_ms: z.number().nonnegative(),
  memory: memoryFactsSchema,
});
export type WorkerMemory = z.output<typeof workerMemorySchema>;
export const explicitGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
