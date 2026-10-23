BEGIN;
CREATE SCHEMA gateway;
CREATE TABLE gateway.account (
 workspace_id uuid NOT NULL, id uuid NOT NULL, state text NOT NULL DEFAULT 'STOPPED',
 generation integer NOT NULL DEFAULT 0, native_jid text, qr text,
 PRIMARY KEY(workspace_id,id), CHECK(state IN ('STOPPED','CONNECTING','AWAITING_PAIRING','CONNECTED','LOGGED_OUT','FAILED'))
);
CREATE TABLE gateway.authentication (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, category text NOT NULL, key_id text NOT NULL, serialized_value text NOT NULL,
 PRIMARY KEY(workspace_id,account_id,category,key_id), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.operation (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, key text NOT NULL, digest text NOT NULL,
 native_ids jsonb NOT NULL, accepted_parts integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','IN_FLIGHT','ACCEPTED','FAILED','UNKNOWN')),
 CHECK(jsonb_typeof(native_ids)='array' AND jsonb_array_length(native_ids)>0),
 CHECK(accepted_parts>=0 AND accepted_parts<=jsonb_array_length(native_ids)),
 CHECK(state<>'ACCEPTED' OR accepted_parts=jsonb_array_length(native_ids)),
 PRIMARY KEY(workspace_id,account_id,key), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.event (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, id text NOT NULL, message jsonb NOT NULL, native text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,account_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.media (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, source_id text NOT NULL, reference jsonb NOT NULL,
 PRIMARY KEY(workspace_id,account_id,source_id), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.pacing (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, next_send_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz NOT NULL DEFAULT now(), last_active_at timestamptz NOT NULL DEFAULT now(), recent_times jsonb NOT NULL DEFAULT '[]', daily_date date NOT NULL DEFAULT current_date, daily_count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,account_id), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
CREATE TABLE gateway.delivery (
 workspace_id uuid NOT NULL, account_id uuid NOT NULL, message_id text NOT NULL,status text NOT NULL,chat_address text,observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,account_id,message_id,status), FOREIGN KEY(workspace_id,account_id) REFERENCES gateway.account
);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['account','authentication','operation','event','media','pacing','delivery'] LOOP
 EXECUTE format('ALTER TABLE gateway.%I ENABLE ROW LEVEL SECURITY', target);
 EXECUTE format('ALTER TABLE gateway.%I FORCE ROW LEVEL SECURITY', target);
 EXECUTE format($policy$CREATE POLICY workspace_boundary ON gateway.%I USING (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('gateway.workspace_id', true), '')::uuid)$policy$, target);
 END LOOP;
END $$;

COMMIT;
