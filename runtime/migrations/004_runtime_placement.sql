BEGIN;
CREATE TABLE gateway.runtime (
 workspace_id uuid NOT NULL, id uuid NOT NULL, capacity integer NOT NULL CHECK(capacity > 0),
 draining integer NOT NULL CHECK(draining IN (0,1)), expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE gateway.desired_account (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, revision integer NOT NULL CHECK(revision > 0),
 enabled integer NOT NULL CHECK(enabled IN (0,1)), assigned_runtime_id uuid,
 attempted_revision integer NOT NULL DEFAULT 0 CHECK(attempted_revision>=0 AND attempted_revision<=revision),
 blocked_revision integer NOT NULL DEFAULT 0 CHECK(blocked_revision>=0 AND blocked_revision<=revision),
 PRIMARY KEY(workspace_id,account_id), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['runtime','desired_account'] LOOP
 EXECUTE format('ALTER TABLE gateway.%I ENABLE ROW LEVEL SECURITY', target);
 EXECUTE format('ALTER TABLE gateway.%I FORCE ROW LEVEL SECURITY', target);
 EXECUTE format($policy$CREATE POLICY workspace_boundary ON gateway.%I USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)$policy$, target);
 END LOOP;
END $$;
UPDATE gateway.schema_version SET version=4;
COMMIT;
