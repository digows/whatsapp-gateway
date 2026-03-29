/**
 *
 */
export interface AntiBanWarmUpState {
  /**
   * Unix epoch in milliseconds marking when the current warm-up cycle started.
   * It is the reference point used to compute the current warm-up day.
   */
  startedAt: number;

  /**
   * Unix epoch in milliseconds of the most recent successful outbound activity.
   * It is used to detect long inactivity and decide when a session must restart warm-up.
   */
  lastActiveAt: number;

  /**
   * Per-day outbound counters for the current warm-up cycle.
   * Array index 0 is day 1, index 1 is day 2, and so on.
   * Each value stores how many successful sends happened on that warm-up day.
   */
  dailyCounts: number[];

  /**
   * Indicates whether the session has already completed warm-up and can operate
   * without daily warm-up caps until inactivity forces a reset.
   */
  graduated: boolean;
}
