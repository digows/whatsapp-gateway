BEGIN;
CREATE TABLE gateway.webhook_destination (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, id uuid NOT NULL, url text NOT NULL, secret text NOT NULL,
 enabled integer NOT NULL CHECK(enabled IN (0,1)), delivery_lifetime_ms integer NOT NULL CHECK(delivery_lifetime_ms > 0),
 PRIMARY KEY(workspace_id,account_id,id), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.webhook_delivery (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, destination_id uuid NOT NULL, event_id uuid NOT NULL,
 event_sequence integer NOT NULL CHECK(event_sequence>0), body text NOT NULL,
 state text NOT NULL CHECK(state IN ('PENDING','DELIVERING','SUCCEEDED','EXHAUSTED','EXPIRED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 terminal_at timestamptz, claim_token uuid, lease_until timestamptz, last_status integer, failure text CHECK(failure IN ('TIMEOUT','NETWORK_ERROR','HTTP_ERROR','STOPPED')),
 CHECK((state='DELIVERING' AND claim_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'DELIVERING' AND claim_token IS NULL AND lease_until IS NULL)),
 CHECK((state IN ('SUCCEEDED','EXHAUSTED','EXPIRED')) = (terminal_at IS NOT NULL)),
 PRIMARY KEY(workspace_id,account_id,destination_id,event_id),
 FOREIGN KEY(workspace_id,account_id,destination_id) REFERENCES gateway.webhook_destination(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id,event_id) REFERENCES gateway.public_event(workspace_id,account_id,id)
);
CREATE INDEX webhook_delivery_pending ON gateway.webhook_delivery(workspace_id,account_id,destination_id,state,event_sequence);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['webhook_destination','webhook_delivery'] LOOP
 EXECUTE format('ALTER TABLE gateway.%I ENABLE ROW LEVEL SECURITY', target);
 EXECUTE format('ALTER TABLE gateway.%I FORCE ROW LEVEL SECURITY', target);
 EXECUTE format($policy$CREATE POLICY workspace_boundary ON gateway.%I USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)$policy$, target);
 END LOOP;
END $$;
UPDATE gateway.schema_version SET version=6;
COMMIT;
