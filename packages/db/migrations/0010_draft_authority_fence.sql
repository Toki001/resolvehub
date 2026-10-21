-- A narrow authority-lock capability, without granting workers membership writes.
DO $migration$ BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION drafting_lock_authority(ticket uuid,member uuid) RETURNS boolean
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,%I,pg_temp AS $fn$
 SELECT EXISTS(SELECT 1 FROM tickets t JOIN organizations o ON o.id=t.organization_id
 JOIN memberships m ON m.organization_id=t.organization_id AND m.id=member
 WHERE t.id=ticket AND t.organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid
 AND t.deleted_at IS NULL AND o.deleted_at IS NULL AND m.active AND m.deleted_at IS NULL AND m.role IN('admin','agent')
 FOR SHARE OF t,o,m)
 $fn$ $ddl$,current_schema());
END $migration$;
REVOKE ALL ON FUNCTION drafting_lock_authority(uuid,uuid) FROM PUBLIC;
