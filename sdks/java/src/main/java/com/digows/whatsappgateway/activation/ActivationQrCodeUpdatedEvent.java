package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("activation.qr.updated")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ActivationQrCodeUpdatedEvent(
  String commandId,
  String correlationId,
  String activationId,
  SessionReference session,
  String timestamp,
  String qrCode,
  int sequence,
  String expiresAt
) implements ActivationEvent
{
  @Override
  public ActivationEventType eventType()
  {
    return ActivationEventType.QR_CODE_UPDATED;
  }
}
