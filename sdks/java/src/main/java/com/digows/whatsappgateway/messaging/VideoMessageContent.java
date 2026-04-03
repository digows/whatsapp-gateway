package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("video")
@JsonIgnoreProperties(ignoreUnknown = true)
public record VideoMessageContent(
  String caption,
  String mediaUrl,
  String mimeType,
  Integer width,
  Integer height,
  boolean gifPlayback,
  boolean videoNote
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.VIDEO;
  }
}
