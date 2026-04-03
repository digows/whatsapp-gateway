package com.digows.whatsappgateway.rest;

import com.digows.whatsappgateway.activation.ActivationMode;

public record PairingCodeActivationRequest(
  ActivationMode mode,
  String sessionId,
  String phoneNumber,
  String customPairingCode,
  Integer waitTimeoutMs
)
{
  public PairingCodeActivationRequest
  {
    if (mode != ActivationMode.PAIRING_CODE)
    {
      throw new IllegalArgumentException("PairingCodeActivationRequest requires mode PAIRING_CODE.");
    }
    if (phoneNumber == null || phoneNumber.isBlank())
    {
      throw new IllegalArgumentException("PairingCodeActivationRequest requires a non-empty phoneNumber.");
    }
  }
}
