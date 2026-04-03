package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum ButtonReplyType
{
  TEMPLATE("template"),
  PLAIN("plain");

  private final String wireValue;

  ButtonReplyType(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static ButtonReplyType fromWireValue(String wireValue)
  {
    for (ButtonReplyType value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported button reply type \"" + wireValue + "\".");
  }
}
