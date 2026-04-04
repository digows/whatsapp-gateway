package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.messaging.SendMessageCommand;
import com.digows.whatsappgateway.operational.SessionReference;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * Base contract for outbound commands consumed by the gateway runtime on family-specific NATS command subjects.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "family")
@JsonSubTypes({
  @JsonSubTypes.Type(value = SendMessageCommand.class, name = "message"),
  @JsonSubTypes.Type(value = PresenceCommand.class, name = "presence"),
  @JsonSubTypes.Type(value = ReadCommand.class, name = "read"),
  @JsonSubTypes.Type(value = ChatCommand.class, name = "chat"),
  @JsonSubTypes.Type(value = GroupCommand.class, name = "group"),
  @JsonSubTypes.Type(value = CommunityCommand.class, name = "community"),
  @JsonSubTypes.Type(value = NewsletterCommand.class, name = "newsletter"),
  @JsonSubTypes.Type(value = ProfileCommand.class, name = "profile"),
  @JsonSubTypes.Type(value = PrivacyCommand.class, name = "privacy"),
  @JsonSubTypes.Type(value = CallCommand.class, name = "call")
})
public interface OutboundCommand
{
  String commandId();

  SessionReference session();
}
