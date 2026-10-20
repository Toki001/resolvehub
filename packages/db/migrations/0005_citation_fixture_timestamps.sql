-- Preserve source timestamps when normalizing compatibility citation writes.
CREATE OR REPLACE FUNCTION sync_legacy_citations() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  DELETE FROM citations WHERE organization_id=NEW.organization_id AND draft_id=NEW.id;
  INSERT INTO citations(id,organization_id,draft_id,document_id,version_id,chunk_id,position,created_at,updated_at)
   SELECT md5(NEW.id::text||':'||e.n::text)::uuid,NEW.organization_id,NEW.id,c.document_id,c.version_id,c.id,(e.n-1)::integer,NEW.created_at,NEW.updated_at
   FROM jsonb_array_elements(NEW.citations) WITH ORDINALITY AS e(value,n)
   JOIN knowledge_chunks c ON c.organization_id=NEW.organization_id AND c.id::text=e.value->>'chunkId'
    AND c.document_id::text=e.value->>'documentId' AND c.version_id::text=e.value->>'versionId'
   ON CONFLICT DO NOTHING;
  IF (SELECT count(*) FROM citations WHERE organization_id=NEW.organization_id AND draft_id=NEW.id) <> jsonb_array_length(NEW.citations) THEN
   UPDATE draft_responses SET evidence_validated=false WHERE organization_id=NEW.organization_id AND id=NEW.id;
  END IF;
  RETURN NEW;
 END $$;
