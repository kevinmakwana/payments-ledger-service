import { startTracing } from './tracing';

// Imported before anything else in main.ts: instrumentation must be installed before `pg` is first required.
startTracing();
