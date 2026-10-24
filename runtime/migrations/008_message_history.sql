BEGIN;
CREATE TABLE gateway.message_snapshot (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, chat_address text NOT NULL, message_id text NOT NULL, sender_address text NOT NULL,
 position integer NOT NULL CHECK(position>0), direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
 message jsonb NOT NULL, native text, occurred_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
 timestamp_source text NOT NULL CHECK(timestamp_source IN ('PROVIDER','GATEWAY_OBSERVATION')),
 edited integer NOT NULL DEFAULT 0 CHECK(edited IN (0,1)), deleted integer NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 PRIMARY KEY(workspace_id,account_id,chat_address,message_id,sender_address), UNIQUE(workspace_id,account_id,position),
 FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
INSERT INTO gateway.message_snapshot(workspace_id,account_id,chat_address,message_id,sender_address,position,direction,message,native,occurred_at,observed_at,timestamp_source)
SELECT workspace_id,account_id,message->>'chatAddress',message->>'channelMessageId',message->>'senderAddress',
 row_number() OVER(PARTITION BY workspace_id,account_id ORDER BY created_at,id), 'INBOUND', message,native,(message->>'occurredAt')::timestamptz,created_at,'PROVIDER'
FROM (
 SELECT *,row_number() OVER(PARTITION BY workspace_id,account_id,message->>'chatAddress',message->>'channelMessageId',message->>'senderAddress' ORDER BY created_at DESC,id DESC) AS latest
 FROM gateway.event WHERE kind='MESSAGE' AND message->>'contentKind' NOT IN ('EDIT','DELETE','REACTION','SELECTION')
) retained WHERE latest=1;
CREATE INDEX message_snapshot_history ON gateway.message_snapshot(workspace_id,account_id,chat_address,occurred_at,position);
ALTER TABLE gateway.message_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway.message_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_boundary ON gateway.message_snapshot
 USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid);
UPDATE gateway.schema_version SET version=8;
COMMIT;
