package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("audio")
@JsonIgnoreProperties(ignoreUnknown = true)
public record AudioMessageContent(
  String mediaUrl,
  String mimeType,
  Integer durationSeconds,
  boolean voiceNote
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.AUDIO;
  }
}
