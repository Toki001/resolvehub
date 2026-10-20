-- Legacy version rows had no individual status. Without an active pointer,
-- their latest revision must inherit the document's actual handoff state.
-- Published documents and superseded historical revisions remain untouched.
UPDATE document_versions v SET status=d.status
 FROM knowledge_documents d
 WHERE d.organization_id=v.organization_id AND d.id=v.document_id
  AND d.active_version_id IS NULL AND d.deleted_at IS NULL
  AND d.status IN ('uploaded','queued','processing','failed')
  AND v.status='superseded' AND v.deleted_at IS NULL
  AND v.revision=(SELECT max(previous.revision) FROM document_versions previous
   WHERE previous.organization_id=v.organization_id AND previous.document_id=v.document_id AND previous.deleted_at IS NULL);
