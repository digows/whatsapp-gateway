package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Privacy settings command family.
 */
public record PrivacyCommand(
  String commandId,
  SessionReference session,
  Action action,
  Boolean previewsDisabled,
  CallPrivacyValue callPrivacy,
  MessagesPrivacyValue messagesPrivacy,
  PrivacyValue lastSeenPrivacy,
  OnlinePrivacyValue onlinePrivacy,
  PrivacyValue profilePicturePrivacy,
  PrivacyValue statusPrivacy,
  ReadReceiptsPrivacyValue readReceiptsPrivacy,
  GroupsAddPrivacyValue groupsAddPrivacy,
  Integer defaultDisappearingModeSeconds
)
implements OutboundCommand
{
  public enum Action
  {
    FETCH_SETTINGS("fetch_settings"),
    UPDATE_DISABLE_LINK_PREVIEWS("update_disable_link_previews"),
    UPDATE_CALL_PRIVACY("update_call_privacy"),
    UPDATE_MESSAGES_PRIVACY("update_messages_privacy"),
    UPDATE_LAST_SEEN_PRIVACY("update_last_seen_privacy"),
    UPDATE_ONLINE_PRIVACY("update_online_privacy"),
    UPDATE_PROFILE_PICTURE_PRIVACY("update_profile_picture_privacy"),
    UPDATE_STATUS_PRIVACY("update_status_privacy"),
    UPDATE_READ_RECEIPTS_PRIVACY("update_read_receipts_privacy"),
    UPDATE_GROUPS_ADD_PRIVACY("update_groups_add_privacy"),
    UPDATE_DEFAULT_DISAPPEARING_MODE("update_default_disappearing_mode");

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

      throw new IllegalArgumentException("Unsupported privacy action \"" + wireValue + "\".");
    }
  }

  public enum PrivacyValue
  {
    ALL("all"),
    CONTACTS("contacts"),
    CONTACT_BLACKLIST("contact_blacklist"),
    NONE("none");

    private final String wireValue;

    PrivacyValue(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static PrivacyValue fromWireValue(String wireValue)
    {
      for (PrivacyValue value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported privacy value \"" + wireValue + "\".");
    }
  }

  public enum OnlinePrivacyValue
  {
    ALL("all"),
    MATCH_LAST_SEEN("match_last_seen");

    private final String wireValue;

    OnlinePrivacyValue(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static OnlinePrivacyValue fromWireValue(String wireValue)
    {
      for (OnlinePrivacyValue value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported online privacy value \"" + wireValue + "\".");
    }
  }

  public enum GroupsAddPrivacyValue
  {
    ALL("all"),
    CONTACTS("contacts"),
    CONTACT_BLACKLIST("contact_blacklist");

    private final String wireValue;

    GroupsAddPrivacyValue(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static GroupsAddPrivacyValue fromWireValue(String wireValue)
    {
      for (GroupsAddPrivacyValue value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported groups-add privacy value \"" + wireValue + "\".");
    }
  }

  public enum ReadReceiptsPrivacyValue
  {
    ALL("all"),
    NONE("none");

    private final String wireValue;

    ReadReceiptsPrivacyValue(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static ReadReceiptsPrivacyValue fromWireValue(String wireValue)
    {
      for (ReadReceiptsPrivacyValue value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported read-receipts privacy value \"" + wireValue + "\".");
    }
  }

  public enum CallPrivacyValue
  {
    ALL("all"),
    KNOWN("known");

    private final String wireValue;

    CallPrivacyValue(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static CallPrivacyValue fromWireValue(String wireValue)
    {
      for (CallPrivacyValue value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported call privacy value \"" + wireValue + "\".");
    }
  }

  public enum MessagesPrivacyValue
  {
    ALL("all"),
    CONTACTS("contacts");

    private final String wireValue;

    MessagesPrivacyValue(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static MessagesPrivacyValue fromWireValue(String wireValue)
    {
      for (MessagesPrivacyValue value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported messages privacy value \"" + wireValue + "\".");
    }
  }
}
