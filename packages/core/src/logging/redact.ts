const REDACTED = '[REDACTED]';

/** Characters of a bearer token (RFC 6750 b64token, plus `_`). */
const TOKEN_CHAR = String.raw`[A-Za-z0-9._~+/-]`;

/**
 * JSON field names that hold credentials: api_key/apiKey/x-api-key, auth/access/refresh tokens,
 * token, secret/client_secret, password, authorization — optionally prefixed
 * (`anthropic_api_key`, `githubToken`). The prefix is bounded so long quoted runs stay cheap.
 */
const SECRET_FIELD = String.raw`[A-Za-z0-9]{0,40}[_-]?(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token|authorization)`;

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Anthropic keys and tokens: sk-ant-api03-…, sk-ant-oat01-…
  [/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  // Other sk-… keys. Requiring a digit keeps hyphenated words like "sk-learn-…" intact.
  [/(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Bearer tokens: long ones, or shorter ones containing a non-letter (so prose stays intact).
  [
    new RegExp(
      String.raw`\b(Bearer\s+)(?:${TOKEN_CHAR}{16,}|(?=${TOKEN_CHAR}*[0-9._~+/-])${TOKEN_CHAR}{6,})=*`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // x-api-key header values, bare or quoted (`x-api-key: …`, `'x-api-key': '…'`).
  [/(\bx-api-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, `$1${REDACTED}`],
  // Credential-named JSON string fields, in plain JSON and in JSON embedded in a JSON string.
  [new RegExp(String.raw`("${SECRET_FIELD}"\s*:\s*")(?:[^"\\]|\\.)+(")`, 'gi'), `$1${REDACTED}$2`],
  [
    new RegExp(String.raw`(\\"${SECRET_FIELD}\\"\s*:\s*\\")(?:[^"\\]|\\[^"])+(\\")`, 'gi'),
    `$1${REDACTED}$2`,
  ],
  // Environment-style assignments such as ANTHROPIC_API_KEY=… or GITHUB_TOKEN=…
  [/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)=)[^\s"']+/g, `$1${REDACTED}`],
  // The same in any case and in URLs or config lines: password=…, passwd=…, secret=…, token=…,
  // api_key=…, optionally prefixed (db_password=…). The name must end right before the `=`, so
  // MAX_TOKENS=4096 and "tokens=3" stay readable. The value may be quoted.
  [
    /(?<![A-Za-z0-9])((?:[A-Za-z0-9]{1,30}[_-]){0,3}(?:password|passwd|secret|token|api[_-]?key)=)(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&;,}]+)/gi,
    `$1${REDACTED}`,
  ],
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // AWS access key ids (long-term AKIA…, temporary ASIA…).
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, REDACTED],
  // Slack tokens: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-.
  [/(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // PEM private keys, whole block; a block that is cut off loses everything after its header.
  [
    /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]{0,30}PRIVATE KEY-----|[\s\S]*$)/g,
    REDACTED,
  ],
  // Patch's own credentials: API tokens (pct_), device access/refresh tokens (pat_, prt_), browser
  // sessions (phq_), authorization codes (pac_) and task tokens for the model proxy (ptk.…).
  [/(?<![A-Za-z0-9])(?:pct|pat|prt|phq|pac)_[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/(?<![A-Za-z0-9])ptk\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

/**
 * Replaces credentials with `[REDACTED]`: Anthropic keys (`sk-ant-...`), generic `sk-...` keys,
 * `Bearer <token>`, `x-api-key: ...` header values, and JSON fields named like
 * api_key/apiKey/authorization/token/secret/password.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  return result;
}
