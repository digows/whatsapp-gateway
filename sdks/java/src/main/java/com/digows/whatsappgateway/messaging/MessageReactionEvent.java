package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("message.reaction")
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessageReactionEvent(
  SessionReference session,
  String timestamp,
  String chatId,
  String senderId,
  boolean fromMe,
  boolean removed,
  String messageId,
  String reactionText
) implements InboundEvent
{
  @Override
  public InboundEventType eventType()
  {
    return InboundEventType.MESSAGE_REACTION;
  }
}
