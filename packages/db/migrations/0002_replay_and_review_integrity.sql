-- Expand replay lineage and allow an organization-wide cascade to finish before
-- checking references to reviewers. Existing rows and applied SQL are preserved.
ALTER TABLE draft_responses ALTER CONSTRAINT draft_responses_organization_id_reviewed_by_fkey
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE job_runs ADD COLUMN replay_of uuid;
ALTER TABLE job_runs ADD CONSTRAINT job_replay_parent
  FOREIGN KEY (organization_id, replay_of) REFERENCES job_runs(organization_id, id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE job_runs ADD CONSTRAINT one_replay_per_failed_job UNIQUE (organization_id, replay_of);
ALTER TABLE job_runs ADD CONSTRAINT replay_is_distinct CHECK (replay_of IS NULL OR replay_of <> id);
