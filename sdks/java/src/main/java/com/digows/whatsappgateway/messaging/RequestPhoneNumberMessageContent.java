package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("request_phone_number")
@JsonIgnoreProperties(ignoreUnknown = true)
public record RequestPhoneNumberMessageContent() implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.REQUEST_PHONE_NUMBER;
  }
}
