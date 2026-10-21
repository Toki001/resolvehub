import { observed } from '@resolvehub/telemetry';
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
    return observed(
      'graphql.resolve',
      { field: 'tickets' },
      () => this.support.tickets(identityOf(context.req), first, after, filter),
      context.telemetryContext,
    );
  }
  @Query('ticket')
  ticket(@Context() context: GraphqlContext, @Args('id') id: string) {
    return observed(
      'graphql.resolve',
      { field: 'ticket' },
      () => this.support.ticket(identityOf(context.req), z.uuid().parse(id).toLowerCase()),
      context.telemetryContext,
    );
  }
  @Query('knowledgeDocuments')
  documents(
    @Context() context: GraphqlContext,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
  ) {
    return observed(
      'graphql.resolve',
      { field: 'knowledgeDocuments' },
      () => this.support.documents(identityOf(context.req), first, after),
      context.telemetryContext,
    );
  }
  @Query('knowledgeSearch')
  search(
    @Context() context: GraphqlContext,
    @Args('query') query: string,
    @Args('first') first: number | null,
    @Args('after') after: string | null,
  ) {
    return observed(
      'graphql.resolve',
      { field: 'knowledgeSearch' },
      () => this.support.search(identityOf(context.req), query, first, after),
      context.telemetryContext,
    );
  }
  @Query('draft')
  draft(@Context() context: GraphqlContext, @Args('id') id: string) {
    return observed(
      'graphql.resolve',
      { field: 'draft' },
      () => this.support.draft(identityOf(context.req), z.uuid().parse(id).toLowerCase()),
      context.telemetryContext,
    );
  }
  @Query('dashboardSummary')
  summary(@Context() context: GraphqlContext) {
    return observed(
      'graphql.resolve',
      { field: 'dashboardSummary' },
      () => this.support.summary(identityOf(context.req)),
      context.telemetryContext,
    );
  }
}

@Resolver('Ticket')
@UseGuards(AuthGuard)
export class TicketResolver {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @ResolveField('messages')
  messages(@Context() context: GraphqlContext, @Parent() ticket: components['schemas']['Ticket']) {
    return observed(
      'graphql.resolve',
      { field: 'messages' },
      () => this.support.messages(identityOf(context.req), ticket.id),
      context.telemetryContext,
    );
  }
  @ResolveField('drafts')
  drafts(@Context() context: GraphqlContext, @Parent() ticket: components['schemas']['Ticket']) {
    return observed(
      'graphql.resolve',
      { field: 'drafts' },
      () => this.support.drafts(identityOf(context.req), ticket.id),
      context.telemetryContext,
    );
  }
}
