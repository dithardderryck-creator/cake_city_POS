import { z } from 'zod';
import { describeFeeds, describeIntents } from './kernel';
import { feedSchemas, schemas } from './schemas';

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
}

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.type === 'array' && s.items) {
    if (s.items.type === 'object' && s.items.properties) {
      const inner = Object.entries(s.items.properties)
        .map(([k, v]) => `${k}${s.items!.required?.includes(k) ? '' : '?'}: ${typeOf(v)}`)
        .join(', ');
      return `{ ${inner} }[]`;
    }
    return `${typeOf(s.items)}[]`;
  }
  return Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'any');
}

function limits(s: JsonSchema): string {
  const out: string[] = [];
  if (s.minLength !== undefined) out.push(`min length ${s.minLength}`);
  if (s.maxLength !== undefined) out.push(`max length ${s.maxLength}`);
  if (s.minimum !== undefined) out.push(`min ${s.minimum}`);
  if (s.maximum !== undefined) out.push(`max ${s.maximum}`);
  if (s.maxItems !== undefined) out.push(`max ${s.maxItems} items`);
  return out.join(', ');
}

function fields(schema: z.ZodType): string {
  const js = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;
  const props = Object.entries(js.properties ?? {});
  if (props.length === 0) return '_No fields. Send an empty object `{}`._\n';
  const rows = props.map(([name, p]) => `| \`${name}\` | ${typeOf(p).replace(/\|/g, '\\|')} | ${js.required?.includes(name) ? 'yes' : 'no'} | ${limits(p)} |`);
  return ['| Field | Type | Required | Limits |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
}

const who = (r: readonly string[] | 'public') => (r === 'public' ? 'anyone (no sign-in)' : r.join(', '));

/**
 * The reference for the instructions and feeds a UI can use. Generated from the real schemas and
 * permission rules, so it cannot disagree with the code. Regenerate with `npm run docs:api`.
 */
export function renderApiReference(): string {
  const intents = describeIntents();
  const feeds = describeFeeds();
  const out: string[] = [
    '# API reference',
    '',
    '_Generated from the code by `npm run docs:api`. Do not edit by hand: a test fails if this file is out of date._',
    '',
    'How to send instructions and read feeds is in [api.md](api.md). Data shapes returned by feeds are the TypeScript types in `packages/panel/src/feeds.ts` (exported from `@cake-pos/panel`).',
    '',
    '## Instructions',
    '',
    'Send with `POST /api/dispatch` as `{ "type": "<name>", "payload": { ... }, "requestId": "<unique>" }`. Unknown fields are rejected.',
    '',
  ];
  let circuit = '';
  for (const i of intents) {
    if (i.circuit !== circuit) {
      circuit = i.circuit;
      out.push(`### ${circuit}`, '');
    }
    out.push(`#### \`${i.name}\``, '', `Allowed: **${who(i.roles)}**`, '', fields(schemas[i.name]));
  }
  out.push('## Feeds', '', 'Read with `POST /api/feed` as `{ "name": "<name>", "params": { ... } }`, or subscribe over the live connection to get the same data again after every change.', '');
  for (const f of feeds) {
    out.push(`#### \`${f.name}\``, '', `Allowed: **${who(f.roles)}**`, '', fields(feedSchemas[f.name]));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
