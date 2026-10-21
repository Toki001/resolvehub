import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { MutationReceipt } from '@resolvehub/db';
import { AuthGuard } from '../auth/auth.guard.js';
import { identityOf } from '../auth/context.js';
import type { ApiRequest } from '../auth/context.js';
import { ContractValidator } from '../application/validator.js';
import { SupportService } from '../application/support.service.js';

function send(response: Response, receipt: MutationReceipt) {
  response.status(receipt.status);
  if (receipt.location) response.setHeader('Location', receipt.location);
  return receipt.body;
}

@Controller('v1')
@UseGuards(AuthGuard)
export class SupportController {
  constructor(
    @Inject(SupportService) private readonly support: SupportService,
    @Inject(ContractValidator) private readonly validator: ContractValidator,
  ) {}

  @Get('me') me(@Req() request: ApiRequest) {
    return identityOf(request);
  }

  @Post('documents/uploads')
  async upload(
    @Req() request: ApiRequest,
    @Headers('idempotency-key') key: unknown,
    @Headers('x-document-type') mediaType: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.upload(identityOf(request), request.requestId, key, input, mediaType),
    );
  }
  @Post('drafts/:id/edits')
  async edit(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.editDraft(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
        this.validator.validate('EditDraftInput', input),
      ),
    );
  }
  @Post('tickets/:id/status')
  async status(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.changeTicketStatus(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
        this.validator.validate('ChangeTicketStatusInput', input),
      ),
    );
  }
  @Post('tickets/:id/messages')
  async message(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.customerMessage(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
        this.validator.validate('CustomerMessageInput', input),
      ),
    );
  }

  @Post('tickets')
  async createTicket(
    @Req() request: ApiRequest,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.createTicket(
        identityOf(request),
        request.requestId,
        key,
        this.validator.validate('CreateTicketInput', input),
      ),
    );
  }

  @Post('documents/ingestions')
  async ingest(
    @Req() request: ApiRequest,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.ingestion(
        identityOf(request),
        request.requestId,
        key,
        this.validator.validate('IngestionInput', input),
      ),
    );
  }

  @Post('documents/:id/versions')
  async version(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.ingestion(
        identityOf(request),
        request.requestId,
        key,
        this.validator.validate('DocumentVersionInput', input),
        z.uuid().parse(id).toLowerCase(),
      ),
    );
  }
  @Get('jobs/:id/failure')
  failure(@Req() request: ApiRequest, @Param('id') id: string) {
    return this.support.failure(identityOf(request), z.uuid().parse(id).toLowerCase());
  }

  @Post('tickets/:id/drafts')
  async draft(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    z.object({})
      .strict()
      .parse(input ?? {});
    return send(
      response,
      await this.support.requestDraft(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
      ),
    );
  }

  @Get('jobs/:id')
  job(@Req() request: ApiRequest, @Param('id') id: string) {
    return this.support.job(identityOf(request), z.uuid().parse(id).toLowerCase());
  }

  @Post('jobs/:id/replay')
  async replay(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    z.object({})
      .strict()
      .parse(input ?? {});
    return send(
      response,
      await this.support.replay(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
      ),
    );
  }

  @Post('drafts/:id/approve')
  async approve(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.review(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
        'approve',
        this.validator.validate('ApproveDraftInput', input),
      ),
    );
  }

  @Post('drafts/:id/reject')
  async reject(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return send(
      response,
      await this.support.review(
        identityOf(request),
        request.requestId,
        key,
        z.uuid().parse(id).toLowerCase(),
        'reject',
        this.validator.validate('RejectDraftInput', input),
      ),
    );
  }
}
