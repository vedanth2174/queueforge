
ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS idempotency_request JSONB;
