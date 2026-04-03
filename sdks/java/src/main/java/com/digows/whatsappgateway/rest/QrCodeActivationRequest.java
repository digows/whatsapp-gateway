package com.digows.whatsappgateway.rest;

import com.digows.whatsappgateway.activation.ActivationMode;

public record QrCodeActivationRequest(
  ActivationMode mode,
  String sessionId,
  Integer waitTimeoutMs
)
{
  public QrCodeActivationRequest
  {
    if (mode != ActivationMode.QR_CODE)
    {
      throw new IllegalArgumentException("QrCodeActivationRequest requires mode QR_CODE.");
    }
  }
}
