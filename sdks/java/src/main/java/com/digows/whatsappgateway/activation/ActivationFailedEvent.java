package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("activation.failed")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ActivationFailedEvent(
  String commandId,
  String correlationId,
  String activationId,
  SessionReference session,
  String timestamp,
  String reason,
  boolean retryable
) implements ActivationEvent
{
  @Override
  public ActivationEventType eventType()
  {
    return ActivationEventType.FAILED;
  }
}
