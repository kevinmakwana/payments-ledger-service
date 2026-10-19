import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { currentContext } from './request-context';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
};
const codeFor = (status: number) => CODES[status] ?? `http_${status}`;

/**
 * One error shape for everything: `{ statusCode, code, message, requestId, ...extra }`. Domain exceptions keep the
 * `code` and any extra fields they were thrown with. Anything unexpected becomes an opaque 500: the real cause goes to
 * the log (with stack and request id), never to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentContext()?.requestId ?? (res.getHeader('X-Request-Id') as string | undefined);

    let status = 500;
    let body: Record<string, unknown>;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const raw = exception.getResponse();
      const obj = typeof raw === 'string' ? { message: raw } : (raw as Record<string, unknown>);
      body = { ...obj, statusCode: status, code: obj.code ?? codeFor(status), message: obj.message ?? exception.message };
    } else if (isHttpError(exception)) {
      // Errors raised by express middleware such as body-parser (413 entity.too.large, 400 invalid JSON).
      status = exception.status ?? exception.statusCode ?? 500;
      body = { statusCode: status, code: exception.type === 'entity.too.large' ? 'payload_too_large' : codeFor(status), message: exception.message };
    } else {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(err.message, err.stack);
      body = { statusCode: 500, code: 'internal_error', message: 'Internal server error' };
    }
    if (status >= 500 && !(status === 500 && body.code === 'internal_error')) {
      this.logger.error(`${status} ${String(body.code)}: ${String(body.message)}`);
    }
    res.status(status).json({ ...body, requestId });
  }
}

function isHttpError(e: unknown): e is { status?: number; statusCode?: number; type?: string; message: string } {
  if (!e || typeof e !== 'object') return false;
  const o = e as { status?: unknown; statusCode?: unknown };
  const status = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : 0;
  return status >= 400 && status < 600;
}
