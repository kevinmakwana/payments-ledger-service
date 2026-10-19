import { formatLogLine } from './log-format';

const base = { now: new Date('2026-10-20T10:00:00.000Z') };

describe('formatLogLine', () => {
  it('emits one JSON object per line with level, context and message', () => {
    const line = formatLogLine({ ...base, level: 'info', message: 'Listening', context: 'Bootstrap' });
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ ts: '2026-10-20T10:00:00.000Z', level: 'info', context: 'Bootstrap', msg: 'Listening' });
  });

  it('adds the request and trace ids when a request context is active', () => {
    const parsed = JSON.parse(formatLogLine({ ...base, level: 'warn', message: 'slow', ctx: { requestId: 'r1', traceId: 't1', spanId: 's1' } }));
    expect(parsed).toMatchObject({ requestId: 'r1', traceId: 't1' });
    expect(parsed).not.toHaveProperty('spanId');
  });

  it('serializes object messages and keeps the stack of errors separate from the message', () => {
    expect(JSON.parse(formatLogLine({ ...base, level: 'info', message: { event: 'x', n: 1 } })).msg).toEqual({ event: 'x', n: 1 });
    const parsed = JSON.parse(formatLogLine({ ...base, level: 'error', message: 'boom', stack: 'Error: boom\n    at foo' }));
    expect(parsed).toMatchObject({ msg: 'boom', stack: 'Error: boom\n    at foo' });
  });

  it('merges structured fields without letting them overwrite the core ones', () => {
    const parsed = JSON.parse(formatLogLine({ ...base, level: 'info', message: 'http_request', fields: { status: 200, level: 'hacked', msg: 'hacked' } }));
    expect(parsed).toMatchObject({ status: 200, level: 'info', msg: 'http_request' });
  });
});
