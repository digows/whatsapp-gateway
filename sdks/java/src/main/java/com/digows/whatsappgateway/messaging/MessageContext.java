package com.digows.whatsappgateway.messaging;

import java.util.List;

/**
 * WhatsApp-specific metadata extracted from the transport envelope around a message.
 *
 * @param chatType normalized chat classification
 * @param remoteJid raw WhatsApp chat JID
 * @param participantId raw participant JID when the message belongs to a group context
 * @param senderPhone resolved sender phone number when available
 * @param mentionedJids raw JIDs mentioned by the message
 * @param quotedMessage quoted message metadata when the message is a reply
 * @param editTarget target message when the payload represents an edit lifecycle
 * @param forwarded whether WhatsApp flagged the message as forwarded
 * @param forwardingScore WhatsApp forwarding score when available
 * @param expirationSeconds disappearing message TTL when available
 * @param viewOnce whether the message was delivered inside a view-once envelope
 */
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
