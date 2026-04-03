package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("activation.cancelled")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ActivationCancelledEvent(
  String commandId,
  String correlationId,
  String activationId,
  SessionReference session,
  String timestamp,
  String reason
) implements ActivationEvent
{
  @Override
  public ActivationEventType eventType()
  {
    return ActivationEventType.CANCELLED;
  }
}
