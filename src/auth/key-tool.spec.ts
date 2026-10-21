import { parseApiKeys, authenticateStatic } from './api-keys';
import { run } from './key-tool';

describe('key-tool', () => {
  it('generates a key together with an API_KEYS entry that authenticates exactly that key', () => {
    const out = run(['generate', 'client']);
    const key = /: (plk_\S+)/.exec(out)![1];
    const entry = /API_KEYS entry: (\S+)/.exec(out)![1];
    expect(entry).toMatch(/^sha256:[0-9a-f]{64}:client$/);
    expect(out.split(entry).length).toBe(2); // the entry never contains the key
    expect(entry).not.toContain(key);
    expect(authenticateStatic(parseApiKeys(entry), key)).toMatchObject({ role: 'client' });
    expect(authenticateStatic(parseApiKeys(entry), key + 'x')).toBeUndefined();
  });

  it('defaults to admin and hashes an existing key on request', () => {
    expect(run([])).toContain(':admin');
    const out = run(['hash', 'sk_existing_0123456789abcdef', 'client']);
    expect(authenticateStatic(parseApiKeys(/API_KEYS entry: (\S+)/.exec(out)![1]), 'sk_existing_0123456789abcdef')).toMatchObject({ role: 'client' });
  });

  it.each([[['generate', 'root']], [['hash']], [['bogus']]])('refuses bad input %j', (argv) => {
    expect(() => run(argv)).toThrow();
  });
});
