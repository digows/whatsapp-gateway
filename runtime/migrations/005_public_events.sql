BEGIN;
CREATE TABLE gateway.public_event (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence > 0),
 envelope jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,account_id,id), UNIQUE(workspace_id,account_id,sequence),
 FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
ALTER TABLE gateway.public_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway.public_event FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_boundary ON gateway.public_event
 USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid);
UPDATE gateway.schema_version SET version=5;
COMMIT;
