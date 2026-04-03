package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

/**
 * Normalized reaction payload represented as message content.
 * Live reaction lifecycle is exposed through {@link MessageUpdatedEvent} with
 * {@link MessageUpdateKind#REACTION}; this content subtype exists so quoted or embedded
 * WhatsApp payloads can still be normalized.
 *
 * @param targetMessage logical message receiving the reaction
 * @param reactionText current reaction text when present
 * @param removed whether the reaction lifecycle moved to the removed state
 */
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
