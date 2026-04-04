package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Polymorphic contract for message lifecycle events emitted by the gateway.
 * Consumers should branch on {@code eventType} instead of inferring lifecycle from
 * {@link MessageContent} alone. Reaction changes are represented as
 * {@link MessageUpdatedEvent} entries tagged with {@link MessageUpdateKind#REACTION}.
 * The rail can contain both remote-account and local-account messages; {@code fromMe}
 * on concrete event types defines the direction.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "eventType", visible = true)
@JsonSubTypes({
  @JsonSubTypes.Type(value = MessageCreatedEvent.class, name = "message.created"),
  @JsonSubTypes.Type(value = MessageUpdatedEvent.class, name = "message.updated"),
  @JsonSubTypes.Type(value = MessageDeletedEvent.class, name = "message.deleted")
})
public sealed interface InboundEvent permits
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent
{
  InboundEventType eventType();

  SessionReference session();

  String timestamp();
}
