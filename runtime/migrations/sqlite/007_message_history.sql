BEGIN;
CREATE TABLE message_snapshot (
 workspace_id text NOT NULL, account_id text NOT NULL, chat_address text NOT NULL, message_id text NOT NULL, sender_address text NOT NULL,
 position integer NOT NULL CHECK(position>0), direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
 message text NOT NULL CHECK(json_valid(message)), native text, occurred_at text NOT NULL, observed_at text NOT NULL,
 timestamp_source text NOT NULL CHECK(timestamp_source IN ('PROVIDER','GATEWAY_OBSERVATION')),
 edited integer NOT NULL DEFAULT 0 CHECK(edited IN (0,1)), deleted integer NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 PRIMARY KEY(workspace_id,account_id,chat_address,message_id,sender_address), UNIQUE(workspace_id,account_id,position),
 FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
INSERT INTO message_snapshot(workspace_id,account_id,chat_address,message_id,sender_address,position,direction,message,native,occurred_at,observed_at,timestamp_source)
SELECT workspace_id,account_id,json_extract(message,'$.chatAddress'),json_extract(message,'$.channelMessageId'),json_extract(message,'$.senderAddress'),
 row_number() OVER(PARTITION BY workspace_id,account_id ORDER BY created_at,id), 'INBOUND', message,native,
 strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(message,'$.occurredAt')),created_at,'PROVIDER'
FROM (
 SELECT *,row_number() OVER(PARTITION BY workspace_id,account_id,json_extract(message,'$.chatAddress'),json_extract(message,'$.channelMessageId'),json_extract(message,'$.senderAddress') ORDER BY created_at DESC,id DESC) AS latest
 FROM event WHERE kind='MESSAGE' AND json_extract(message,'$.contentKind') NOT IN ('EDIT','DELETE','REACTION','SELECTION')
) retained WHERE latest=1;
CREATE INDEX message_snapshot_history ON message_snapshot(workspace_id,account_id,chat_address,occurred_at,position);
UPDATE schema_version SET version=8;
COMMIT;
