package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("group_invite")
@JsonIgnoreProperties(ignoreUnknown = true)
public record GroupInviteMessageContent(
  String groupJid,
  String inviteCode,
  String groupName,
  String caption,
  Long inviteExpiration
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.GROUP_INVITE;
  }
}
