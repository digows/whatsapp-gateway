import { type GatewayTransaction, SqlGatewayStore } from "../sql/gateway-store.ts";
import { GatewayStorage } from "../sql/storage.ts";
export class PostgresGatewayStore extends SqlGatewayStore
{
  private compatible: Promise<void> | undefined;
  constructor(url: string, workspaceId: string)
  {
    super(new GatewayStorage({ engine: "postgresql", url, mode: "local" }), workspaceId);
  }
  override async transaction<Result>(
    work: (transaction: GatewayTransaction) => Promise<Result>,
  ): Promise<Result>
  {
    this.compatible ??= this.storage.verify();
    await this.compatible;
    return super.transaction(work);
  }
  async close(): Promise<void>
  {
    await this.storage.close();
  }
}
