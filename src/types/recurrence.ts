export type RecurrenceFrequency = 'daily' | 'weekly' | 'bi-weekly' | 'monthly';

export interface Recurrence {
  // Old boolean records stay listed until an organizer chooses a cadence; none can be inferred.
  frequency: RecurrenceFrequency | null;
  timeZone: string | null;
  // Keep the original date so January 31 -> February 28 still comes back to March 31.
  anchor: Date | null;
}
