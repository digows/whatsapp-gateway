BEGIN;
CREATE TABLE gateway.stream_receipt (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, source_stream text NOT NULL, source_message_id text NOT NULL,
 digest text NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(workspace_id,account_id,source_stream,source_message_id), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.stream_cursor (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, stream_name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('results','events')), position integer NOT NULL CHECK(position>=0),
 claim_token uuid, claimed_sequence integer, lease_until timestamptz,
 CHECK((claim_token IS NULL AND claimed_sequence IS NULL AND lease_until IS NULL) OR (claim_token IS NOT NULL AND claimed_sequence IS NOT NULL AND lease_until IS NOT NULL AND claimed_sequence>position)),
 PRIMARY KEY(workspace_id,account_id,stream_name), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['stream_receipt','stream_cursor'] LOOP
 EXECUTE format('ALTER TABLE gateway.%I ENABLE ROW LEVEL SECURITY', target);
 EXECUTE format('ALTER TABLE gateway.%I FORCE ROW LEVEL SECURITY', target);
 EXECUTE format($policy$CREATE POLICY workspace_boundary ON gateway.%I USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)$policy$, target);
 END LOOP;
END $$;
UPDATE gateway.schema_version SET version=7;
COMMIT;
