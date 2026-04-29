package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

@JsonIgnoreProperties(ignoreUnknown = true)
public record InteractiveCarouselNativeFlowButton(
  String name,
  String buttonParamsJson
)
{
  public InteractiveCarouselNativeFlowButton
  {
    if (name == null || name.isBlank())
    {
      throw new IllegalArgumentException("InteractiveCarouselNativeFlowButton requires a non-empty name.");
    }

    if (buttonParamsJson == null || buttonParamsJson.isBlank())
    {
      throw new IllegalArgumentException("InteractiveCarouselNativeFlowButton requires buttonParamsJson.");
    }
  }
}
