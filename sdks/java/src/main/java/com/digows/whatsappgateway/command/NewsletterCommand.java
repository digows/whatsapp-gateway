package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Newsletter/channel command family.
 */
public record NewsletterCommand(
  String commandId,
  SessionReference session,
  Action action,
  String newsletterJid,
  String name,
  String description,
  String pictureUrl,
  LookupType lookupType,
  String lookupKey,
  String serverId,
  String reactionText,
  Integer count,
  Integer since,
  Integer after,
  String newOwnerJid,
  String userJid
)
implements OutboundCommand
{
  public enum Action
  {
    CREATE("create"),
    UPDATE("update"),
    SUBSCRIBERS("subscribers"),
    METADATA("metadata"),
    FOLLOW("follow"),
    UNFOLLOW("unfollow"),
    MUTE("mute"),
    UNMUTE("unmute"),
    REACT_MESSAGE("react_message"),
    FETCH_MESSAGES("fetch_messages"),
    SUBSCRIBE_UPDATES("subscribe_updates"),
    ADMIN_COUNT("admin_count"),
    CHANGE_OWNER("change_owner"),
    DEMOTE("demote"),
    DELETE("delete");

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

      throw new IllegalArgumentException("Unsupported newsletter action \"" + wireValue + "\".");
    }
  }

  public enum LookupType
  {
    INVITE("invite"),
    JID("jid");

    private final String wireValue;

    LookupType(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static LookupType fromWireValue(String wireValue)
    {
      for (LookupType value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported newsletter lookup type \"" + wireValue + "\".");
    }
  }
}
