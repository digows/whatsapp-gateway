package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("image")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ImageMessageContent(
  String caption,
  String mediaUrl,
  String mimeType,
  Integer width,
  Integer height
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.IMAGE;
  }
}
