package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum PinMessageDurationSeconds
{
  ONE_DAY(86400),
  SEVEN_DAYS(604800),
  THIRTY_DAYS(2592000);

  private final int wireValue;

  PinMessageDurationSeconds(int wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public int getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static PinMessageDurationSeconds fromWireValue(int wireValue)
  {
    for (PinMessageDurationSeconds value : values())
    {
      if (value.wireValue == wireValue)
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported pin duration \"" + wireValue + "\".");
  }
}
