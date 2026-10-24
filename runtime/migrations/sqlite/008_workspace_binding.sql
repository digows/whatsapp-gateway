-- The migration runner commits this metadata and its selected workspace atomically.
CREATE TABLE workspace_binding (
 singleton integer PRIMARY KEY CHECK(singleton=1),
 workspace_id text NOT NULL CHECK(length(workspace_id)=36 AND lower(workspace_id)=workspace_id)
);
UPDATE schema_version SET version=9;
