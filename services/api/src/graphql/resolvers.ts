import { Inject, UseGuards } from '@nestjs/common';
import { Args, Context, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { components } from '@resolvehub/generated';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { identityOf } from '../auth/context.js';
import type { GraphqlContext } from '../auth/context.js';
import { SupportService } from '../application/support.service.js';

@Resolver('Query')
@UseGuards(AuthGuard)
export class SupportResolver {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Query('tickets')
  tickets(
    @Context() context: GraphqlContext,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
    @Args('filter') filter: unknown,
  ) {
    return this.support.tickets(identityOf(context.req), first, after, filter);
  }
  @Query('ticket')
  ticket(@Context() context: GraphqlContext, @Args('id') id: string) {
    return this.support.ticket(identityOf(context.req), z.uuid().parse(id).toLowerCase());
  }
  @Query('knowledgeDocuments')
  documents(
    @Context() context: GraphqlContext,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
  ) {
    return this.support.documents(identityOf(context.req), first, after);
  }
  @Query('knowledgeSearch')
  search(
    @Context() context: GraphqlContext,
    @Args('query') query: string,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
  ) {
    return this.support.search(identityOf(context.req), query, first, after);
  }
  @Query('draft')
  draft(@Context() context: GraphqlContext, @Args('id') id: string) {
    return this.support.draft(identityOf(context.req), z.uuid().parse(id).toLowerCase());
  }
  @Query('dashboardSummary')
  summary(@Context() context: GraphqlContext) {
    return this.support.summary(identityOf(context.req));
  }
}

@Resolver('Ticket')
@UseGuards(AuthGuard)
export class TicketResolver {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @ResolveField('messages')
  messages(@Context() context: GraphqlContext, @Parent() ticket: components['schemas']['Ticket']) {
    return this.support.messages(identityOf(context.req), ticket.id);
  }
  @ResolveField('drafts')
  drafts(@Context() context: GraphqlContext, @Parent() ticket: components['schemas']['Ticket']) {
    return this.support.drafts(identityOf(context.req), ticket.id);
  }
}
