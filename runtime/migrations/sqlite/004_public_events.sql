BEGIN;
CREATE TABLE public_event (
 workspace_id text NOT NULL, account_id text NOT NULL, id text NOT NULL, sequence integer NOT NULL CHECK(sequence > 0),
 envelope text NOT NULL CHECK(json_valid(envelope)), created_at text NOT NULL,
 PRIMARY KEY(workspace_id,account_id,id), UNIQUE(workspace_id,account_id,sequence),
 FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
UPDATE schema_version SET version=5;
COMMIT;
