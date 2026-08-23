/**
 * Typed, branded entity ids. cuid2 (24 chars, collision-resistant, not sequential) generated in
 * application code so an id exists before the row does (offline-first, N2).
 */
import { createId } from '@paralleldrive/cuid2';

export const ID_KINDS = [
  'org',
  'user',
  'membership',
  'session',
  'account',
  'project',
  'board',
  'file',
  'audit',
  'comment',
  'boardToken',
  'run',
  'proposal',
  'consent',
  'apiToken',
  'usernameWatch',
] as const;

export type IdKind = (typeof ID_KINDS)[number];

declare const idBrand: unique symbol;

/** A cuid2 string tagged with the entity kind it identifies. */
export type Id<K extends IdKind> = string & { readonly [idBrand]: K };

export type OrgId = Id<'org'>;
export type UserId = Id<'user'>;
export type MembershipId = Id<'membership'>;
export type SessionId = Id<'session'>;
export type AccountId = Id<'account'>;
export type ProjectId = Id<'project'>;
export type BoardId = Id<'board'>;
export type FileId = Id<'file'>;
export type AuditId = Id<'audit'>;
export type CommentId = Id<'comment'>;
export type BoardTokenId = Id<'boardToken'>;
export type RunId = Id<'run'>;
export type ProposalId = Id<'proposal'>;
export type ConsentId = Id<'consent'>;
export type ApiTokenId = Id<'apiToken'>;
export type UsernameWatchId = Id<'usernameWatch'>;

// cuid2's own `isCuid` accepts any 2–32 char lowercase token ('nope' passes), which is useless as a
// trust-boundary check. We generate ids at the default length, so we validate that exact shape.
const ID_RE = /^[a-z][a-z0-9]{23}$/;

/** True for a well-formed cuid2. The kind is not encoded in the string; it is a compile-time tag. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * Validate an untrusted string at a trust boundary and tag it with a kind.
 * Throws so callers cannot accidentally continue with a bad id.
 */
export function assertId<K extends IdKind>(kind: K, value: unknown): Id<K> {
  if (!isId(value)) {
    throw new TypeError(`Invalid ${kind} id: expected a cuid2 string, got ${describe(value)}`);
  }
  return value as Id<K>;
}

/** Non-throwing variant for parsers that report their own errors. */
export function parseId<K extends IdKind>(kind: K, value: unknown): Id<K> | undefined {
  return isId(value) ? (value as Id<K>) : undefined;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

function factory<K extends IdKind>(kind: K): { (): Id<K>; kind: K } {
  const make = (): Id<K> => createId() as Id<K>;
  return Object.assign(make, { kind });
}

/** One factory per entity kind: `newId.project()` reads at the call site. */
export const newId = {
  org: factory('org'),
  user: factory('user'),
  membership: factory('membership'),
  session: factory('session'),
  account: factory('account'),
  project: factory('project'),
  board: factory('board'),
  file: factory('file'),
  audit: factory('audit'),
  comment: factory('comment'),
  boardToken: factory('boardToken'),
  run: factory('run'),
  proposal: factory('proposal'),
  consent: factory('consent'),
  apiToken: factory('apiToken'),
  usernameWatch: factory('usernameWatch'),
} as const;
