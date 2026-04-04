package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

/**
 * Event emitted when the gateway observes a newly created WhatsApp message in the session timeline.
 *
 * @param session gateway session that observed the message
 * @param timestamp event emission timestamp in ISO-8601 format
 * @param message normalized message payload
 * @param fromMe whether WhatsApp marked the created message as originating from the local account
 */
@JsonTypeName("message.created")
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessageCreatedEvent(
  SessionReference session,
  String timestamp,
  Message message,
  boolean fromMe
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_CREATED;
  }
}
