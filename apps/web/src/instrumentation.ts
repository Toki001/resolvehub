import { parseWebEnv } from './lib/env';

export function register() {
  parseWebEnv(process.env);
}
