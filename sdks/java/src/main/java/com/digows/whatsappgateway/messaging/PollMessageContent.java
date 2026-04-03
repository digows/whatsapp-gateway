package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;
import java.util.List;

@JsonTypeName("poll")
@JsonIgnoreProperties(ignoreUnknown = true)
public record PollMessageContent(
  String name,
  List<PollOption> options,
  int selectableCount
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.POLL;
  }
}
