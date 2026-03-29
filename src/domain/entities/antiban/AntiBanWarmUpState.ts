export class AntiBanWarmUpState {
  constructor(
    public startedAt: number,
    public lastActiveAt: number,
    public dailyCounts: number[],
    public graduated: boolean,
  ) {}

  public clone(): AntiBanWarmUpState {
    return new AntiBanWarmUpState(
      this.startedAt,
      this.lastActiveAt,
      [...this.dailyCounts],
      this.graduated,
    );
  }
}
