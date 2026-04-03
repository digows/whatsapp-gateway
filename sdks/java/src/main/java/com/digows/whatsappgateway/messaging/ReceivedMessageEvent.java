package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("message.received")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ReceivedMessageEvent(
  SessionReference session,
  String timestamp,
  Message message
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_RECEIVED;
  }
}
