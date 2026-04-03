package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum DeliveryStatus
{
  SENT("sent"),
  FAILED("failed"),
  BLOCKED("blocked");

  private final String wireValue;

  DeliveryStatus(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static DeliveryStatus fromWireValue(String wireValue)
  {
    for (DeliveryStatus value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported delivery status \"" + wireValue + "\".");
  }
}
