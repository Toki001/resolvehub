import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthService } from './auth.service.js';
import type { ApiRequest, GraphqlContext } from './context.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request =
      context.getType<string>() === 'graphql'
        ? GqlExecutionContext.create(context).getContext<GraphqlContext>().req
        : context.switchToHttp().getRequest<ApiRequest>();
    request.authentication ??= this.auth.authenticate(request.headers.authorization);
    request.identity = await request.authentication;
    return true;
  }
}
