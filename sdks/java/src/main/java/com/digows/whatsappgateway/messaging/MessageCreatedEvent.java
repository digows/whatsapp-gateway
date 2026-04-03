package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

/**
 * Event emitted when the gateway observes a newly created inbound WhatsApp message.
 *
 * @param session gateway session that received the message
 * @param timestamp event emission timestamp in ISO-8601 format
 * @param message normalized message payload
 */
@JsonTypeName("message.created")
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessageCreatedEvent(
  SessionReference session,
  String timestamp,
  Message message
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_CREATED;
  }
}
