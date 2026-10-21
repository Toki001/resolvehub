import { createRequire } from 'node:module';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver } from '@nestjs/apollo';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { API_ENV, parseApiEnv } from './env.js';
import type { ApiEnv } from './env.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { DatabaseService } from './application/database.service.js';
import { ContractValidator } from './application/validator.js';
import { SupportService } from './application/support.service.js';
import { Pagination } from './application/pagination.js';
import { AuthService } from './auth/auth.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { WebhookAuthService } from './auth/webhook-auth.service.js';
import { SupportController } from './rest/support.controller.js';
import { WebhookController } from './rest/webhook.controller.js';
import { SupportResolver, TicketResolver } from './graphql/resolvers.js';
import { contractPlugin, scalarResolvers } from './graphql/transport.js';
import type { GraphqlContext } from './auth/context.js';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: [createRequire(import.meta.url).resolve('@resolvehub/contracts/schema.graphql')],
      path: '/graphql',
      context: (context: GraphqlContext) => context,
      resolvers: scalarResolvers,
      plugins: [contractPlugin],
      introspection: false,
      playground: false,
      csrfPrevention: true,
      allowBatchedHttpRequests: false,
      includeStacktraceInErrorResponses: false,
      fieldResolverEnhancers: ['guards'],
    }),
  ],
  controllers: [HealthController, SupportController, WebhookController],
  providers: [
    { provide: API_ENV, useFactory: () => parseApiEnv(process.env) },
    DatabaseService,
    ContractValidator,
    AuthService,
    AuthGuard,
    WebhookAuthService,
    { provide: Pagination, useFactory: (env: ApiEnv) => new Pagination(env), inject: [API_ENV] },
    SupportService,
    SupportResolver,
    TicketResolver,
    HealthService,
  ],
})
export class AppModule {}
