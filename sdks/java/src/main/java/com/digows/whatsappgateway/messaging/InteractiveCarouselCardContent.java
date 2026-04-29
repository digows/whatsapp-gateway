package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record InteractiveCarouselCardContent(
  String headerTitle,
  String headerSubtitle,
  MessageContent headerMedia,
  String bodyText,
  String footerText,
  InteractiveCarouselNativeFlowMessageContent nativeFlowMessage
)
{
  public InteractiveCarouselCardContent
  {
    if (nativeFlowMessage == null)
    {
      throw new IllegalArgumentException("InteractiveCarouselCardContent requires nativeFlowMessage.");
    }

    if ((headerTitle == null || headerTitle.isBlank()) && headerMedia == null)
    {
      throw new IllegalArgumentException("InteractiveCarouselCardContent requires a headerTitle or headerMedia.");
    }

    if (headerMedia != null && !isSupportedHeaderMedia(headerMedia.type()))
    {
      throw new IllegalArgumentException("Unsupported interactive carousel header media type \"" + headerMedia.type().getWireValue() + "\".");
    }
  }

  private static boolean isSupportedHeaderMedia(MessageContentType type)
  {
    return type == MessageContentType.IMAGE
      || type == MessageContentType.VIDEO
      || type == MessageContentType.DOCUMENT
      || type == MessageContentType.LOCATION
      || type == MessageContentType.PRODUCT;
  }
}
