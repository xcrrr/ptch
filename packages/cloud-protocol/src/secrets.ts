/**
 * Paths that must not leave a developer machine in a workspace upload. Matching is by path only
 * (contents are never inspected); it errs on the side of leaving files out, and the upload
 * preview lists every excluded path so nothing disappears silently.
 */

const SECRET_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.dockercfg',
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'authorized_keys',
  'known_hosts',
  '.htpasswd',
  'terraform.tfstate',
  'wp-config.php',
  // Credential files of common tools and shells.
  '_netrc',
  '.pgpass',
  '.my.cnf',
  '.s3cfg',
  '.boto',
  '.dev.vars',
  '.envrc',
  '.yarnrc.yml',
  'kubeconfig',
  'wallet.dat',
  'token.txt',
  'tokens.txt',
  // Shell and client histories routinely contain pasted secrets.
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.psql_history',
  '.mysql_history',
  '.node_repl_history',
  '.sqlite_history',
  '.rediscli_history',
]);

/** Name patterns for key material that is not a source file (see SOURCE_EXTENSIONS). */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^gcp-key.*\.json$/,
  /service-account.*\.json$/,
  /^kubeconfig[._-]/,
  /^(api[_-]?key|apikey)([._-]|$)/,
];

const SECRET_EXTENSIONS = new Set([
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'ppk',
  'kdbx',
  'tfstate',
  'tfvars',
  'gpg',
  'asc',
  'token',
]);

/** Source and documentation files are not secrets because of their name (credentials.ts). */
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'php',
  'cs',
  'md',
  'mdx',
]);

/** Directories whose contents are credentials or machine-local state. */
const SECRET_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gcloud',
]);

/** Why a path counts as secret, or null when it is fine to upload. */
export function secretPathReason(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  const base = (parts.at(-1) ?? '').toLowerCase();

  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) {
    // Templates are meant to be shared.
    if (/\.(example|sample|template|dist)$/.test(base)) return null;
    return 'environment file';
  }
  if (SECRET_BASENAMES.has(base)) return 'credential file';
  const dot = base.lastIndexOf('.');
  if (dot > 0 && SECRET_EXTENSIONS.has(base.slice(dot + 1))) return 'key or certificate file';
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = (parts[i] ?? '').toLowerCase();
    if (SECRET_DIRS.has(dir)) return `inside ${dir}`;
    if (dir === '.config' && (parts[i + 1] ?? '').toLowerCase() === 'gcloud')
      return 'inside .config/gcloud';
    if (dir === '.config' && (parts[i + 1] ?? '').toLowerCase() === 'gh' && base === 'hosts.yml')
      return 'GitHub CLI credentials';
  }
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  if (!SOURCE_EXTENSIONS.has(ext) && SECRET_NAME_PATTERNS.some((pattern) => pattern.test(base))) {
    return 'name suggests a secret';
  }
  if (
    !SOURCE_EXTENSIONS.has(ext) &&
    /(^|[._-])(secret|secrets|credential|credentials|private[._-]?key)([._-]|$)/.test(base)
  ) {
    return 'name suggests a secret';
  }
  return null;
}

export function isSecretPath(path: string): boolean {
  return secretPathReason(path) !== null;
}
