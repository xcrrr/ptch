import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession, isExpired, refreshSession } from '../src/auth/session.js';
import { isValidToken } from '../src/auth/token-store.js';

test('a new session is not expired', () => {
  const session = createSession('u1', 1000);
  assert.equal(isExpired(session, 1000), false);
});

test('a session is expired exactly at its expiry time', () => {
  const session = createSession('u1', 0);
  assert.equal(isExpired(session, session.expiresAt), true);
});

test('refreshing rotates the token', async () => {
  const session = createSession('u2', 0);
  const before = session.token;
  await refreshSession(session, 10);
  assert.notEqual(session.token, before);
  assert.equal(isValidToken(before), false);
  assert.equal(isValidToken(session.token), true);
});
