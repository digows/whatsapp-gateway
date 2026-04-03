package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("text")
@JsonIgnoreProperties(ignoreUnknown = true)
public record TextMessageContent(
  String text,
  String matchedText,
  String title,
  String description
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.TEXT;
  }
}
