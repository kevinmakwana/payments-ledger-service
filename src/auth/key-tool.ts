import { generateToken, hashToken, Role } from './api-keys';

/**
 * Small operator CLI for the bootstrap keys in API_KEYS, so the secret itself need not sit in an environment file:
 *
 *   npm run key:generate                       a new random key, plus the sha256 entry to put in API_KEYS
 *   npm run key:generate -- generate client    same, for the client role
 *   npm run key:generate -- hash <key> [role]  the sha256 entry for a key you already have
 *
 * (In a built image: `node dist/auth/key-tool.js ...`.)
 */
export function run(argv: string[]): string {
  const [command = 'generate', ...rest] = argv;
  const entry = (key: string, role: string) => `sha256:${hashToken(key).toString('hex')}:${role}`;
  const asRole = (r: string | undefined): Role => {
    if (r === undefined) return 'admin';
    if (r !== 'admin' && r !== 'client') throw new Error(`role must be admin or client (got "${r}")`);
    return r;
  };
  if (command === 'generate') {
    const role = asRole(rest[0]);
    const key = generateToken();
    return `key (shown once, keep it secret): ${key}\nAPI_KEYS entry: ${entry(key, role)}`;
  }
  if (command === 'hash') {
    if (!rest[0]) throw new Error('usage: hash <key> [role]');
    return `API_KEYS entry: ${entry(rest[0], asRole(rest[1]))}`;
  }
  throw new Error('usage: generate [role] | hash <key> [role]');
}

if (require.main === module) {
  try {
    process.stdout.write(run(process.argv.slice(2)) + '\n');
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
