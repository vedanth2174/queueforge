# QueueForge benchmark artifacts

Place recorded benchmark JSON files in this directory. Vite compiles every
`*.json` file here into the standalone frontend, so the Benchmark Lab does not
depend on a runtime API.

The dashboard reads the genuine QueueForge result fields below, either at the
document root or inside `metrics`:

- `throughputJobsPerSecond`
- `jobs`
- `workers`
- `queueWaitFromEnqueueMs` with `p50`, `p95`, and `p99`
- `processingMs` with `p50`, `p95`, and `p99`
- `queueWaitFromProcessingStartMs` with `p50`, `p95`, and `p99`

Do not add sample, estimated, or synthetic values. Only commit artifacts
created by the controlled benchmark runner.
