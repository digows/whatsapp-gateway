package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("pin")
@JsonIgnoreProperties(ignoreUnknown = true)
public record PinMessageContent(
  MessageReference targetMessage,
  PinMessageAction action,
  PinMessageDurationSeconds durationSeconds
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.PIN;
  }
}
