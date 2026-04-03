package com.digows.whatsappgateway.messaging;

import java.util.List;

public record MessageContext(
  ChatType chatType,
  String remoteJid,
  String participantId,
  String senderPhone,
  List<String> mentionedJids,
  QuotedMessage quotedMessage,
  MessageReference editTarget,
  boolean forwarded,
  Integer forwardingScore,
  Integer expirationSeconds,
  boolean viewOnce
)
{
}
