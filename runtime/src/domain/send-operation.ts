import type { OperationResult, OperationState } from "@digows/whatsapp-gateway-contracts";

export class SendOperation implements OperationResult
{
  private currentState: OperationState = "PENDING";
  get state(): OperationState
  {
    return this.currentState;
  }
  private acceptedCount = 0;
  get acceptedParts(): number
  {
    return this.acceptedCount;
  }
  constructor(readonly key: string, readonly digest: string, readonly nativeIds: readonly string[])
  {}
  static restore(result: OperationResult): SendOperation
  {
    const operation = new SendOperation(result.key, result.digest, result.nativeIds);
    operation.currentState = result.state;
    operation.acceptedCount = result.acceptedParts;
    return operation;
  }
  is(state: OperationState): boolean
  {
    return this.state === state;
  }
  snapshot(): OperationResult
  {
    return Object.freeze({
      key: this.key,
      digest: this.digest,
      nativeIds: Object.freeze([...this.nativeIds]),
      acceptedParts: this.acceptedParts,
      state: this.state,
    });
  }
  dispatch(part: number): void
  {
    if (this.state !== "PENDING" || part !== this.acceptedParts || !this.nativeIds[part])
    {
      throw new Error(`Cannot dispatch operation in ${this.state}`);
    }
    this.currentState = "IN_FLIGHT";
  }
  accept(part: number): void
  {
    if (this.state !== "IN_FLIGHT" || part !== this.acceptedParts)
    {
      throw new Error(`Cannot accept operation in ${this.state}`);
    }
    this.acceptedCount++;
    this.currentState = this.acceptedParts === this.nativeIds.length ? "ACCEPTED" : "PENDING";
  }
  failPreparation(): void
  {
    if (this.state !== "PENDING") throw new Error(`Cannot fail preparation in ${this.state}`);
    this.currentState = "FAILED";
  }
  unknown(): void
  {
    if (this.state !== "IN_FLIGHT") throw new Error("Only a dispatched operation can become UNKNOWN");
    this.currentState = "UNKNOWN";
  }
}
