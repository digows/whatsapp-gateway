package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.command.OutboundCommand;
import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Outbound command that sends one WhatsApp message through one hosted session.
 * It is published on the message command family subject.
 */
public record SendMessageCommand(
  String commandId,
  SessionReference session,
  Message message
)
implements OutboundCommand
{
  @JsonProperty("action")
  public String action()
  {
    return "send";
  }
}
