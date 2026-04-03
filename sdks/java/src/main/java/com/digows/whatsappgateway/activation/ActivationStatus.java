package com.digows.whatsappgateway.activation;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum ActivationStatus
{
  QR_CODE_READY("qr_code_ready"),
  PAIRING_CODE_READY("pairing_code_ready"),
  COMPLETED("completed"),
  FAILED("failed"),
  EXPIRED("expired"),
  CANCELLED("cancelled");

  private final String wireValue;

  ActivationStatus(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static ActivationStatus fromWireValue(String wireValue)
  {
    for (ActivationStatus value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported activation status \"" + wireValue + "\".");
  }
}
