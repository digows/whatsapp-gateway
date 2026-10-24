BEGIN;
-- PostgreSQL remains shared with forced workspace RLS; only the schema marker advances.
UPDATE gateway.schema_version SET version=9;
COMMIT;
