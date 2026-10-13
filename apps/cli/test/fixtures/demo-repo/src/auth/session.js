import { config } from '../config.js';
import { issueToken, revokeToken } from './token-store.js';

export function createSession(userId, now = Date.now()) {
  return {
    userId,
    token: issueToken(userId),
    expiresAt: now + config.SESSION_TTL_MS,
  };
}

/** A session is expired once the current time reaches its expiry time. */
export function isExpired(session, now = Date.now()) {
  return now > session.expiresAt;
}

export async function refreshSession(session, now = Date.now()) {
  revokeToken(session.token);
  session.token = issueToken(session.userId);
  session.expiresAt = now + config.SESSION_TTL_MS;
  return session;
}
