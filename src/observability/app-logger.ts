import { LoggerService } from '@nestjs/common';
import { formatLogLine, LogInput } from './log-format';
import { currentContext } from './request-context';

type Level = LogInput['level'];
const ORDER: Record<Level, number> = { verbose: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

/**
 * Structured JSON logger for Nest (`app.useLogger` / the `logger` option). Every line carries the active request's
 * ids. A message that is an object with a string `msg` is logged with its other keys as structured fields, so call
 * sites can write `logger.log({ msg: 'http_request', status: 200 })`.
 */
export class AppLogger implements LoggerService {
  constructor(
    private readonly sink: (line: string) => void = (line) => void process.stdout.write(line + '\n'),
    private readonly minLevel: Level = 'info',
  ) {}

  log(message: unknown, ...rest: unknown[]) { this.write('info', message, rest); }
  warn(message: unknown, ...rest: unknown[]) { this.write('warn', message, rest); }
  error(message: unknown, ...rest: unknown[]) { this.write('error', message, rest); }
  fatal(message: unknown, ...rest: unknown[]) { this.write('fatal', message, rest); }
  debug(message: unknown, ...rest: unknown[]) { this.write('debug', message, rest); }
  verbose(message: unknown, ...rest: unknown[]) { this.write('verbose', message, rest); }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const strings = rest.filter((r): r is string => typeof r === 'string');
    let stack: string | undefined;
    let context: string | undefined;
    if (level === 'error' || level === 'fatal') {
      // Nest calls error(message, stack?, context?)
      stack = strings.find((s) => s.includes('\n    at '));
      context = strings.filter((s) => s !== stack).at(-1);
    } else {
      context = strings.at(-1);
    }
    let msg = message;
    let fields: Record<string, unknown> | undefined;
    if (message && typeof message === 'object' && !(message instanceof Error) && typeof (message as { msg?: unknown }).msg === 'string') {
      const { msg: inner, ...others } = message as { msg: string } & Record<string, unknown>;
      msg = inner;
      fields = others;
    } else if (message instanceof Error) {
      msg = message.message;
      stack = stack ?? message.stack;
    }
    this.sink(formatLogLine({ level, message: msg, context, stack, fields, ctx: currentContext() }));
  }
}
