export { prisma } from './client.ts';
// `Prisma` is a value export: the ai chunk store needs `Prisma.sql`/`Prisma.empty` at runtime.
export { Prisma } from '@prisma/client';
export type { PrismaClient } from '@prisma/client';
export type {
  Account,
  AiChunk,
  AuditLog,
  Board,
  BoardProjectionEdge,
  BoardProjectionNode,
  BoardSnapshot,
  Comment,
  File,
  FileState,
  Membership,
  Organization,
  OrgRole,
  PresenceLogEntry,
  Project,
  Session,
  User,
} from '@prisma/client';

export { recordAudit } from './audit.ts';
export type { AuditEntry } from './audit.ts';
