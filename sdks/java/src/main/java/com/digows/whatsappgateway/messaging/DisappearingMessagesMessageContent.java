package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("disappearing_messages")
@JsonIgnoreProperties(ignoreUnknown = true)
public record DisappearingMessagesMessageContent(
  int expirationSeconds
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.DISAPPEARING_MESSAGES;
  }
}
