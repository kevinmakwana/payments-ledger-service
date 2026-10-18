import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { HealthService } from './health.service';

@ApiExcludeController()
@Public()
@SkipThrottle() // probes poll constantly and must never be rate-limited
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up and serving. Never touches dependencies, so a Redis/DB outage cannot trigger restart loops. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: Postgres and Redis answer. 503 tells a load balancer to stop routing here. */
  @Get('ready')
  ready() {
    return this.readiness();
  }

  /** Same as /health/ready. */
  @Get()
  root() {
    return this.readiness();
  }

  private async readiness() {
    const { ok, checks } = await this.health.readiness();
    const body = { status: ok ? 'ok' : 'unavailable', checks };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
