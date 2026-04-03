package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("activation.pairing_code.updated")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ActivationPairingCodeUpdatedEvent(
  String commandId,
  String correlationId,
  String activationId,
  SessionReference session,
  String timestamp,
  String pairingCode,
  int sequence,
  String phoneNumber,
  String expiresAt
) implements ActivationEvent
{
  @Override
  public ActivationEventType eventType()
  {
    return ActivationEventType.PAIRING_CODE_UPDATED;
  }
}
