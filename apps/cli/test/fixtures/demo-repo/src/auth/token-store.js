const tokens = new Map();
let counter = 0;

export function issueToken(userId) {
  counter += 1;
  const token = `tok_${userId}_${counter}`;
  tokens.set(token, { userId, issuedAt: Date.now() });
  return token;
}

export function revokeToken(token) {
  tokens.delete(token);
}

export function isValidToken(token) {
  return tokens.has(token);
}
