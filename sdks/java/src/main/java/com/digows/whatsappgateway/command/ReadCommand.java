package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

import java.util.List;

/**
 * Read/receipt command family for explicit read markers and receipt emission.
 */
public record ReadCommand(
  String commandId,
  SessionReference session,
  Action action,
  List<CommandMessageKey> messages,
  String chatId,
  String participantId,
  List<String> messageIds,
  ReceiptType receiptType
)
implements OutboundCommand
{
  public enum Action
  {
    READ_MESSAGES("read_messages"),
    SEND_RECEIPT("send_receipt");

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

      throw new IllegalArgumentException("Unsupported read action \"" + wireValue + "\".");
    }
  }

  public enum ReceiptType
  {
    READ("read"),
    READ_SELF("read-self"),
    HIST_SYNC("hist_sync"),
    PEER_MSG("peer_msg"),
    SENDER("sender"),
    INACTIVE("inactive"),
    PLAYED("played");

    private final String wireValue;

    ReceiptType(String wireValue)
    {
      this.wireValue = wireValue;
    }

    @JsonValue
    public String getWireValue()
    {
      return wireValue;
    }

    @JsonCreator
    public static ReceiptType fromWireValue(String wireValue)
    {
      for (ReceiptType value : values())
      {
        if (value.wireValue.equals(wireValue))
        {
          return value;
        }
      }

      throw new IllegalArgumentException("Unsupported receipt type \"" + wireValue + "\".");
    }
  }
}
