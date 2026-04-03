package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Explicit classification of which part of a message lifecycle changed.
 * A single {@link MessageUpdatedEvent} may contain more than one kind because WhatsApp can
 * batch status, stub, poll and content changes in the same update.
 */
public enum MessageUpdateKind
{
  CONTENT("content"),
  STATUS("status"),
  STUB("stub"),
  POLL("poll"),
  REACTION("reaction");

  private final String wireValue;

  MessageUpdateKind(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static MessageUpdateKind fromWireValue(String wireValue)
  {
    for (MessageUpdateKind value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported message update kind \"" + wireValue + "\".");
  }
}
