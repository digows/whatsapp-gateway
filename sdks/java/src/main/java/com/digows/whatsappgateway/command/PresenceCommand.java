package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Presence command for subscribe/update flows such as composing, recording and paused.
 */
public record PresenceCommand(
  String commandId,
  SessionReference session,
  Action action,
  String chatId,
  PresenceType presence
)
implements OutboundCommand
{
  public enum Action
  {
    SUBSCRIBE("subscribe"),
    UPDATE("update");

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

      throw new IllegalArgumentException("Unsupported presence action \"" + wireValue + "\".");
    }
  }

  public enum PresenceType
  {
    UNAVAILABLE("unavailable"),
    AVAILABLE("available"),
    COMPOSING("composing"),
    RECORDING("recording"),
    PAUSED("paused");

    private final String wireValue;

    PresenceType(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static PresenceType fromWireValue(String wireValue)
    {
      for (PresenceType value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported presence type \"" + wireValue + "\".");
    }
  }
}
