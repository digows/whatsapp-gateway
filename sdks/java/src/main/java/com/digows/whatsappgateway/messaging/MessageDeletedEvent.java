package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

/**
 * Event emitted when WhatsApp revokes an existing message from the chat timeline.
 * <p>
 * {@code message} is optional because some revoke notifications only identify the target
 * message and do not include a normalized delete envelope.
 *
 * @param session gateway session that observed the deletion
 * @param timestamp event emission timestamp in ISO-8601 format
 * @param targetMessage logical message revoked from the timeline
 * @param chatId normalized chat identifier
 * @param senderId normalized sender identifier
 * @param fromMe whether WhatsApp marked the deletion as originating from the local account
 * @param message normalized delete envelope when available
 */
@JsonTypeName("message.deleted")
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessageDeletedEvent(
  SessionReference session,
  String timestamp,
  MessageReference targetMessage,
  String chatId,
  String senderId,
  boolean fromMe,
  Message message
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_DELETED;
  }
}
