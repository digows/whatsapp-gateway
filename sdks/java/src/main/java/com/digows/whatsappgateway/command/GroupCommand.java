package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;

/**
 * Group management command family covering metadata, participants, settings and invite flows.
 */
public record GroupCommand(
  String commandId,
  SessionReference session,
  Action action,
  String groupJid,
  String subject,
  String description,
  List<String> participants,
  ParticipantAction participantAction,
  JoinRequestAction requestAction,
  String inviteCode,
  Integer ephemeralExpiration,
  Setting setting,
  MemberAddMode memberAddMode,
  JoinApprovalMode joinApprovalMode
)
implements OutboundCommand
{
  public enum Action
  {
    METADATA("metadata"),
    CREATE("create"),
    LEAVE("leave"),
    UPDATE_SUBJECT("update_subject"),
    UPDATE_DESCRIPTION("update_description"),
    INVITE_CODE("invite_code"),
    REVOKE_INVITE("revoke_invite"),
    ACCEPT_INVITE("accept_invite"),
    GET_INVITE_INFO("get_invite_info"),
    PARTICIPANTS_UPDATE("participants_update"),
    REQUEST_PARTICIPANTS_LIST("request_participants_list"),
    REQUEST_PARTICIPANTS_UPDATE("request_participants_update"),
    TOGGLE_EPHEMERAL("toggle_ephemeral"),
    SETTING_UPDATE("setting_update"),
    MEMBER_ADD_MODE("member_add_mode"),
    JOIN_APPROVAL_MODE("join_approval_mode"),
    FETCH_ALL_PARTICIPATING("fetch_all_participating");

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

      throw new IllegalArgumentException("Unsupported group action \"" + wireValue + "\".");
    }
  }

  public enum ParticipantAction
  {
    ADD("add"),
    REMOVE("remove"),
    PROMOTE("promote"),
    DEMOTE("demote"),
    MODIFY("modify");

    private final String wireValue;

    ParticipantAction(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static ParticipantAction fromWireValue(String wireValue)
    {
      for (ParticipantAction value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported participant action \"" + wireValue + "\".");
    }
  }

  public enum JoinRequestAction
  {
    APPROVE("approve"),
    REJECT("reject");

    private final String wireValue;

    JoinRequestAction(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static JoinRequestAction fromWireValue(String wireValue)
    {
      for (JoinRequestAction value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported join request action \"" + wireValue + "\".");
    }
  }

  public enum Setting
  {
    ANNOUNCEMENT("announcement"),
    NOT_ANNOUNCEMENT("not_announcement"),
    LOCKED("locked"),
    UNLOCKED("unlocked");

    private final String wireValue;

    Setting(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static Setting fromWireValue(String wireValue)
    {
      for (Setting value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported group setting \"" + wireValue + "\".");
    }
  }

  public enum MemberAddMode
  {
    ADMIN_ADD("admin_add"),
    ALL_MEMBER_ADD("all_member_add");

    private final String wireValue;

    MemberAddMode(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static MemberAddMode fromWireValue(String wireValue)
    {
      for (MemberAddMode value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported member-add mode \"" + wireValue + "\".");
    }
  }

  public enum JoinApprovalMode
  {
    ON("on"),
    OFF("off");

    private final String wireValue;

    JoinApprovalMode(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static JoinApprovalMode fromWireValue(String wireValue)
    {
      for (JoinApprovalMode value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported join-approval mode \"" + wireValue + "\".");
    }
  }
}
