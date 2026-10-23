import { z } from 'zod';

// Missing numbers become NaN once coerce runs, so defaults have to be applied
// before that. An empty string is treated as missing; a bad string still fails.
function intEnv(opts: { fallback?: number; min: number; max: number }) {
  return z.preprocess((value) => {
    if ((value === undefined || value === '') && opts.fallback !== undefined) {
      return opts.fallback;
    }
    return value;
  }, z.coerce.number().int().min(opts.min).max(opts.max));
}

export const envSchema = z
  .object({
    PORT: intEnv({ fallback: 3000, min: 1, max: 65535 }),
    MONGO_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI'),
    RAW_DB: z.preprocess(
      (value) => (value === undefined || value === '' ? 'provider_raw' : value),
      z.string().min(1),
    ),
    DOMAIN_DB: z.preprocess(
      (value) => (value === undefined || value === '' ? 'provider_domain' : value),
      z.string().min(1),
    ),
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: intEnv({ min: 1, max: 65535 }),
    BATCH_SIZE: intEnv({ fallback: 25, min: 1, max: 500 }),
    WORKER_CONCURRENCY: intEnv({ fallback: 4, min: 1, max: 32 }),
    JOB_ATTEMPTS: intEnv({ fallback: 5, min: 1, max: 10 }),
    JOB_BACKOFF_MS: intEnv({ fallback: 1000, min: 100, max: 60_000 }),
    PROVIDER: z.preprocess(
      (value) => (value === undefined || value === '' ? 'xbyte' : value),
      z.string().min(1),
    ),
  })
  .refine((value) => value.RAW_DB !== value.DOMAIN_DB, {
    message: 'RAW_DB and DOMAIN_DB must be different databases',
    path: ['DOMAIN_DB'],
  });

export type Env = z.infer<typeof envSchema>;

export function formatEnvError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
