BEGIN;
CREATE TABLE webhook_destination (
 workspace_id text NOT NULL, account_id text NOT NULL, id text NOT NULL, url text NOT NULL, secret text NOT NULL,
 enabled integer NOT NULL CHECK(enabled IN (0,1)), delivery_lifetime_ms integer NOT NULL CHECK(delivery_lifetime_ms>0),
 PRIMARY KEY(workspace_id,account_id,id), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE webhook_delivery (
 workspace_id text NOT NULL, account_id text NOT NULL, destination_id text NOT NULL, event_id text NOT NULL,
 event_sequence integer NOT NULL CHECK(event_sequence>0), body text NOT NULL CHECK(json_valid(body)),
 state text NOT NULL CHECK(state IN ('PENDING','DELIVERING','SUCCEEDED','EXHAUSTED','EXPIRED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at text NOT NULL, expires_at text NOT NULL,
 terminal_at text, claim_token text, lease_until text, last_status integer, failure text CHECK(failure IN ('TIMEOUT','NETWORK_ERROR','HTTP_ERROR','STOPPED')),
 CHECK((state='DELIVERING' AND claim_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'DELIVERING' AND claim_token IS NULL AND lease_until IS NULL)),
 CHECK((state IN ('SUCCEEDED','EXHAUSTED','EXPIRED')) = (terminal_at IS NOT NULL)),
 PRIMARY KEY(workspace_id,account_id,destination_id,event_id),
 FOREIGN KEY(workspace_id,account_id,destination_id) REFERENCES webhook_destination(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id,event_id) REFERENCES public_event(workspace_id,account_id,id)
);
CREATE INDEX webhook_delivery_pending ON webhook_delivery(workspace_id,account_id,destination_id,state,event_sequence);
UPDATE schema_version SET version=6;
COMMIT;
