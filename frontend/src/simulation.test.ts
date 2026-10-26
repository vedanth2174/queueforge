import { describe, expect, it } from 'vitest'
import {
  advanceRun,
  createRun,
  nextRunState,
  processingDurations,
  seeded,
  type Config,
  type SimulationRun,
} from './simulation'

const config: Config = {
  count: 1,
  workers: 1,
  duration: 100,
  workload: 'short',
  failures: 100,
  retries: true,
  seed: 42,
}

function runToEnd(initial: SimulationRun, failureRoll = 0) {
  let current = initial
  for (let index = 0; index < 20; index++) {
    const result = advanceRun(current, config, 100, { 1: failureRoll })
    current = result.run
    if (result.finished) return current
  }
  throw new Error('Simulation did not finish')
}

describe('simulation engine', () => {
  it('is deterministic for a fixed seed', () => {
    const first = createRun({ ...config, count: 20, workload: 'mixed' })
    const second = createRun({ ...config, count: 20, workload: 'mixed' })
    expect(first).toEqual(second)
    expect(seeded(42)()).toBe(seeded(42)())
  })

  it('stops retries after three total attempts', () => {
    const finished = runToEnd(createRun(config))
    expect(finished.jobs[0].state).toBe('dead')
    expect(finished.jobs[0].attempts).toBe(3)
    expect(finished.jobs[0].processed).toBe(finished.jobs[0].duration * 3)
  })

  it('uses only terminal jobs for both processing statistics', () => {
    const run = createRun({ ...config, count: 3 })
    run.jobs[0].state = 'completed'
    run.jobs[0].processed = 100
    run.jobs[1].state = 'running'
    run.jobs[1].processed = 50
    expect(processingDurations(run)).toEqual([100])
  })

  it('supports pause, resume, step, and reset transitions', () => {
    expect(nextRunState('running', 'start-or-toggle')).toBe('paused')
    expect(nextRunState('paused', 'start-or-toggle')).toBe('running')
    expect(nextRunState('ready', 'step')).toBe('paused')
    expect(nextRunState('paused', 'reset')).toBe('ready')
    expect(nextRunState('finished', 'step')).toBe('finished')
  })

  it('keeps the run finished when the final step completes it', () => {
    expect(nextRunState('paused', 'step', true)).toBe('finished')
  })
})
