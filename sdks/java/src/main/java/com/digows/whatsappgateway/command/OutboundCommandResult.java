package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.operational.SessionReference;

import java.util.Map;

/**
 * Generic execution result published by the gateway for outbound command families.
 * The optional {@code data} map carries family/action-specific return values.
 */
public record OutboundCommandResult(
  String commandId,
  SessionReference session,
  String family,
  String action,
  OutboundCommandResultStatus status,
  String timestamp,
  String reason,
  Map<String, Object> data
)
{
}

