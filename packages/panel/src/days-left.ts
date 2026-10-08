import type { IngredientMovement } from './domain';

const USAGE_WINDOW_DAYS = 14;
const MIN_USAGE_RECORDS = 3;
const MIN_HISTORY_DAYS = 3;

/** Days of stock left from confirmed usage only (BR-14). Honest about having too little history. */
export function daysLeftInfo(onHand: number, usage: IngredientMovement[], now: Date): { days: number | null; label: string } {
  const used = usage.filter((m) => m.reason === 'usage');
  if (used.length < MIN_USAGE_RECORDS) return { days: null, label: 'Not enough data yet' };
  const first = Math.min(...used.map((m) => Date.parse(m.at)));
  const historyDays = (now.getTime() - first) / 86_400_000;
  if (historyDays < MIN_HISTORY_DAYS) return { days: null, label: 'Not enough data yet' };
  const windowDays = Math.min(USAGE_WINDOW_DAYS, historyDays);
  const since = now.getTime() - windowDays * 86_400_000;
  const total = used.filter((m) => Date.parse(m.at) >= since).reduce((s, m) => s - m.qty, 0);
  if (total <= 0) return { days: null, label: 'No recent use' };
  const days = onHand / (total / windowDays);
  if (onHand <= 0) return { days: 0, label: 'Out of stock' };
  return { days, label: days < 1 ? 'Less than a day' : `About ${Math.floor(days)} ${Math.floor(days) === 1 ? 'day' : 'days'}` };
}

