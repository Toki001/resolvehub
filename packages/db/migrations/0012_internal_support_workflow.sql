-- Expand: old clients ignore the new fields. No external delivery is implied.
ALTER TABLE draft_responses ADD COLUMN human_edited boolean NOT NULL DEFAULT false;
ALTER TABLE draft_responses ADD COLUMN original_text text;
ALTER TABLE draft_responses ADD COLUMN edited_by uuid;
ALTER TABLE draft_responses ADD COLUMN edited_at timestamptz(3);
ALTER TABLE draft_responses ADD CONSTRAINT draft_editor_owned FOREIGN KEY(organization_id,edited_by)
 REFERENCES memberships(organization_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ticket_messages ADD COLUMN delivery_status text NOT NULL DEFAULT 'received';
UPDATE ticket_messages SET delivery_status='internal' WHERE author='agent';
ALTER TABLE ticket_messages ADD COLUMN source_draft_id uuid;
ALTER TABLE ticket_messages ADD CONSTRAINT message_delivery_status CHECK(delivery_status IN('received','internal'));
ALTER TABLE draft_responses ADD CONSTRAINT draft_message_parent UNIQUE(organization_id,ticket_id,id);
ALTER TABLE ticket_messages ADD CONSTRAINT message_source_draft_owned FOREIGN KEY(organization_id,ticket_id,source_draft_id)
 REFERENCES draft_responses(organization_id,ticket_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX message_once_per_draft ON ticket_messages(organization_id,source_draft_id) WHERE source_draft_id IS NOT NULL;
CREATE INDEX drafts_review_page ON draft_responses(organization_id,status,created_at DESC,id DESC) WHERE deleted_at IS NULL;
ALTER TABLE ticket_messages ADD CONSTRAINT message_approved_source CHECK(source_draft_id IS NULL OR (author='agent' AND delivery_status='internal'));
