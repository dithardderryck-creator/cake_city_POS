import type { Quote, QuoteEvent } from '../domain';
import type { HandlerCtx } from '../intents';

export const OPEN_QUOTE = ['sent', 'seen'];

export function quoteEvent(ctx: HandlerCtx, e: QuoteEvent['event'], extra: Partial<QuoteEvent> = {}): QuoteEvent {
  return { at: ctx.now(), by: ctx.session!.userId, byName: ctx.session!.name, event: e, ...extra };
}

/** Closes whatever quote request is open on a line, for example when the line is cancelled. */
export async function closeOpenQuote(ctx: HandlerCtx, lineId: string, why: string) {
  const open = (await ctx.store.find<Quote>('quotes', { where: { status: OPEN_QUOTE } })).filter((q) => q.lineId === lineId);
  for (const q of open) {
    await ctx.store.put('quotes', {
      ...q,
      status: 'withdrawn' as const,
      answer: why,
      resolvedAt: ctx.now(),
      timeline: [...q.timeline, quoteEvent(ctx, 'withdrawn', { note: why })],
    });
  }
}
