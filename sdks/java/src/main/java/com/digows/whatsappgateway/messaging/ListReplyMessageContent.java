package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("list_reply")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ListReplyMessageContent(
  String selectedRowId,
  String title,
  String description
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.LIST_REPLY;
  }
}
