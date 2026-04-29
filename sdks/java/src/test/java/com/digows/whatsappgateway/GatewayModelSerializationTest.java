package com.digows.whatsappgateway;

import com.digows.whatsappgateway.activation.ActivationCompletedEvent;
import com.digows.whatsappgateway.activation.ActivationEvent;
import com.digows.whatsappgateway.activation.ActivationMode;
import com.digows.whatsappgateway.activation.ActivationQrCodeUpdatedEvent;
import com.digows.whatsappgateway.command.CommandMessageKey;
import com.digows.whatsappgateway.command.OutboundCommand;
import com.digows.whatsappgateway.command.OutboundCommandResult;
import com.digows.whatsappgateway.command.OutboundCommandResultStatus;
import com.digows.whatsappgateway.command.PresenceCommand;
import com.digows.whatsappgateway.command.ReadCommand;
import com.digows.whatsappgateway.messaging.ChatType;
import com.digows.whatsappgateway.messaging.DeleteMessageContent;
import com.digows.whatsappgateway.messaging.InboundEvent;
import com.digows.whatsappgateway.messaging.Message;
import com.digows.whatsappgateway.messaging.MessageContentType;
import com.digows.whatsappgateway.messaging.MessageContext;
import com.digows.whatsappgateway.messaging.MessageCreatedEvent;
import com.digows.whatsappgateway.messaging.MessageDeletedEvent;
import com.digows.whatsappgateway.messaging.InteractiveCarouselCardContent;
import com.digows.whatsappgateway.messaging.InteractiveCarouselMessageContent;
import com.digows.whatsappgateway.messaging.InteractiveCarouselNativeFlowButton;
import com.digows.whatsappgateway.messaging.InteractiveCarouselNativeFlowMessageContent;
import com.digows.whatsappgateway.messaging.MessageContent;
import com.digows.whatsappgateway.messaging.MessageReference;
import com.digows.whatsappgateway.messaging.MessageUpdatedEvent;
import com.digows.whatsappgateway.messaging.MessageUpdateKind;
import com.digows.whatsappgateway.messaging.PinMessageAction;
import com.digows.whatsappgateway.messaging.PinMessageContent;
import com.digows.whatsappgateway.messaging.PinMessageDurationSeconds;
import com.digows.whatsappgateway.messaging.TextMessageContent;
import com.digows.whatsappgateway.operational.SessionReference;
import com.digows.whatsappgateway.session.Session;
import com.digows.whatsappgateway.session.SessionActivationState;
import com.digows.whatsappgateway.session.SessionDesiredState;
import com.digows.whatsappgateway.session.SessionRuntimeState;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GatewayModelSerializationTest
{
  private final ObjectMapper objectMapper = new ObjectMapper();

  @Test
  void serializesAndDeserializesActivationEventsPolymorphically() throws Exception
  {
    ActivationEvent event = new ActivationQrCodeUpdatedEvent(
      "command-1",
      "correlation-1",
      "activation-1",
      new SessionReference("whatsapp-web", 1, "primary"),
      "2026-04-03T10:00:00Z",
      "qr-raw-payload",
      2,
      "2026-04-03T10:01:00Z"
    );

    String json = objectMapper.writeValueAsString(event);

    assertTrue(json.contains("\"eventType\":\"activation.qr.updated\""));

    ActivationEvent restored = objectMapper.readValue(json, ActivationEvent.class);
    ActivationQrCodeUpdatedEvent restoredEvent = assertInstanceOf(ActivationQrCodeUpdatedEvent.class, restored);
    assertEquals("qr-raw-payload", restoredEvent.qrCode());
    assertEquals(2, restoredEvent.sequence());
  }

  @Test
  void serializesAndDeserializesInboundEventsWithNestedMessageContentPolymorphically() throws Exception
  {
    InboundEvent event = new MessageCreatedEvent(
      new SessionReference("whatsapp-web", 2, "support"),
      "2026-04-03T10:10:00Z",
      new Message(
        "5511999999999@s.whatsapp.net",
        "2026-04-03T10:10:00Z",
        new TextMessageContent("hello", null, null, null),
        "wamid-123",
        "5511888888888@s.whatsapp.net",
        null,
        new MessageContext(
          ChatType.DIRECT,
          "5511999999999@s.whatsapp.net",
          null,
          "5511888888888",
          List.of("5511777777777@s.whatsapp.net"),
          null,
          null,
          false,
          null,
          null,
          false
        )
      ),
      true
    );

    String json = objectMapper.writeValueAsString(event);

    assertTrue(json.contains("\"eventType\":\"message.created\""));
    assertTrue(json.contains("\"type\":\"text\""));

    InboundEvent restored = objectMapper.readValue(json, InboundEvent.class);
    MessageCreatedEvent restoredEvent = assertInstanceOf(MessageCreatedEvent.class, restored);
    TextMessageContent content = assertInstanceOf(TextMessageContent.class, restoredEvent.message().content());
    assertEquals("hello", content.text());
    assertEquals(ChatType.DIRECT, restoredEvent.message().context().chatType());
    assertTrue(restoredEvent.fromMe());
  }

  @Test
  void serializesAndDeserializesMessageLifecycleUpdatesAndDeletions() throws Exception
  {
    MessageUpdatedEvent updatedEvent = new MessageUpdatedEvent(
      new SessionReference("whatsapp-web", 2, "support"),
      "2026-04-03T10:11:00Z",
      new MessageReference("wamid-target-1", "5511999999999@s.whatsapp.net", null),
      "5511999999999@s.whatsapp.net",
      "5511888888888@s.whatsapp.net",
      false,
      List.of(MessageUpdateKind.CONTENT, MessageUpdateKind.REACTION),
      new Message(
        "5511999999999@s.whatsapp.net",
        "2026-04-03T10:11:00Z",
        new TextMessageContent("edited hello", null, null, null),
        "wamid-edit-envelope",
        "5511888888888@s.whatsapp.net",
        null,
        new MessageContext(
          ChatType.DIRECT,
          "5511999999999@s.whatsapp.net",
          null,
          "5511888888888",
          List.of(),
          null,
          new MessageReference("wamid-target-1", "5511999999999@s.whatsapp.net", null),
          false,
          null,
          null,
          false
        )
      ),
      2,
      42,
      MessageContentType.TEXT,
      1,
      "🔥",
      false
    );

    String updatedJson = objectMapper.writeValueAsString(updatedEvent);
    assertTrue(updatedJson.contains("\"eventType\":\"message.updated\""));
    assertTrue(updatedJson.contains("\"reactionText\":\"🔥\""));

    InboundEvent restoredUpdated = objectMapper.readValue(updatedJson, InboundEvent.class);
    MessageUpdatedEvent restoredUpdatedEvent = assertInstanceOf(MessageUpdatedEvent.class, restoredUpdated);
    assertEquals(List.of(MessageUpdateKind.CONTENT, MessageUpdateKind.REACTION), restoredUpdatedEvent.updateKinds());
    assertEquals("wamid-target-1", restoredUpdatedEvent.targetMessage().messageId());
    assertEquals(MessageContentType.TEXT, restoredUpdatedEvent.contentType());
    assertEquals("🔥", restoredUpdatedEvent.reactionText());
    assertEquals(Boolean.FALSE, restoredUpdatedEvent.reactionRemoved());

    MessageDeletedEvent deletedEvent = new MessageDeletedEvent(
      new SessionReference("whatsapp-web", 2, "support"),
      "2026-04-03T10:12:00Z",
      new MessageReference("wamid-target-2", "5511999999999@s.whatsapp.net", null),
      "5511999999999@s.whatsapp.net",
      "5511888888888@s.whatsapp.net",
      false,
      new Message(
        "5511999999999@s.whatsapp.net",
        "2026-04-03T10:12:00Z",
        new DeleteMessageContent(
          new MessageReference("wamid-target-2", "5511999999999@s.whatsapp.net", null)
        ),
        "wamid-delete-envelope",
        "5511888888888@s.whatsapp.net",
        null,
        null
      )
    );

    String deletedJson = objectMapper.writeValueAsString(deletedEvent);
    assertTrue(deletedJson.contains("\"eventType\":\"message.deleted\""));

    InboundEvent restoredDeleted = objectMapper.readValue(deletedJson, InboundEvent.class);
    MessageDeletedEvent restoredDeletedEvent = assertInstanceOf(MessageDeletedEvent.class, restoredDeleted);
    assertEquals("wamid-target-2", restoredDeletedEvent.targetMessage().messageId());
    assertInstanceOf(DeleteMessageContent.class, restoredDeletedEvent.message().content());
  }

  @Test
  void serializesDurableSessionAndAdditionalMessageContentVariants() throws Exception
  {
    Session session = new Session(
      new SessionReference("whatsapp-web", 1, "primary"),
      SessionDesiredState.ACTIVE,
      SessionRuntimeState.CONNECTED,
      SessionActivationState.COMPLETED,
      true,
      "2026-04-03T09:00:00Z",
      "2026-04-03T10:00:00Z",
      "worker-1",
      "5511999999999",
      "5511999999999@s.whatsapp.net",
      null,
      "2026-04-03T09:30:00Z",
      null
    );

    String sessionJson = objectMapper.writeValueAsString(session);
    Session restoredSession = objectMapper.readValue(sessionJson, Session.class);
    assertEquals(SessionRuntimeState.CONNECTED, restoredSession.runtimeState());

    Message pinMessage = new Message(
      "120363000000000000@g.us",
      "2026-04-03T10:20:00Z",
      new PinMessageContent(
        new MessageReference("wamid-pin-target", "120363000000000000@g.us", "5511888888888@s.whatsapp.net"),
        PinMessageAction.PIN_FOR_ALL,
        PinMessageDurationSeconds.SEVEN_DAYS
      ),
      "wamid-pin-command",
      "5511888888888@s.whatsapp.net",
      "5511888888888@s.whatsapp.net",
      null
    );

    String messageJson = objectMapper.writeValueAsString(pinMessage);
    Message restoredMessage = objectMapper.readValue(messageJson, Message.class);
    PinMessageContent restoredContent = assertInstanceOf(PinMessageContent.class, restoredMessage.content());
    assertEquals(PinMessageDurationSeconds.SEVEN_DAYS, restoredContent.durationSeconds());
  }

  @Test
  void serializesAndDeserializesInteractiveCarouselMessages() throws Exception
  {
    InteractiveCarouselMessageContent content = new InteractiveCarouselMessageContent(
      "Featured products",
      "Swipe the cards",
      List.of(
        new InteractiveCarouselCardContent(
          "Watch S1",
          "Water resistant",
          null,
          "Premium smartwatch",
          "Available now",
          new InteractiveCarouselNativeFlowMessageContent(
            List.of(
              new InteractiveCarouselNativeFlowButton(
                "quick_reply",
                "{\"display_text\":\"Buy watch\",\"id\":\"buy_watch\"}"
              )
            ),
            null,
            1
          )
        )
      ),
      1
    );

    String json = objectMapper.writeValueAsString(content);
    assertTrue(json.contains("\"type\":\"interactive_carousel\""));

    MessageContent restored = objectMapper.readValue(json, MessageContent.class);
    InteractiveCarouselMessageContent restoredContent = assertInstanceOf(InteractiveCarouselMessageContent.class, restored);
    assertEquals("Featured products", restoredContent.bodyText());
    assertEquals("Swipe the cards", restoredContent.footerText());
    assertEquals(1, restoredContent.cards().size());
    assertEquals("Watch S1", restoredContent.cards().get(0).headerTitle());
    assertEquals("quick_reply", restoredContent.cards().get(0).nativeFlowMessage().buttons().get(0).name());
  }

  @Test
  void serializesAndDeserializesOutboundCommandsAndCommandResults() throws Exception
  {
    OutboundCommand presenceCommand = new PresenceCommand(
      "command-presence-1",
      new SessionReference("whatsapp-web", 1, "primary"),
      PresenceCommand.Action.UPDATE,
      "5511999999999@s.whatsapp.net",
      PresenceCommand.PresenceType.COMPOSING
    );

    String presenceJson = objectMapper.writeValueAsString(presenceCommand);
    assertTrue(presenceJson.contains("\"family\":\"presence\""));
    assertTrue(presenceJson.contains("\"action\":\"update\""));
    assertTrue(presenceJson.contains("\"presence\":\"composing\""));

    OutboundCommand restoredPresence = objectMapper.readValue(presenceJson, OutboundCommand.class);
    PresenceCommand restoredPresenceCommand = assertInstanceOf(PresenceCommand.class, restoredPresence);
    assertEquals(PresenceCommand.Action.UPDATE, restoredPresenceCommand.action());
    assertEquals(PresenceCommand.PresenceType.COMPOSING, restoredPresenceCommand.presence());

    OutboundCommand readCommand = new ReadCommand(
      "command-read-1",
      new SessionReference("whatsapp-web", 1, "primary"),
      ReadCommand.Action.READ_MESSAGES,
      List.of(
        new CommandMessageKey(
          new MessageReference("wamid-read-1", "5511999999999@s.whatsapp.net", null),
          1712080000L,
          false
        )
      ),
      null,
      null,
      List.of(),
      null
    );

    String readJson = objectMapper.writeValueAsString(readCommand);
    assertTrue(readJson.contains("\"family\":\"read\""));
    assertTrue(readJson.contains("\"action\":\"read_messages\""));

    OutboundCommand restoredRead = objectMapper.readValue(readJson, OutboundCommand.class);
    ReadCommand restoredReadCommand = assertInstanceOf(ReadCommand.class, restoredRead);
    assertEquals("wamid-read-1", restoredReadCommand.messages().get(0).reference().messageId());

    OutboundCommandResult commandResult = new OutboundCommandResult(
      "command-presence-1",
      new SessionReference("whatsapp-web", 1, "primary"),
      "presence",
      "update",
      OutboundCommandResultStatus.SUCCEEDED,
      "2026-04-04T12:00:00Z",
      null,
      Map.of("chatId", "5511999999999@s.whatsapp.net", "presence", "composing")
    );

    String resultJson = objectMapper.writeValueAsString(commandResult);
    assertTrue(resultJson.contains("\"status\":\"succeeded\""));
    OutboundCommandResult restoredResult = objectMapper.readValue(resultJson, OutboundCommandResult.class);
    assertEquals(OutboundCommandResultStatus.SUCCEEDED, restoredResult.status());
    assertEquals("presence", restoredResult.family());
  }
}
