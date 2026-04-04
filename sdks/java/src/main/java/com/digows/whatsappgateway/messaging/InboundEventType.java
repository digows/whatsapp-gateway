package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Supported top-level message lifecycle categories emitted by the gateway.
 * The lifecycle intentionally stays compact: create, update and delete.
 */
public enum InboundEventType
{
  MESSAGE_CREATED("message.created"),
  MESSAGE_UPDATED("message.updated"),
  MESSAGE_DELETED("message.deleted");

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
