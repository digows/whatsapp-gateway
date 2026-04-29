package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Supported normalized message content kinds exposed by the gateway.
 * Consumers should expect new values over time as the gateway gains support for more
 * WhatsApp features.
 */
public enum MessageContentType
{
  TEXT("text"),
  IMAGE("image"),
  AUDIO("audio"),
  VIDEO("video"),
  DOCUMENT("document"),
  STICKER("sticker"),
  CONTACTS("contacts"),
  LOCATION("location"),
  REACTION("reaction"),
  POLL("poll"),
  BUTTON_REPLY("button_reply"),
  LIST_REPLY("list_reply"),
  GROUP_INVITE("group_invite"),
  EVENT("event"),
  PRODUCT("product"),
  INTERACTIVE_RESPONSE("interactive_response"),
  INTERACTIVE_CAROUSEL("interactive_carousel"),
  REQUEST_PHONE_NUMBER("request_phone_number"),
  SHARE_PHONE_NUMBER("share_phone_number"),
  DELETE("delete"),
  PIN("pin"),
  DISAPPEARING_MESSAGES("disappearing_messages"),
  LIMIT_SHARING("limit_sharing"),
  OTHER("other");

  private final String wireValue;

  MessageContentType(String wireValue)
  {
    this.wireValue = wireValue;
  }

  @JsonValue
  public String getWireValue()
  {
    return wireValue;
  }

  @JsonCreator
  public static MessageContentType fromWireValue(String wireValue)
  {
    for (MessageContentType value : values())
    {
      if (value.wireValue.equals(wireValue))
      {
        return value;
      }
    }

    throw new IllegalArgumentException("Unsupported message content type \"" + wireValue + "\".");
  }
}
