BEGIN;
CREATE TABLE stream_receipt (
 workspace_id text NOT NULL, account_id text NOT NULL, source_stream text NOT NULL, source_message_id text NOT NULL,
 digest text NOT NULL, receipt text NOT NULL CHECK(json_valid(receipt)),
 PRIMARY KEY(workspace_id,account_id,source_stream,source_message_id), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE stream_cursor (
 workspace_id text NOT NULL, account_id text NOT NULL, stream_name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('results','events')), position integer NOT NULL CHECK(position>=0),
 claim_token text, claimed_sequence integer, lease_until text,
 CHECK((claim_token IS NULL AND claimed_sequence IS NULL AND lease_until IS NULL) OR (claim_token IS NOT NULL AND claimed_sequence IS NOT NULL AND lease_until IS NOT NULL AND claimed_sequence>position)),
 PRIMARY KEY(workspace_id,account_id,stream_name), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
UPDATE schema_version SET version=7;
COMMIT;
