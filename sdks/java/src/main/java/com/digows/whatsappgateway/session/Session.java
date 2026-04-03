package com.digows.whatsappgateway.session;

import com.digows.whatsappgateway.operational.SessionReference;

public record Session(
  SessionReference reference,
  SessionDesiredState desiredState,
  SessionRuntimeState runtimeState,
  SessionActivationState activationState,
  boolean hasPersistedCredentials,
  String createdAt,
  String updatedAt,
  String assignedWorkerId,
  String phoneNumber,
  String whatsappJid,
  String lastError,
  String lastConnectedAt,
  String lastDisconnectedAt
)
{
}
