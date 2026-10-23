export interface FactoryLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export const jsonLogger: FactoryLogger = {
  info(fields) {
    console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), ...fields }));
  },
  error(fields) {
    console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), ...fields }));
  },
};
