package com.digows.whatsappgateway.messaging;

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
