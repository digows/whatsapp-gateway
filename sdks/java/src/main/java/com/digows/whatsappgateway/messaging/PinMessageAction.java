package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum PinMessageAction
{
  PIN_FOR_ALL("pin_for_all"),
  UNPIN_FOR_ALL("unpin_for_all");

  private final String wireValue;

  PinMessageAction(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static PinMessageAction fromWireValue(String wireValue)
  {
    for (PinMessageAction value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported pin action \"" + wireValue + "\".");
  }
}
