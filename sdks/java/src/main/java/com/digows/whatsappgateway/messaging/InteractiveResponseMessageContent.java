package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("interactive_response")
@JsonIgnoreProperties(ignoreUnknown = true)
public record InteractiveResponseMessageContent(
  String bodyText,
  String flowName,
  String parametersJson,
  Integer version
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.INTERACTIVE_RESPONSE;
  }
}
