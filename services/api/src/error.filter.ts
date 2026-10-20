import { randomUUID } from 'node:crypto';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@resolvehub/contracts';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { GqlArgumentsHost } from '@nestjs/graphql';
import type { GraphqlContext } from './auth/context.js';
import { ApiFault } from './application/fault.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const graphql = host.getType<string>() === 'graphql';
    const response = graphql
      ? GqlArgumentsHost.create(host).getContext<GraphqlContext>().res
      : host.switchToHttp().getResponse<Response>();
    const parserError = z
      .object({ status: z.union([z.literal(400), z.literal(413)]) })
      .safeParse(exception);
    const status =
      exception instanceof ApiFault
        ? exception.statusCode
        : exception instanceof z.ZodError
          ? 400
          : exception instanceof HttpException
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
    const [defaultCode, defaultMessage] = messages[status] ?? [
      'INTERNAL_ERROR',
      'Request could not be completed.',
    ];
    const code = exception instanceof ApiFault ? exception.code : defaultCode;
    const message = exception instanceof ApiFault ? exception.message : defaultMessage;
    const details =
      exception instanceof ApiFault
        ? exception.details
        : exception instanceof z.ZodError
          ? {
              fields: exception.issues
                .slice(0, 20)
                .map((issue) => ({ path: issue.path.join('.'), rule: issue.code })),
            }
          : undefined;
    if (status >= 500) this.logger.error({ code, requestId });
    const body: ApiError = { code, message, requestId, ...(details ? { details } : {}) };
    if (graphql) throw new GraphQLError(message, { extensions: { ...body, httpStatus: status } });
    if (status === 401) {
      const request = host.switchToHttp().getRequest<{ path: string }>();
      response.setHeader(
        'WWW-Authenticate',
        request.path.startsWith('/v1/webhooks/') ? 'HMAC realm="ResolveHub webhooks"' : 'Bearer',
      );
    }
    response.status(status).json(body);
  }
}
