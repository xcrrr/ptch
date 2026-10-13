import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/logging/logger.js';

describe('redactSecrets', () => {
  const redacted: Array<[string, string, string]> = [
    ['Anthropic API key', 'key: sk-ant-api03-AbCdEf_123-xyz789AbCdEf', 'key: [REDACTED]'],
    ['Anthropic OAuth token', 'token=sk-ant-oat01-abcdefABCDEF0123', 'token=[REDACTED]'],
    ['Anthropic key after an underscore', 'VALUE_sk-ant-api03-abc', 'VALUE_[REDACTED]'],
    [
      'generic sk- key',
      'OPENAI key sk-proj-1234567890abcdefghijKLMNOP done',
      'OPENAI key [REDACTED] done',
    ],
    [
      'bearer token (JWT)',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      'Authorization: Bearer [REDACTED]',
    ],
    [
      'bearer token, lower case',
      'authorization: bearer abc123def456',
      'authorization: bearer [REDACTED]',
    ],
    ['long all-letter bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz', 'Bearer [REDACTED]'],
    ['x-api-key header', 'x-api-key: abc123', 'x-api-key: [REDACTED]'],
    ['X-Api-Key header, any case', 'X-Api-Key:abc123;next', 'X-Api-Key:[REDACTED];next'],
    ['x-api-key as a JS object key', "{ 'x-api-key': 'abc123' }", "{ 'x-api-key': '[REDACTED]' }"],
    ['x-api-key JSON field', '{"x-api-key":"abc123"}', '{"x-api-key":"[REDACTED]"}'],
    ['api_key JSON field', '{"api_key":"v"}', '{"api_key":"[REDACTED]"}'],
    ['apiKey JSON field', '{"apiKey": "v"}', '{"apiKey": "[REDACTED]"}'],
    [
      'authorization JSON field',
      '{"Authorization":"Basic dXNlcjpwYXNz"}',
      '{"Authorization":"[REDACTED]"}',
    ],
    ['auth_token JSON field', '{"auth_token":"v"}', '{"auth_token":"[REDACTED]"}'],
    ['authToken JSON field', '{"authToken":"v"}', '{"authToken":"[REDACTED]"}'],
    ['token JSON field', '{"token":"v"}', '{"token":"[REDACTED]"}'],
    ['secret JSON field', '{"secret":"v"}', '{"secret":"[REDACTED]"}'],
    ['password JSON field', '{"password":"p\\"q"}', '{"password":"[REDACTED]"}'],
    ['client_secret JSON field', '{"client_secret":"v"}', '{"client_secret":"[REDACTED]"}'],
    [
      'prefixed credential fields',
      '{"anthropic_api_key":"v","githubToken":"w"}',
      '{"anthropic_api_key":"[REDACTED]","githubToken":"[REDACTED]"}',
    ],
    [
      'JSON embedded in a JSON string',
      '{"body":"{\\"api_key\\":\\"v1\\",\\"n\\":1}"}',
      '{"body":"{\\"api_key\\":\\"[REDACTED]\\",\\"n\\":1}"}',
    ],
    [
      'environment assignment',
      'env GITHUB_TOKEN=ghp_abc123 ANTHROPIC_API_KEY=xyz',
      'env GITHUB_TOKEN=[REDACTED] ANTHROPIC_API_KEY=[REDACTED]',
    ],
    [
      'lower-case password assignment',
      'mysql://u@h/db?password=hunter2&x=1',
      'mysql://u@h/db?password=[REDACTED]&x=1',
    ],
    ['passwd assignment', 'passwd=abc123 next', 'passwd=[REDACTED] next'],
    [
      'prefixed lower-case token',
      'db_secret=abc token=xyz',
      'db_secret=[REDACTED] token=[REDACTED]',
    ],
    ['quoted assignment', 'password="two words" tail', 'password=[REDACTED] tail'],
    ['api_key assignment', 'api_key=abcd api-key=efgh', 'api_key=[REDACTED] api-key=[REDACTED]'],
    [
      'GitHub token',
      `x ghp_${'A1b2'.repeat(9)} y gho_${'z'.repeat(36)}`,
      'x [REDACTED] y [REDACTED]',
    ],
    ['GitHub fine-grained token', `github_pat_${'A1_b'.repeat(15)}`, '[REDACTED]'],
    [
      'AWS access key id',
      'id AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE',
      'id [REDACTED] and [REDACTED]',
    ],
    ['Slack token', 'xoxb-123456789012-abcdefABCDEF', '[REDACTED]'],
    [
      'PEM private key',
      'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nb',
      'a\n[REDACTED]\nb',
    ],
    ['PEM key without an end', 'k -----BEGIN PRIVATE KEY-----\nMIIEow\nabc', 'k [REDACTED]'],
    [
      "Patch's own tokens",
      `pct_${'a'.repeat(43)} pat_${'B'.repeat(43)} prt_${'c-d_'.repeat(11)} phq_${'e'.repeat(43)} pac_${'f'.repeat(43)}`,
      '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    ],
    [
      'proxy task token',
      'ANTHROPIC_API_KEY is ptk.eyJ0YXNrSWQiOjF9.c2lnbmF0dXJlMTIz',
      'ANTHROPIC_API_KEY is [REDACTED]',
    ],
  ];

  it.each(redacted)('redacts %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  const untouched: Array<[string, string]> = [
    ['ordinary prose', 'The bearer of this letter is trusted with the token budget.'],
    ['a short bearer word', 'Bearer bonds are rare.'],
    ['hyphenated words starting with sk-', 'We use sk-learn-is-a-great-library-for-ml here.'],
    ['words containing sk-ant-', 'Our task-ant-colony simulation and desk-anthology.'],
    ['a bare key prefix in documentation', 'Anthropic keys start with sk-ant-...'],
    ['token counts', '{"max_tokens":64000,"inputTokens":12,"cacheReadTokens":0}'],
    ['non-string credential-like fields', '{"token":null,"secret":false,"password":0}'],
    ['empty credential values', '{"apiKey":"","token":""}'],
    ['similar field names', '{"tokenizer":"bpe","secretary":"Ann","passwordHint":"pet"}'],
    ['setting names in prose', 'Set ANTHROPIC_API_KEY or edit the apiKey setting.'],
    ['token count variables', 'MAX_TOKENS=4096 PATCH_DEBUG=1'],
    ['plural and compound names', 'max_tokens=100 tokens=3 secretary=Ann token_count=5'],
    ['a public key block', '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'],
    [
      'names that only look like Patch tokens',
      'pct_short pat_ phq_x and spat_abcdefghijklmnopqrstuvwxyz0123',
    ],
    ['a short ghp_ word', 'ghp_ is the prefix of GitHub tokens'],
  ];

  it.each(untouched)('leaves %s unchanged', (_name, input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = redactSecrets('Bearer abc.def {"apiKey":"k"} sk-ant-xyz x-api-key: q');
    expect(redactSecrets(once)).toBe(once);
  });

  it('stays fast on 20k characters built to be slow for naive patterns', () => {
    const hostile = [
      'a_'.repeat(10_000),
      'password'.repeat(2_500),
      'token='.repeat(3_300),
      '-----BEGIN PRIVATE KEY-----'.repeat(700),
      'ghp_'.repeat(5_000),
      'xoxb-'.repeat(4_000),
      'pct_'.repeat(5_000),
      'Bearer '.repeat(2_800),
      'A'.repeat(20_000),
      'secret_'.repeat(2_800),
    ];
    for (const input of hostile) {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(250);
    }
  });

  it('stays fast on long lines without secrets', () => {
    const line = `{"items":[${Array.from({ length: 2_000 }, () => `"${'a'.repeat(500)}"`).join(',')}]}`;
    const started = performance.now();
    expect(redactSecrets(line)).toBe(line);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
