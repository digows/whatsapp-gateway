package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

import java.util.List;

/**
 * Event emitted when an existing WhatsApp message changes after creation.
 * <p>
 * {@code targetMessage} identifies the logical message affected by the update.
 * {@code updateKinds} classifies what changed so consumers can branch safely without
 * guessing from nullable fields. When WhatsApp sends a full edited payload, it is
 * exposed in {@code message}. Reaction changes are also modeled here so clients can
 * treat the lifecycle as create/update/delete.
 *
 * @param session gateway session that observed the update
 * @param timestamp event emission timestamp in ISO-8601 format
 * @param targetMessage logical message affected by the update
 * @param chatId normalized chat identifier
 * @param senderId normalized sender identifier
 * @param fromMe whether WhatsApp marked the update as originating from the local account
 * @param updateKinds explicit set of update categories present in this event
 * @param message normalized message payload when WhatsApp provided one, such as on edits
 * @param status delivery/status code when the update carried status information
 * @param stubType WhatsApp stub type when the update represented a system action
 * @param contentType normalized content type when the update carried message content
 * @param pollUpdateCount number of poll deltas batched in the update
 * @param reactionText current reaction text when the update represented a reaction change
 * @param reactionRemoved whether the reaction lifecycle moved to the removed state
 */
@JsonTypeName("message.updated")
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessageUpdatedEvent(
  SessionReference session,
  String timestamp,
  MessageReference targetMessage,
  String chatId,
  String senderId,
  boolean fromMe,
  List<MessageUpdateKind> updateKinds,
  Message message,
  Integer status,
  Integer stubType,
  MessageContentType contentType,
  Integer pollUpdateCount,
  String reactionText,
  Boolean reactionRemoved
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_UPDATED;
  }
}
