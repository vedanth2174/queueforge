export type JobState = 'queued' | 'running' | 'completed' | 'retrying' | 'dead'
export type Job = {
  id: string
  priority: number
  duration: number
  remaining: number
  state: JobState
  attempts: number
  worker?: number
  wait: number
  processed: number
  history: string[]
}
export type Worker = { id: number; jobId?: string; busy: number; processed: number }
export type Config = {
  count: number
  workers: number
  duration: number
  workload: string
  failures: number
  retries: boolean
  seed: number
}
export type RunState = 'ready' | 'running' | 'paused' | 'finished'
export type SimulationRun = ReturnType<typeof createRun>
export const MAX_ATTEMPTS = 3

export function seeded(seed: number) {
  let value = seed || 1
  return () => ((value = (value * 16807) % 2147483647) - 1) / 2147483646
}

export function createRun(config: Config) {
  const random = seeded(config.seed)
  const jobs: Job[] = Array.from({ length: config.count }, (_, index) => {
    const multiplier =
      config.workload === 'mixed'
        ? 0.45 + random() * 1.65
        : config.workload === 'long'
          ? 1.8 + random() * 0.6
          : 0.7 + random() * 0.45
    const priority = random() < 0.15 ? 9 : random() < 0.4 ? 5 : 1
    const duration = Math.round(config.duration * multiplier)
    return {
      id: `JOB-${String(index + 1).padStart(3, '0')}`,
      priority,
      duration,
      remaining: duration,
      state: 'queued' as JobState,
      attempts: 0,
      wait: 0,
      processed: 0,
      history: ['0ms · Created', '0ms · Queued'],
    }
  }).sort((a, b) => b.priority - a.priority)

  return {
    jobs,
    workers: Array.from(
      { length: config.workers },
      (_, index) => ({ id: index + 1, busy: 0, processed: 0 }) as Worker,
    ),
    elapsed: 0,
  }
}

export function percentile(values: number[], percentileValue: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1] ?? 0
}

export function processingDurations(run: SimulationRun) {
  return run.jobs
    .filter((job) => job.state === 'completed' || job.state === 'dead')
    .map((job) => job.processed)
}

export function nextRunState(
  state: RunState,
  action: 'start-or-toggle' | 'step' | 'reset',
  stepFinished = false,
): RunState {
  if (action === 'reset') return 'ready'
  if (action === 'step') return state === 'finished' || stepFinished ? 'finished' : 'paused'
  if (state === 'running') return 'paused'
  return 'running'
}

export function advanceRun(
  previous: SimulationRun,
  config: Config,
  delta: number,
  failureRolls: Record<number, number>,
) {
  const next = structuredClone(previous) as SimulationRun
  next.elapsed += delta
  next.jobs.forEach((job) => {
    if (job.state === 'queued' || job.state === 'retrying') job.wait += delta
  })
  next.workers.forEach((worker) => {
    if (worker.jobId) {
      const job = next.jobs.find((candidate) => candidate.id === worker.jobId)
      if (!job) return
      const worked = Math.min(delta, job.remaining)
      job.remaining -= worked
      job.processed += worked
      worker.busy += worked
      if (job.remaining <= 0) {
        const failed = (failureRolls[worker.id] ?? 100) < config.failures
        if (failed && config.retries && job.attempts < MAX_ATTEMPTS) {
          job.state = 'retrying'
          job.worker = undefined
          job.remaining = job.duration
          job.history.push(
            `${next.elapsed}ms · Attempt ${job.attempts} failed`,
            `${next.elapsed}ms · Queued for retry`,
          )
        } else if (failed) {
          job.state = 'dead'
          job.worker = undefined
          job.history.push(
            `${next.elapsed}ms · Attempt ${job.attempts} failed`,
            `${next.elapsed}ms · Maximum attempts reached`,
          )
        } else {
          job.state = 'completed'
          job.worker = undefined
          job.history.push(`${next.elapsed}ms · Completed`)
        }
        worker.jobId = undefined
        worker.processed++
      }
    }
    if (!worker.jobId) {
      const job = next.jobs.find(
        (candidate) => candidate.state === 'queued' || candidate.state === 'retrying',
      )
      if (job) {
        job.state = 'running'
        job.attempts++
        job.worker = worker.id
        worker.jobId = job.id
        job.history.push(
          `${next.elapsed}ms · Claimed by Worker ${worker.id} · Attempt ${job.attempts}`,
        )
      }
    }
  })
  return {
    run: next,
    finished: next.jobs.every(
      (job) => job.state === 'completed' || job.state === 'dead',
    ),
  }
}
