package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;

/**
 * Community management command family mirroring the embedded control surface exposed by the runtime.
 */
public record CommunityCommand(
  String commandId,
  SessionReference session,
  Action action,
  String communityJid,
  String subject,
  String description,
  String groupJid,
  List<String> participants,
  GroupCommand.ParticipantAction participantAction,
  GroupCommand.JoinRequestAction requestAction,
  String inviteCode,
  Integer ephemeralExpiration,
  GroupCommand.Setting setting,
  GroupCommand.MemberAddMode memberAddMode,
  GroupCommand.JoinApprovalMode joinApprovalMode
)
implements OutboundCommand
{
  public enum Action
  {
    METADATA("metadata"),
    CREATE("create"),
    CREATE_GROUP("create_group"),
    LEAVE("leave"),
    UPDATE_SUBJECT("update_subject"),
    UPDATE_DESCRIPTION("update_description"),
    LINK_GROUP("link_group"),
    UNLINK_GROUP("unlink_group"),
    FETCH_LINKED_GROUPS("fetch_linked_groups"),
    REQUEST_PARTICIPANTS_LIST("request_participants_list"),
    REQUEST_PARTICIPANTS_UPDATE("request_participants_update"),
    PARTICIPANTS_UPDATE("participants_update"),
    INVITE_CODE("invite_code"),
    REVOKE_INVITE("revoke_invite"),
    ACCEPT_INVITE("accept_invite"),
    GET_INVITE_INFO("get_invite_info"),
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

      throw new IllegalArgumentException("Unsupported community action \"" + wireValue + "\".");
    }
  }
}
