import { envSchema } from '../../src/config/env.schema';

const base = {
  MONGO_URI: 'mongodb://127.0.0.1:27017',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
};

describe('env schema', () => {
  it('fills the defaults and coerces numbers', () => {
    const env = envSchema.parse(base);
    expect(env.PORT).toBe(3000);
    expect(env.BATCH_SIZE).toBe(25);
    expect(env.PROVIDER).toBe('xbyte');
    expect(env.RAW_DB).toBe('provider_raw');
    expect(env.DOMAIN_DB).toBe('provider_domain');
    expect(env.REDIS_PORT).toBe(6379);
  });

  it('refuses a URI that is not Mongo and refuses the same database twice', () => {
    expect(envSchema.safeParse({ ...base, MONGO_URI: 'postgres://localhost/app' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, RAW_DB: 'same', DOMAIN_DB: 'same' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, BATCH_SIZE: '0' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, REDIS_HOST: '' }).success).toBe(false);
  });
});
