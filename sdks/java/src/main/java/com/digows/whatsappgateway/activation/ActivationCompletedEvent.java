package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("activation.completed")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ActivationCompletedEvent(
  String commandId,
  String correlationId,
  String activationId,
  SessionReference session,
  String timestamp,
  ActivationMode mode
) implements ActivationEvent
{
  @Override
  public ActivationEventType eventType()
  {
    return ActivationEventType.COMPLETED;
  }
}
