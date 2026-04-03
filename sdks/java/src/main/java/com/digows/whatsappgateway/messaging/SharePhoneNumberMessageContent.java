package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("share_phone_number")
@JsonIgnoreProperties(ignoreUnknown = true)
public record SharePhoneNumberMessageContent() implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.SHARE_PHONE_NUMBER;
  }
}
