import type { Announcement, Role, Staff } from '../domain';
import type { Registry } from '../intents';
import { DomainError } from '../intents';
import type { FeedDef } from '../feeds';
import { ROLE_LABEL } from './requests';

const MAX_LIVE = 20;
const ALL_ROLES: Role[] = ['owner', 'cashier', 'baker', 'inventory', 'it'];

/** Who is asked to read announcements: everyone who works here except the owner who writes them. */
const readers = (staff: Staff[]) => staff.filter((s) => s.active && s.role !== 'owner');

export interface AnnouncementRow {
  announcementId: string;
  text: string;
  requiresAck: boolean;
  postedByName: string;
  createdAt: string;
  /** For the person looking: have they read it, and do they still owe an acknowledgement? */
  seenByMe: boolean;
  ackedByMe: boolean;
  needsAck: boolean;
  /** Owner only: one chip per person. */
  readers?: { userId: string; name: string; role: Role; roleLabel: string; seen: boolean; acked: boolean }[];
  /** Owner only: for example "2 of 3 acknowledged". */
  progress?: string;
}
export interface AnnouncementsData {
  rows: AnnouncementRow[];
  /** Announcements this person has not opened yet. */
  unseen: number;
  /** Announcements asking this person to acknowledge. */
  needAck: number;
  can: { post: boolean };
}

export const announcementIntents = {
  'announcements/post': {
    circuit: 'Messages',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const errors: string[] = [];
      if (!p.text.trim()) errors.push('Write the announcement first.');
      const live = (await ctx.store.list<Announcement>('announcements')).filter((a) => !a.retiredAt).length;
      if (live >= MAX_LIVE) errors.push('There are a lot of announcements up. Take some down first.');
      return errors;
    },
    handle: async (p, ctx) => {
      const a: Announcement = {
        id: ctx.ids.next('ann'),
        text: p.text.trim(),
        requiresAck: !!p.requiresAck,
        postedById: ctx.session!.userId,
        postedByName: ctx.session!.name,
        createdAt: ctx.now(),
        seenBy: {},
        ackedBy: {},
      };
      await ctx.store.put('announcements', a);
      return {
        summary: `Posted an announcement${a.requiresAck ? ' (staff must acknowledge)' : ''}: ${a.text.slice(0, 60)}`,
        target: a.id,
        data: { announcementId: a.id },
        events: [{ type: 'AnnouncementPosted', payload: { announcementId: a.id, requiresAck: a.requiresAck } }],
      };
    },
  },

  'announcements/mark_seen': {
    circuit: 'Messages',
    roles: ALL_ROLES,
    validate: async (p, ctx) => {
      const a = await ctx.store.get<Announcement>('announcements', p.announcementId);
      return a && !a.retiredAt ? [] : ['That announcement is no longer up.'];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const a = (await ctx.store.get<Announcement>('announcements', p.announcementId))!;
      // The owner who wrote it does not count as a reader.
      if (me.role === 'owner' || a.seenBy[me.userId]) return { summary: 'Opened an announcement (nothing new)', target: a.id };
      await ctx.store.put('announcements', { ...a, seenBy: { ...a.seenBy, [me.userId]: { name: me.name, at: ctx.now() } } });
      return { summary: `Read an announcement: ${a.text.slice(0, 40)}`, target: a.id, events: [{ type: 'AnnouncementSeen', payload: { announcementId: a.id } }] };
    },
  },

  'announcements/acknowledge': {
    circuit: 'Messages',
    roles: ['cashier', 'baker', 'inventory', 'it'],
    validate: async (p, ctx) => {
      const a = await ctx.store.get<Announcement>('announcements', p.announcementId);
      if (!a || a.retiredAt) return ['That announcement is no longer up.'];
      if (!a.requiresAck) return ['This announcement does not ask for an acknowledgement.'];
      return [];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const a = (await ctx.store.get<Announcement>('announcements', p.announcementId))!;
      if (a.ackedBy[me.userId]) return { summary: 'Acknowledged an announcement (already done)', target: a.id };
      const at = ctx.now();
      await ctx.store.put('announcements', {
        ...a,
        // Acknowledging counts as having read it.
        seenBy: { ...a.seenBy, [me.userId]: a.seenBy[me.userId] ?? { name: me.name, at } },
        ackedBy: { ...a.ackedBy, [me.userId]: { name: me.name, at } },
      });
      return { summary: `Acknowledged an announcement: ${a.text.slice(0, 40)}`, target: a.id, events: [{ type: 'AnnouncementAcknowledged', payload: { announcementId: a.id } }] };
    },
  },

  'announcements/retire': {
    circuit: 'Messages',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const a = await ctx.store.get<Announcement>('announcements', p.announcementId);
      if (!a) throw new DomainError('invalid', ['That announcement does not exist.']);
      return a.retiredAt ? ['That announcement is already down.'] : [];
    },
    handle: async (p, ctx) => {
      const a = (await ctx.store.get<Announcement>('announcements', p.announcementId))!;
      await ctx.store.put('announcements', { ...a, retiredAt: ctx.now() });
      return { summary: `Took down an announcement: ${a.text.slice(0, 40)}`, target: a.id };
    },
  },
} satisfies Partial<Registry>;

export const announcementFeeds = {
  announcements: {
    roles: ALL_ROLES,
    build: async ({ store, session }) => {
      const me = session!;
      const owner = me.role === 'owner';
      const staff = readers(await store.list<Staff>('staff'));
      const live = (await store.list<Announcement>('announcements'))
        .filter((a) => !a.retiredAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const rows: AnnouncementRow[] = live.map((a) => {
        const seenByMe = !!a.seenBy[me.userId];
        const ackedByMe = !!a.ackedBy[me.userId];
        const row: AnnouncementRow = {
          announcementId: a.id,
          text: a.text,
          requiresAck: a.requiresAck,
          postedByName: a.postedByName,
          createdAt: a.createdAt,
          seenByMe,
          ackedByMe,
          needsAck: !owner && a.requiresAck && !ackedByMe,
        };
        if (owner) {
          row.readers = staff
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((s) => ({ userId: s.id, name: s.name, role: s.role, roleLabel: ROLE_LABEL[s.role], seen: !!a.seenBy[s.id], acked: !!a.ackedBy[s.id] }));
          const acked = row.readers.filter((r) => r.acked).length;
          const seen = row.readers.filter((r) => r.seen).length;
          row.progress = a.requiresAck ? `${acked} of ${row.readers.length} acknowledged` : `${seen} of ${row.readers.length} have read it`;
        }
        return row;
      });
      return {
        rows,
        unseen: owner ? 0 : rows.filter((r) => !r.seenByMe).length,
        needAck: rows.filter((r) => r.needsAck).length,
        can: { post: owner },
      };
    },
  },
} satisfies { announcements: FeedDef<'announcements'> };
