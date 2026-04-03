package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("button_reply")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ButtonReplyMessageContent(
  String buttonId,
  String displayText,
  ButtonReplyType replyType,
  Integer buttonIndex
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.BUTTON_REPLY;
  }
}
