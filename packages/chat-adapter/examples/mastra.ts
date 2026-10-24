import { Agent, type AgentConfig } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import type { MastraCompositeStore } from "@mastra/core/storage";
import type { StateAdapter } from "chat";
import type { WhatsAppGatewayAdapter } from "../src/adapter.ts";
export interface MastraGatewayExampleConfiguration
{
  readonly adapter: WhatsAppGatewayAdapter;
  readonly model: AgentConfig["model"];
  readonly state: StateAdapter;
  readonly storage: MastraCompositeStore;
}
export interface MastraGatewayExample
{
  readonly agent: Agent;
  readonly mastra: Mastra;
}
/** Consumer composition only. The gateway runtime has no Mastra dependency. */
export async function createMastraGatewayExample(
  configuration: MastraGatewayExampleConfiguration,
): Promise<MastraGatewayExample>
{
  const agent = new Agent({
    id: "generic-whatsapp-agent",
    name: "WhatsApp Agent",
    instructions: "Respond to the user",
    model: configuration.model,
    channels: {
      adapters: {
        "whatsapp-gateway": {
          adapter: configuration.adapter,
          streaming: false,
          toolDisplay: "hidden",
          textFormat: "plain",
        },
      },
      state: configuration.state,
      threadContext: { maxMessages: 0 },
      chatOptions: { concurrency: "concurrent" },
    },
  });
  const mastra = new Mastra({ agents: { agent }, storage: configuration.storage });
  const channels = agent.getChannels();
  if (!channels) throw new Error("Native Mastra channels are unavailable");
  await channels.initialize(mastra);
  return { agent, mastra };
}
