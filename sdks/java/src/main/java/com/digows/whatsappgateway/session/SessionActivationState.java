package com.digows.whatsappgateway.session;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum SessionActivationState
{
  IDLE("idle"),
  AWAITING_QR_CODE("awaiting_qr_code"),
  AWAITING_PAIRING_CODE("awaiting_pairing_code"),
  COMPLETED("completed"),
  EXPIRED("expired"),
  FAILED("failed"),
  CANCELLED("cancelled");

  private final String wireValue;

  SessionActivationState(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static SessionActivationState fromWireValue(String wireValue)
  {
    for (SessionActivationState value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported session activation state \"" + wireValue + "\".");
  }
}
