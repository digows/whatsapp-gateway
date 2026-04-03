package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("product")
@JsonIgnoreProperties(ignoreUnknown = true)
public record ProductMessageContent(
  String productId,
  String title,
  String description,
  String currencyCode,
  Long priceAmount1000,
  String retailerId,
  String url,
  String productImageUrl,
  String businessOwnerJid,
  String body,
  String footer,
  String catalogTitle,
  String catalogDescription
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.PRODUCT;
  }
}
