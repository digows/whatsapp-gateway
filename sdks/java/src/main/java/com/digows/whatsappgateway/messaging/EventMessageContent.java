package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("event")
@JsonIgnoreProperties(ignoreUnknown = true)
public record EventMessageContent(
  String name,
  Long startTimestamp,
  String description,
  Long endTimestamp,
  LocationMessageContent location,
  String joinLink,
  EventCallType callType,
  boolean cancelled,
  boolean scheduledCall,
  boolean extraGuestsAllowed,
  boolean hasReminder,
  Integer reminderOffsetSeconds
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.EVENT;
  }
}
