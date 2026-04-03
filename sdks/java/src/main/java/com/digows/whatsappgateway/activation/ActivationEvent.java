package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "eventType", visible = true)
@JsonSubTypes({
  @JsonSubTypes.Type(value = ActivationStartedEvent.class, name = "activation.started"),
  @JsonSubTypes.Type(value = ActivationQrCodeUpdatedEvent.class, name = "activation.qr.updated"),
  @JsonSubTypes.Type(value = ActivationPairingCodeUpdatedEvent.class, name = "activation.pairing_code.updated"),
  @JsonSubTypes.Type(value = ActivationCompletedEvent.class, name = "activation.completed"),
  @JsonSubTypes.Type(value = ActivationFailedEvent.class, name = "activation.failed"),
  @JsonSubTypes.Type(value = ActivationExpiredEvent.class, name = "activation.expired"),
  @JsonSubTypes.Type(value = ActivationCancelledEvent.class, name = "activation.cancelled")
})
public sealed interface ActivationEvent permits
  ActivationStartedEvent,
  ActivationQrCodeUpdatedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationCompletedEvent,
  ActivationFailedEvent,
  ActivationExpiredEvent,
  ActivationCancelledEvent
{
  ActivationEventType eventType();

  String commandId();

  String correlationId();

  String activationId();

  SessionReference session();

  String timestamp();
}
