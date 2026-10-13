import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithRetry } from '../src/http/client.js';

test('retries until the call succeeds', async () => {
  let calls = 0;
  const result = await fetchWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});
