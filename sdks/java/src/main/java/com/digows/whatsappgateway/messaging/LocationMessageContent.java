package com.digows.whatsappgateway.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonTypeName;

@JsonTypeName("location")
@JsonIgnoreProperties(ignoreUnknown = true)
public record LocationMessageContent(
  double latitude,
  double longitude,
  String name,
  String address,
  String url,
  String comment,
  boolean live,
  Integer accuracyInMeters,
  Integer speedInMetersPerSecond,
  Integer degreesClockwiseFromMagneticNorth,
  Integer sequenceNumber,
  Integer timeOffsetSeconds
) implements MessageContent
{
  @Override
  public MessageContentType type()
  {
    return MessageContentType.LOCATION;
  }
}
