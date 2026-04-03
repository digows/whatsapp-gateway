package com.digows.whatsappgateway;

import com.digows.whatsappgateway.activation.ActivationCompletedEvent;
import com.digows.whatsappgateway.activation.ActivationEvent;
import com.digows.whatsappgateway.activation.ActivationMode;
import com.digows.whatsappgateway.activation.ActivationQrCodeUpdatedEvent;
import com.digows.whatsappgateway.messaging.ChatType;
import com.digows.whatsappgateway.messaging.InboundEvent;
import com.digows.whatsappgateway.messaging.Message;
import com.digows.whatsappgateway.messaging.MessageContext;
import com.digows.whatsappgateway.messaging.MessageReference;
import com.digows.whatsappgateway.messaging.PinMessageAction;
import com.digows.whatsappgateway.messaging.PinMessageContent;
import com.digows.whatsappgateway.messaging.PinMessageDurationSeconds;
import com.digows.whatsappgateway.messaging.ReceivedMessageEvent;
import com.digows.whatsappgateway.messaging.TextMessageContent;
import com.digows.whatsappgateway.operational.SessionReference;
import com.digows.whatsappgateway.session.Session;
import com.digows.whatsappgateway.session.SessionActivationState;
import com.digows.whatsappgateway.session.SessionDesiredState;
import com.digows.whatsappgateway.session.SessionRuntimeState;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.util.List;

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
    InboundEvent event = new ReceivedMessageEvent(
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
      )
    );

    String json = objectMapper.writeValueAsString(event);

    assertTrue(json.contains("\"eventType\":\"message.received\""));
    assertTrue(json.contains("\"type\":\"text\""));

    InboundEvent restored = objectMapper.readValue(json, InboundEvent.class);
    ReceivedMessageEvent restoredEvent = assertInstanceOf(ReceivedMessageEvent.class, restored);
    TextMessageContent content = assertInstanceOf(TextMessageContent.class, restoredEvent.message().content());
    assertEquals("hello", content.text());
    assertEquals(ChatType.DIRECT, restoredEvent.message().context().chatType());
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
}
