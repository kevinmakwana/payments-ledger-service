import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';

/** Flushes buffered spans on shutdown, after every other module has stopped, so the last jobs' spans are not lost. */
@Injectable()
export class TracingLifecycle implements OnApplicationShutdown {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.config.tracingEnabled) return;
    // Loaded lazily: the OpenTelemetry SDK is only paid for when tracing is on.
    const { shutdownTracing } = await import('../tracing');
    await shutdownTracing();
  }
}
