package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("sticker")
@JsonIgnoreProperties(ignoreUnknown = true)
public record StickerMessageContent(
  String mediaUrl,
  String mimeType,
  boolean animated,
  Integer width,
  Integer height
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.STICKER;
  }
}
