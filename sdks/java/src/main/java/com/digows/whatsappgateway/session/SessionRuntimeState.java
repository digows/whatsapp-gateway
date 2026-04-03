package com.digows.whatsappgateway.session;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum SessionRuntimeState
{
  NEW("new"),
  STARTING("starting"),
  CONNECTED("connected"),
  RECONNECTING("reconnecting"),
  STOPPING("stopping"),
  STOPPED("stopped"),
  FAILED("failed"),
  LOGGED_OUT("logged_out");

  private final String wireValue;

  SessionRuntimeState(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static SessionRuntimeState fromWireValue(String wireValue)
  {
    for (SessionRuntimeState value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported session runtime state \"" + wireValue + "\".");
  }
}
