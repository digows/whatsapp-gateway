package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

/**
 * Normalized delete envelope carried by WhatsApp revoke messages.
 *
 * @param targetMessage logical message revoked from the timeline
 */
@JsonTypeName("delete")
@JsonIgnoreProperties(ignoreUnknown = true)
public record DeleteMessageContent(
  MessageReference targetMessage
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.DELETE;
  }
}
