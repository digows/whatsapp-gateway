package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

import java.util.List;

@JsonTypeName("interactive_carousel")
@JsonIgnoreProperties(ignoreUnknown = true)
public record InteractiveCarouselMessageContent(
  String bodyText,
  String footerText,
  List<InteractiveCarouselCardContent> cards,
  Integer messageVersion
) implements MessageContent
{
  public InteractiveCarouselMessageContent
  {
    if (cards == null || cards.isEmpty())
    {
      throw new IllegalArgumentException("InteractiveCarouselMessageContent requires at least one card.");
    }

    if (messageVersion == null)
    {
      messageVersion = 1;
    }
  }

  @Override
  public MessageContentType type()
  {
    return MessageContentType.INTERACTIVE_CAROUSEL;
  }
}
