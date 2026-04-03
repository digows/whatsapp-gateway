package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("other")
@JsonIgnoreProperties(ignoreUnknown = true)
public record OtherMessageContent(
  String description
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.OTHER;
  }
}
