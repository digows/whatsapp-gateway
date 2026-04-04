package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;

/**
 * Chat-level maintenance and lifecycle command family backed by Baileys `chatModify` and `star`.
 */
public record ChatCommand(
  String commandId,
  SessionReference session,
  Action action,
  String chatId,
  List<CommandMessageKey> lastMessages,
  CommandMessageKey targetMessage,
  List<CommandMessageKey> messageReferences,
  Long muteDurationMs,
  Boolean deleteMedia,
  Long deleteTimestamp
)
implements OutboundCommand
{
  public enum Action
  {
    ARCHIVE("archive"),
    UNARCHIVE("unarchive"),
    PIN("pin"),
    UNPIN("unpin"),
    MUTE("mute"),
    UNMUTE("unmute"),
    CLEAR("clear"),
    DELETE_FOR_ME("delete_for_me"),
    DELETE_CHAT("delete_chat"),
    MARK_READ("mark_read"),
    MARK_UNREAD("mark_unread"),
    STAR("star"),
    UNSTAR("unstar");

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

      throw new IllegalArgumentException("Unsupported chat action \"" + wireValue + "\".");
    }
  }
}
