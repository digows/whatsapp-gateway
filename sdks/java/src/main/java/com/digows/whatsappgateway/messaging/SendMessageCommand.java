package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;

public record SendMessageCommand(
  String commandId,
  SessionReference session,
  Message message
)
{
}
