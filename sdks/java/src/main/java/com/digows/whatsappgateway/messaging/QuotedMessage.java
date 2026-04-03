package com.digows.whatsappgateway.messaging;

public record QuotedMessage(
  MessageReference reference,
  MessageContent content
)
{
}
