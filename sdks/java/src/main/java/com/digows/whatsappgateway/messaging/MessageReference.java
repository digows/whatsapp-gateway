package com.digows.whatsappgateway.messaging;

/**
 * Stable reference to an existing WhatsApp message.
 * It is used by lifecycle events and content such as replies, reactions, deletions and pins.
 *
 * @param messageId WhatsApp message identifier
 * @param remoteJid raw chat JID when available
 * @param participantId raw participant JID when available
 */
public record MessageReference(
  String messageId,
  String remoteJid,
  String participantId
)
{
  public MessageReference
  {
    if (messageId == null || messageId.isBlank())
    {
      throw new IllegalArgumentException("MessageReference requires a non-empty messageId.");
    }
  }
}
