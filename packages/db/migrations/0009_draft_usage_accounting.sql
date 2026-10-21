-- Retain completed provider-call usage even if draft publication rolls back.
ALTER TABLE job_attempts ADD COLUMN usage jsonb;
