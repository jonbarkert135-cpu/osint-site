import { vi } from 'vitest';
import type { Context } from '../src/trpc/context.ts';

/** The slice of prisma the routers touch, all mocked. */
export const prismaMock = {
  project: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  board: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  file: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  membership: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  organization: { create: vi.fn(), findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  comment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  // P9 integration framework.
  integrationRun: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  importProposal: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  consent: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  apiToken: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  usernameWatch: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  repository: { findUnique: vi.fn(), findFirst: vi.fn() },
  githubAnalysis: { findFirst: vi.fn() },
  runLogEntry: { findMany: vi.fn(), findFirst: vi.fn(), createMany: vi.fn() },
};

export const recordAuditMock = vi.fn();

export const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

export const ORG_ID = 'o1';
export const PROJECT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

export const ctx = (over: Partial<Context> = {}): Context => ({
  user: { id: 'u1', email: 'a@example.com', name: 'A' },
  org: { id: ORG_ID, name: 'Org', slug: 'org' },
  role: 'admin',
  req_id: 'req-1',
  ip: '127.0.0.1',
  logger,
  ...over,
});
