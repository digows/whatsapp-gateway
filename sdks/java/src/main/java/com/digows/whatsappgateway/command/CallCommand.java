package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Call-related command family.
 */
public record CallCommand(
  String commandId,
  SessionReference session,
  Action action,
  String callId,
  String callFrom,
  CallType callType,
  Long startTime,
  Integer timeoutMs
)
implements OutboundCommand
{
  public enum Action
  {
    REJECT("reject"),
    CREATE_LINK("create_link");

    private final String wireValue;

    Action(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static Action fromWireValue(String wireValue)
    {
      for (Action value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported call action \"" + wireValue + "\".");
    }
  }

  public enum CallType
  {
    AUDIO("audio"),
    VIDEO("video");

    private final String wireValue;

    CallType(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static CallType fromWireValue(String wireValue)
    {
      for (CallType value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported call type \"" + wireValue + "\".");
    }
  }
}
