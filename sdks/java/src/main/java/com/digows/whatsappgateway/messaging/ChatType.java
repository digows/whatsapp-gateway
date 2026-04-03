package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum ChatType
{
  DIRECT("direct"),
  GROUP("group"),
  BROADCAST("broadcast"),
  UNKNOWN("unknown");

  private final String wireValue;

  ChatType(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static ChatType fromWireValue(String wireValue)
  {
    for (ChatType value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported chat type \"" + wireValue + "\".");
  }
}
