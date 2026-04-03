package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "eventType", visible = true)
@JsonSubTypes({
  @JsonSubTypes.Type(value = ReceivedMessageEvent.class, name = "message.received"),
  @JsonSubTypes.Type(value = MessageUpdatedEvent.class, name = "message.updated"),
  @JsonSubTypes.Type(value = MessageReactionEvent.class, name = "message.reaction")
})
public sealed interface InboundEvent permits
  ReceivedMessageEvent,
  MessageUpdatedEvent,
  MessageReactionEvent
{
  InboundEventType eventType();

  SessionReference session();

  String timestamp();
}
