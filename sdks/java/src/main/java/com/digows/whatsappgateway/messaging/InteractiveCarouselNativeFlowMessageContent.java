package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record InteractiveCarouselNativeFlowMessageContent(
  List<InteractiveCarouselNativeFlowButton> buttons,
  String messageParamsJson,
  Integer messageVersion
)
{
  public InteractiveCarouselNativeFlowMessageContent
  {
    if (buttons == null || buttons.isEmpty())
    {
      throw new IllegalArgumentException("InteractiveCarouselNativeFlowMessageContent requires at least one button.");
    }

    if (messageVersion == null)
    {
      messageVersion = 1;
    }
  }
}
