package com.digows.whatsappgateway.messaging;

public record Message(
  String chatId,
  String timestamp,
  MessageContent content,
  String messageId,
  String senderId,
  String participantId,
  MessageContext context
)
{
}
