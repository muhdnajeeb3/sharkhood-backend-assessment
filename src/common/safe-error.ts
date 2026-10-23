/** Mongo driver errors can echo the connection string. Keep that out of logs and run records. */
export function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://redacted').slice(0, 500);
}
