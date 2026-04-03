package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonIgnoreProperties(ignoreUnknown = true)
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type", visible = true)
@JsonSubTypes({
  @JsonSubTypes.Type(value = TextMessageContent.class, name = "text"),
  @JsonSubTypes.Type(value = ImageMessageContent.class, name = "image"),
  @JsonSubTypes.Type(value = AudioMessageContent.class, name = "audio"),
  @JsonSubTypes.Type(value = VideoMessageContent.class, name = "video"),
  @JsonSubTypes.Type(value = DocumentMessageContent.class, name = "document"),
  @JsonSubTypes.Type(value = StickerMessageContent.class, name = "sticker"),
  @JsonSubTypes.Type(value = ContactsMessageContent.class, name = "contacts"),
  @JsonSubTypes.Type(value = LocationMessageContent.class, name = "location"),
  @JsonSubTypes.Type(value = ReactionMessageContent.class, name = "reaction"),
  @JsonSubTypes.Type(value = PollMessageContent.class, name = "poll"),
  @JsonSubTypes.Type(value = ButtonReplyMessageContent.class, name = "button_reply"),
  @JsonSubTypes.Type(value = ListReplyMessageContent.class, name = "list_reply"),
  @JsonSubTypes.Type(value = GroupInviteMessageContent.class, name = "group_invite"),
  @JsonSubTypes.Type(value = EventMessageContent.class, name = "event"),
  @JsonSubTypes.Type(value = ProductMessageContent.class, name = "product"),
  @JsonSubTypes.Type(value = InteractiveResponseMessageContent.class, name = "interactive_response"),
  @JsonSubTypes.Type(value = RequestPhoneNumberMessageContent.class, name = "request_phone_number"),
  @JsonSubTypes.Type(value = SharePhoneNumberMessageContent.class, name = "share_phone_number"),
  @JsonSubTypes.Type(value = DeleteMessageContent.class, name = "delete"),
  @JsonSubTypes.Type(value = PinMessageContent.class, name = "pin"),
  @JsonSubTypes.Type(value = DisappearingMessagesMessageContent.class, name = "disappearing_messages"),
  @JsonSubTypes.Type(value = LimitSharingMessageContent.class, name = "limit_sharing"),
  @JsonSubTypes.Type(value = OtherMessageContent.class, name = "other")
})
public sealed interface MessageContent permits
  TextMessageContent,
  ImageMessageContent,
  AudioMessageContent,
  VideoMessageContent,
  DocumentMessageContent,
  StickerMessageContent,
  ContactsMessageContent,
  LocationMessageContent,
  ReactionMessageContent,
  PollMessageContent,
  ButtonReplyMessageContent,
  ListReplyMessageContent,
  GroupInviteMessageContent,
  EventMessageContent,
  ProductMessageContent,
  InteractiveResponseMessageContent,
  RequestPhoneNumberMessageContent,
  SharePhoneNumberMessageContent,
  DeleteMessageContent,
  PinMessageContent,
  DisappearingMessagesMessageContent,
  LimitSharingMessageContent,
  OtherMessageContent
{
  MessageContentType type();
}
