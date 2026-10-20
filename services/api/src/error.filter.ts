import { randomUUID } from 'node:crypto';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@resolvehub/contracts';
import { z } from 'zod';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const parserError = z
      .object({ status: z.union([z.literal(400), z.literal(413)]) })
      .safeParse(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : parserError.success
          ? parserError.data.status
          : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = String(response.getHeader('X-Request-ID') ?? randomUUID());
    const messages: Record<number, [string, string]> = {
      400: ['INVALID_INPUT', 'Request is invalid.'],
      401: ['UNAUTHENTICATED', 'Authentication is required.'],
      403: ['FORBIDDEN', 'Access is denied.'],
      404: ['NOT_FOUND', 'Resource was not found.'],
      409: ['CONFLICT', 'Request conflicts with the current state.'],
      413: ['PAYLOAD_TOO_LARGE', 'Request exceeds the size limit.'],
      429: ['CAPACITY_EXCEEDED', 'Please try again later.'],
      503: ['DEPENDENCY_UNAVAILABLE', 'A required service is unavailable.'],
    };
    const [code, message] = messages[status] ?? [
      'INTERNAL_ERROR',
      'Request could not be completed.',
    ];
    if (status >= 500) this.logger.error({ code, requestId });
    const body: ApiError = { code, message, requestId };
    response.status(status).json(body);
  }
}
