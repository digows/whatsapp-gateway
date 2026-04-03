package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;
import java.util.List;

@JsonTypeName("contacts")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ContactsMessageContent(
  List<ContactCard> contacts,
  String displayName
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.CONTACTS;
  }
}
