import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivationMode, parseActivationMode } from '../src/domain/entities/activation/ActivationMode.js';
import { AuthenticationStateType } from '../src/domain/entities/authentication/AuthenticationStateType.js';
import {
  parseCallCommandAction,
  parseCallType,
  parseChatCommandAction,
  parseGroupCommandAction,
  parseNewsletterCommandAction,
  parseOutboundCommandFamily,
  parsePresenceCommandAction,
  parsePresenceType,
  parsePrivacyCommandAction,
  parseProfileCommandAction,
  parseReadCommandAction,
} from '../src/domain/entities/command/OutboundCommand.js';
import { OutboundCommandResultStatus, parseOutboundCommandResultStatus } from '../src/domain/entities/command/OutboundCommandResult.js';
import {
  parseButtonReplyType,
  parseEventCallType,
  parsePinMessageAction,
  parsePinMessageDurationSeconds,
} from '../src/domain/entities/messaging/MessageContent.js';
import { MessageUpdateKind, parseMessageUpdateKind } from '../src/domain/entities/messaging/InboundEvent.js';
import { parseMessageContentType } from '../src/domain/entities/messaging/MessageContentType.js';
import { parseChatType } from '../src/domain/entities/messaging/MessageContext.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { parseWorkerCommandAction } from '../src/domain/entities/operational/WorkerCommand.js';
import { WorkerHeartbeat } from '../src/domain/entities/operational/WorkerHeartbeat.js';
import { WorkerIdentity } from '../src/domain/entities/operational/WorkerIdentity.js';

test('SessionReference exposes a stable key and log label', () => {
  const session = new SessionReference('whatsapp-web', 42, 'session-123');

  assert.equal(session.toKey(), 'whatsapp-web:42:session-123');
  assert.equal(
    session.toLogLabel(),
    'whatsapp-web session session-123 (WS: 42)',
  );
});

test('WorkerHeartbeat exports the registry payload', () => {
  const workerIdentity = WorkerIdentity.current();
  const heartbeat = WorkerHeartbeat.capture(
    'whatsapp-web',
    workerIdentity,
    3,
    50,
  );

  const payload = heartbeat.toRegistryPayload();

  assert.equal(payload.provider, 'whatsapp-web');
  assert.equal(payload.worker_id, workerIdentity.id);
  assert.equal(payload.current_sessions, 3);
  assert.equal(payload.max_capacity, 50);
  assert.ok(Number(payload.cpu_usage) >= 0);
  assert.ok(Number(payload.memory_usage_mb) >= 0);
  assert.ok(Number(payload.last_pulse) > 0);
});

test('domain parsers reject unsupported external values', () => {
  assert.equal(parseWorkerCommandAction('start_session'), 'start_session');
  assert.equal(parseChatType('group'), 'group');
  assert.equal(parseMessageContentType('document'), 'document');
  assert.equal(parseMessageContentType('poll'), 'poll');
  assert.equal(parseMessageContentType('pin'), 'pin');
  assert.equal(parseMessageContentType('interactive_carousel'), 'interactive_carousel');
  assert.equal(parseButtonReplyType('template'), 'template');
  assert.equal(parseEventCallType('video'), 'video');
  assert.equal(parsePinMessageAction('unpin_for_all'), 'unpin_for_all');
  assert.equal(parsePinMessageDurationSeconds(604800), 604800);
  assert.equal(parseMessageUpdateKind('content'), MessageUpdateKind.Content);
  assert.equal(parseMessageUpdateKind('poll'), MessageUpdateKind.Poll);
  assert.equal(parseMessageUpdateKind('reaction'), MessageUpdateKind.Reaction);
  assert.equal(parseOutboundCommandFamily('presence'), 'presence');
  assert.equal(parsePresenceCommandAction('update'), 'update');
  assert.equal(parsePresenceType('paused'), 'paused');
  assert.equal(parseReadCommandAction('send_receipt'), 'send_receipt');
  assert.equal(parseChatCommandAction('archive'), 'archive');
  assert.equal(parseGroupCommandAction('participants_update'), 'participants_update');
  assert.equal(parseNewsletterCommandAction('metadata'), 'metadata');
  assert.equal(parseProfileCommandAction('update_profile_status'), 'update_profile_status');
  assert.equal(parsePrivacyCommandAction('fetch_settings'), 'fetch_settings');
  assert.equal(parseCallCommandAction('create_link'), 'create_link');
  assert.equal(parseCallType('audio'), 'audio');
  assert.equal(parseOutboundCommandResultStatus('succeeded'), OutboundCommandResultStatus.Succeeded);

  assert.throws(() => {
    parseWorkerCommandAction('restart_session');
  }, /Unsupported worker command action/);

  assert.throws(() => {
    parseChatType('channel');
  }, /Unsupported chat type/);

  assert.throws(() => {
    parseMessageContentType('call');
  }, /Unsupported message content type/);

  assert.throws(() => {
    parseButtonReplyType('carousel');
  }, /Unsupported button reply type/);

  assert.throws(() => {
    parseEventCallType('screen_share');
  }, /Unsupported event call type/);

  assert.throws(() => {
    parsePinMessageAction('pin_for_me');
  }, /Unsupported pin message action/);

  assert.throws(() => {
    parsePinMessageDurationSeconds(120);
  }, /Unsupported pin duration/);

  assert.throws(() => {
    parseMessageUpdateKind('delivery');
  }, /Unsupported message update kind/);

  assert.throws(() => {
    parseOutboundCommandFamily('history');
  }, /Unsupported outbound command family/);

  assert.throws(() => {
    parsePresenceType('typing');
  }, /Unsupported presence type/);

  assert.throws(() => {
    parseOutboundCommandResultStatus('partial');
  }, /Unsupported outbound command result status/);
});

test('AuthenticationStateType centralizes known key kinds', () => {
  assert.equal(
    AuthenticationStateType.fromValue('creds'),
    AuthenticationStateType.Credentials,
  );
  assert.equal(AuthenticationStateType.IdentityKey.isBinary(), true);
  assert.equal(AuthenticationStateType.AppStateSyncKey.isAppStateSyncKey(), true);
  assert.equal(
    AuthenticationStateType.fromValue('future-baileys-type').value,
    'future-baileys-type',
  );
});

test('activation mode parser accepts supported strategies and rejects unsupported values', () => {
  assert.equal(parseActivationMode('pairing_code'), ActivationMode.PairingCode);
  assert.equal(parseActivationMode('qr'), ActivationMode.QrCode);

  assert.throws(() => {
    parseActivationMode('email_link');
  }, /Unsupported activation mode/);
});
