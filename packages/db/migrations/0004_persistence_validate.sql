-- Complete the customer expansion after backfill and compatibility adapters.
-- NOT VALID avoids scanning at installation of the check; VALIDATE checks the
-- old rows before SET NOT NULL. Old API inserts remain supported by the trigger.
ALTER TABLE tickets ADD CONSTRAINT tickets_customer_required CHECK (customer_id IS NOT NULL) NOT VALID;
ALTER TABLE tickets VALIDATE CONSTRAINT tickets_customer_required;
ALTER TABLE tickets ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE tickets DROP CONSTRAINT tickets_customer_required;
