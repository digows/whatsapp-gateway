package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum InboundEventType
{
  MESSAGE_RECEIVED("message.received"),
  MESSAGE_UPDATED("message.updated"),
  MESSAGE_REACTION("message.reaction");

  private final String wireValue;

  InboundEventType(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static InboundEventType fromWireValue(String wireValue)
  {
    for (InboundEventType value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported inbound event type \"" + wireValue + "\".");
  }
}
