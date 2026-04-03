package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum EventCallType
{
  AUDIO("audio"),
  VIDEO("video");

  private final String wireValue;

  EventCallType(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static EventCallType fromWireValue(String wireValue)
  {
    for (EventCallType value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported event call type \"" + wireValue + "\".");
  }
}
