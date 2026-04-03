package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("limit_sharing")
@JsonIgnoreProperties(ignoreUnknown = true)
public record LimitSharingMessageContent(
  boolean sharingLimited,
  Long updatedTimestamp,
  Boolean initiatedByMe
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.LIMIT_SHARING;
  }
}
