BEGIN;
CREATE TABLE gateway.command (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, request_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence > 0), digest text NOT NULL, command jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('PENDING','EXECUTING','COMPLETED','FAILED')),
 response jsonb, failure text CHECK(failure='EXECUTION_FAILED'), claim_token uuid, generation integer,
 created_at timestamptz NOT NULL,
 CHECK((state='EXECUTING') = (claim_token IS NOT NULL AND generation IS NOT NULL)),
 CHECK((state='COMPLETED') = (response IS NOT NULL)), CHECK((state='FAILED') = (failure IS NOT NULL)),
 PRIMARY KEY(workspace_id,account_id,request_id), UNIQUE(workspace_id,account_id,sequence),
 FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
ALTER TABLE gateway.command ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway.command FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_boundary ON gateway.command
 USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid);
UPDATE gateway.schema_version SET version=3;
COMMIT;
