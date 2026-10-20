import { Module } from '@nestjs/common';
import { API_ENV, parseApiEnv } from './env.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [{ provide: API_ENV, useFactory: () => parseApiEnv(process.env) }, HealthService],
})
export class AppModule {}
