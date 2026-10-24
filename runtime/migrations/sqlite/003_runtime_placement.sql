BEGIN;
CREATE TABLE runtime (
 workspace_id text NOT NULL, id text NOT NULL, capacity integer NOT NULL CHECK(capacity > 0),
 draining integer NOT NULL CHECK(draining IN (0,1)), expires_at text NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE desired_account (
 workspace_id text NOT NULL, account_id text NOT NULL, revision integer NOT NULL CHECK(revision > 0),
 enabled integer NOT NULL CHECK(enabled IN (0,1)), assigned_runtime_id text,
 attempted_revision integer NOT NULL DEFAULT 0 CHECK(attempted_revision>=0 AND attempted_revision<=revision),
 blocked_revision integer NOT NULL DEFAULT 0 CHECK(blocked_revision>=0 AND blocked_revision<=revision),
 PRIMARY KEY(workspace_id,account_id), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
UPDATE schema_version SET version=4;
COMMIT;
