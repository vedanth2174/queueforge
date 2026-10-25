
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (
            status IN (
                'queued',
                'running',
                'completed',
                'failed',
                'dead',
                'cancelled'
            )
        ),

    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),

    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    idempotency_key VARCHAR(255) UNIQUE,

    locked_by VARCHAR(255),
    locked_until TIMESTAMPTZ,

    result JSONB,
    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    CHECK (
        (status = 'running' AND locked_by IS NOT NULL
                             AND locked_until IS NOT NULL)
        OR
        (status <> 'running' AND locked_by IS NULL
                              AND locked_until IS NULL)
    )
);

-- Find eligible queued jobs efficiently.
CREATE INDEX idx_jobs_queued_priority
    ON jobs (priority DESC, run_at ASC, created_at ASC)
    WHERE status = 'queued';

-- Find abandoned running jobs whose leases have expired.
CREATE INDEX idx_jobs_expired_leases
    ON jobs (locked_until)
    WHERE status = 'running';

-- Support filtering and inspecting recent jobs by status.
CREATE INDEX idx_jobs_status_created
    ON jobs (status, created_at DESC);
