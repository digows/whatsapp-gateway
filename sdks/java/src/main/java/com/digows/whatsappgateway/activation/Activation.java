package com.digows.whatsappgateway.activation;

import com.digows.whatsappgateway.operational.SessionReference;

public record Activation(
  String commandId,
  String correlationId,
  String activationId,
  SessionReference session,
  ActivationMode mode,
  ActivationStatus status,
  String startedAt,
  String eventSubject,
  String qrCodeText,
  String qrCodeBase64,
  String pairingCode,
  String phoneNumber,
  String failureReason
)
{
}
