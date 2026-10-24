BEGIN;
-- Schema compatibility is system-level metadata, not tenant-owned data.
CREATE TABLE gateway.schema_version (version integer PRIMARY KEY CHECK(version > 0));
INSERT INTO gateway.schema_version(version) VALUES (2);
COMMIT;
