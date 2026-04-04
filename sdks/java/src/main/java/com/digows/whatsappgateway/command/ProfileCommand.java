package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;

/**
 * Profile and account command family.
 */
public record ProfileCommand(
  String commandId,
  SessionReference session,
  Action action,
  String jid,
  PictureType pictureType,
  String mediaUrl,
  MediaDimensions dimensions,
  String statusText,
  String profileName,
  BlockAction blockAction,
  List<String> jids
)
implements OutboundCommand
{
  public enum Action
  {
    PROFILE_PICTURE_URL("profile_picture_url"),
    UPDATE_PROFILE_PICTURE("update_profile_picture"),
    REMOVE_PROFILE_PICTURE("remove_profile_picture"),
    UPDATE_PROFILE_STATUS("update_profile_status"),
    UPDATE_PROFILE_NAME("update_profile_name"),
    UPDATE_BLOCK_STATUS("update_block_status"),
    FETCH_BLOCKLIST("fetch_blocklist"),
    FETCH_STATUS("fetch_status"),
    FETCH_DISAPPEARING_DURATION("fetch_disappearing_duration"),
    GET_BUSINESS_PROFILE("get_business_profile");

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

      throw new IllegalArgumentException("Unsupported profile action \"" + wireValue + "\".");
    }
  }

  public enum PictureType
  {
    PREVIEW("preview"),
    IMAGE("image");

    private final String wireValue;

    PictureType(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static PictureType fromWireValue(String wireValue)
    {
      for (PictureType value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported picture type \"" + wireValue + "\".");
    }
  }

  public enum BlockAction
  {
    BLOCK("block"),
    UNBLOCK("unblock");

    private final String wireValue;

    BlockAction(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static BlockAction fromWireValue(String wireValue)
    {
      for (BlockAction value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported block action \"" + wireValue + "\".");
    }
  }

  public record MediaDimensions(
    int width,
    int height
  )
  {
  }
}
