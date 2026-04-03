package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("document")
@JsonIgnoreProperties(ignoreUnknown = true)
public record DocumentMessageContent(
  String caption,
  String mediaUrl,
  String fileName,
  String mimeType
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.DOCUMENT;
  }
}
