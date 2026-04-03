package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("delete")
@JsonIgnoreProperties(ignoreUnknown = true)
public record DeleteMessageContent(
  MessageReference targetMessage
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.DELETE;
  }
}
