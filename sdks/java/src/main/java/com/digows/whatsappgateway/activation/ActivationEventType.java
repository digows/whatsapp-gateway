package com.digows.whatsappgateway.activation;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum ActivationEventType
{
  STARTED("activation.started"),
  QR_CODE_UPDATED("activation.qr.updated"),
  PAIRING_CODE_UPDATED("activation.pairing_code.updated"),
  COMPLETED("activation.completed"),
  FAILED("activation.failed"),
  EXPIRED("activation.expired"),
  CANCELLED("activation.cancelled");

  private final String wireValue;

  ActivationEventType(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static ActivationEventType fromWireValue(String wireValue)
  {
    for (ActivationEventType value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported activation event type \"" + wireValue + "\".");
  }
}
