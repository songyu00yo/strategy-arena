/** Usage quotas remain enabled unless explicitly disabled by the operator. */
export function usageLimitsEnabled(): boolean {
  return process.env.ARENA_USAGE_LIMITS_ENABLED !== "false";
}
