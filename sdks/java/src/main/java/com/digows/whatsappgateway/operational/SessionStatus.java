package com.digows.whatsappgateway.operational;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum SessionStatus
{
  STARTING("starting"),
  STOPPING("stopping"),
  STOPPED("stopped"),
  FAILED("failed"),
  CONNECTED("connected"),
  RECONNECTING("reconnecting"),
  LOGGED_OUT("logged_out");

  private final String wireValue;

  SessionStatus(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static SessionStatus fromWireValue(String wireValue)
  {
    for (SessionStatus value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported session status \"" + wireValue + "\".");
  }
}
