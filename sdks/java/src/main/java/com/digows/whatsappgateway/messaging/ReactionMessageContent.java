package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("reaction")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ReactionMessageContent(
  MessageReference targetMessage,
  String reactionText,
  boolean removed
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.REACTION;
  }
}
