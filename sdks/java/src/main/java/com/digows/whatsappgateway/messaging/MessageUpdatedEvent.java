package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("message.updated")
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessageUpdatedEvent(
  SessionReference session,
  String timestamp,
  String messageId,
  String chatId,
  String senderId,
  boolean fromMe,
  Integer status,
  Integer stubType,
  String contentType,
  Integer pollUpdateCount
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_UPDATED;
  }
}
