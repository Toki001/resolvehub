import { Injectable } from '@nestjs/common';
import type { Actor, TenantRepository } from '@resolvehub/db';

export const REPLY_DELIVERY = Symbol('REPLY_DELIVERY');
// Stage delivery in the caller's transaction. Future adapters must stage an
// outbox entry, never perform external I/O before that transaction commits.
export interface ReplyDelivery {
  readonly channel: string;
  stage(repository: TenantRepository, draftId: string, actor: Actor): Promise<void>;
}
@Injectable()
export class InternalReplyDelivery implements ReplyDelivery {
  readonly channel = 'internal';
  async stage(repository: TenantRepository, draftId: string, actor: Actor) {
    const messageId = await repository.recordApprovedReply(draftId);
    await repository.audit(actor, 'reply.recorded_internal', messageId);
  }
}
