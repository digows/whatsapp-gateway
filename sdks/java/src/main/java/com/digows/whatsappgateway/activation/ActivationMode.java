package com.digows.whatsappgateway.activation;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum ActivationMode
{
  QR_CODE("qr"),
  PAIRING_CODE("pairing_code");

  private final String wireValue;

  ActivationMode(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static ActivationMode fromWireValue(String wireValue)
  {
    for (ActivationMode value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported activation mode \"" + wireValue + "\".");
  }
}
