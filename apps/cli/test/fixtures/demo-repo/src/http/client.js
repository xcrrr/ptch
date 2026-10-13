import { config } from '../config.js';

export async function fetchWithRetry(fn, retries = config.RETRY_LIMIT) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < config.RETRY_LIMIT) {
        await new Promise((resolve) => setTimeout(resolve, config.RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}
