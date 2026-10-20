import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live() {
    return { status: 'alive', service: 'api' } as const;
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.readiness();
    response.status(result.status === 'ready' ? 200 : 503);
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }
}
