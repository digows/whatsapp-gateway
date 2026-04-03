package com.digows.whatsappgateway.session;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum SessionDesiredState
{
  ACTIVE("active"),
  PAUSED("paused"),
  STOPPED("stopped");

  private final String wireValue;

  SessionDesiredState(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static SessionDesiredState fromWireValue(String wireValue)
  {
    for (SessionDesiredState value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported session desired state \"" + wireValue + "\".");
  }
}
