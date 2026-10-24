BEGIN;
CREATE TABLE command (
 workspace_id text NOT NULL, account_id text NOT NULL, request_id text NOT NULL,
 sequence integer NOT NULL CHECK(sequence > 0), digest text NOT NULL, command text NOT NULL CHECK(json_valid(command)),
 state text NOT NULL CHECK(state IN ('PENDING','EXECUTING','COMPLETED','FAILED')),
 response text CHECK(response IS NULL OR json_valid(response)), failure text CHECK(failure='EXECUTION_FAILED'),
 claim_token text, generation integer, created_at text NOT NULL,
 CHECK((state='EXECUTING') = (claim_token IS NOT NULL AND generation IS NOT NULL)),
 CHECK((state='COMPLETED') = (response IS NOT NULL)), CHECK((state='FAILED') = (failure IS NOT NULL)),
 PRIMARY KEY(workspace_id,account_id,request_id), UNIQUE(workspace_id,account_id,sequence),
 FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
UPDATE schema_version SET version=3;
COMMIT;
