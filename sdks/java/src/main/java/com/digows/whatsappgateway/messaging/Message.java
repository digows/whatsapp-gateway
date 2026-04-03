package com.digows.whatsappgateway.messaging;

/**
 * Canonical normalized WhatsApp message exposed by the gateway.
 * Direction is defined by the event or command carrying the message, not by this entity itself.
 *
 * @param chatId normalized chat identifier
 * @param timestamp message timestamp in ISO-8601 format
 * @param content normalized message content
 * @param messageId WhatsApp message identifier when available
 * @param senderId normalized sender identifier when available
 * @param participantId participant identifier for group contexts when available
 * @param context WhatsApp-specific envelope metadata
 */
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
