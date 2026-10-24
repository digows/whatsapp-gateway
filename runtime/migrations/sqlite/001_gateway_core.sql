BEGIN;
CREATE TABLE account (
 workspace_id text NOT NULL, id text NOT NULL, state text NOT NULL DEFAULT 'STOPPED',
 generation integer NOT NULL DEFAULT 0, native_jid text, qr text,
 PRIMARY KEY(workspace_id,id), CHECK(state IN ('STOPPED','CONNECTING','AWAITING_PAIRING','CONNECTED','LOGGED_OUT','FAILED'))
);
CREATE TABLE authentication (
 workspace_id text NOT NULL, account_id text NOT NULL, category text NOT NULL, key_id text NOT NULL, serialized_value text NOT NULL,
 PRIMARY KEY(workspace_id,account_id,category,key_id), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE operation (
 workspace_id text NOT NULL, account_id text NOT NULL, key text NOT NULL, digest text NOT NULL,
 native_ids text NOT NULL, accepted_parts integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','IN_FLIGHT','ACCEPTED','FAILED','UNKNOWN')),
 CHECK(json_valid(native_ids) AND json_type(native_ids)='array' AND json_array_length(native_ids)>0),
 CHECK(accepted_parts>=0 AND accepted_parts<=json_array_length(native_ids)),
 CHECK(state<>'ACCEPTED' OR accepted_parts=json_array_length(native_ids)),
 PRIMARY KEY(workspace_id,account_id,key), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE event (
 workspace_id text NOT NULL, account_id text NOT NULL, id text NOT NULL, message text, native text NOT NULL,
 kind text NOT NULL DEFAULT 'MESSAGE' CHECK(kind IN ('MESSAGE','NORMALIZATION_FAILED')), error_name text,
 created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((kind='MESSAGE' AND message IS NOT NULL AND error_name IS NULL) OR (kind='NORMALIZATION_FAILED' AND message IS NULL AND error_name IS NOT NULL)),
 PRIMARY KEY(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE media (
 workspace_id text NOT NULL, account_id text NOT NULL, source_id text NOT NULL, reference text NOT NULL,
 PRIMARY KEY(workspace_id,account_id,source_id), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE pacing (
 workspace_id text NOT NULL, account_id text NOT NULL, next_send_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 started_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_active_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), recent_times text NOT NULL DEFAULT '[]', daily_date text NOT NULL DEFAULT current_date, daily_count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,account_id), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE delivery (
 workspace_id text NOT NULL, account_id text NOT NULL, message_id text NOT NULL,status text NOT NULL,chat_address text,observed_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(workspace_id,account_id,message_id,status), FOREIGN KEY(workspace_id,account_id) REFERENCES account
);
CREATE TABLE schema_version(version integer PRIMARY KEY CHECK(version > 0));
INSERT INTO schema_version(version) VALUES(2);
COMMIT;
