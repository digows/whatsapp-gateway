package com.digows.whatsappgateway.command;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Generic execution status for outbound commands.
 */
public enum OutboundCommandResultStatus
{
  SUCCEEDED("succeeded"),
  FAILED("failed"),
  BLOCKED("blocked");

  private final String wireValue;

  OutboundCommandResultStatus(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static OutboundCommandResultStatus fromWireValue(String wireValue)
  {
    for (OutboundCommandResultStatus value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported outbound command result status \"" + wireValue + "\".");
  }
}
