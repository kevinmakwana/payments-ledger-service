import { WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { APP_CONFIG, AppConfig } from '../config/config';

/**
 * Decides, per process, whether the BullMQ workers run. Every `@Processor` is declared with `autorun: false`, so a
 * worker only starts here, and only when this process is not a pure `api` tier. That lets the HTTP tier and the
 * worker tier scale independently from the same image and the same module graph.
 */
@Injectable()
export class WorkerRoleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerRoleService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.role === 'api') {
      this.logger.log('Role "api": serving HTTP only; queue workers and schedulers are not started in this process');
      return;
    }
    let started = 0;
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance instanceof WorkerHost) {
        started++;
        void instance.worker.run().catch((err: unknown) => this.logger.error(`Queue worker stopped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    this.logger.log(`Role "${this.config.role}": started ${started} queue workers`);
  }
}
