import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiRequest } from '../auth/context.js';
import { WebhookAuthService } from '../auth/webhook-auth.service.js';
import { ContractValidator } from '../application/validator.js';
import { SupportService } from '../application/support.service.js';

@Controller('v1/webhooks')
export class WebhookController {
  constructor(
    @Inject(WebhookAuthService) private readonly auth: WebhookAuthService,
    @Inject(ContractValidator) private readonly validator: ContractValidator,
    @Inject(SupportService) private readonly support: SupportService,
  ) {}

  @Post('tickets')
  async receive(@Req() request: ApiRequest, @Res({ passthrough: true }) response: Response) {
    const integration = await this.auth.authenticate(request.headers, request.rawBody);
    const validated = this.validator.validate('WebhookTicketInput', request.body);
    const input = { ...validated, eventId: validated.eventId.toLowerCase() };
    const receipt = await this.support.webhook(
      {
        organizationId: integration.organizationId,
        actorId: integration.id,
        actorKind: 'integration',
        requestId: request.requestId,
      },
      integration.id,
      input,
    );
    response.status(receipt.status);
    if (receipt.location) response.setHeader('Location', receipt.location);
    return receipt.body;
  }
}
