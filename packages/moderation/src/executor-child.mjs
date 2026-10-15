// Isolated fault harness: the parent kills this process after the controlled Discord adapter is entered.
import { PermissionFlagsBits } from 'discord.js';
import { prisma } from '@veyrobot/db';
import { executeModerationAction } from '../dist/index.js';

const row = await prisma.moderationCase.findUniqueOrThrow({ where: { id: process.env.EXECUTOR_TEST_CASE_ID } });
const actor = { id: row.actorId, permissions: { bitfield: PermissionFlagsBits.KickMembers }, roles: { highest: { comparePositionTo: () => 1 } } };
const bot = { id: '687654321012345678', permissions: { bitfield: PermissionFlagsBits.KickMembers }, roles: { highest: { comparePositionTo: () => 1 } } };
const target = { id: row.targetId, roles: { highest: {} }, kick: async () => {
  process.send?.({ stage: 'discord-request-entered' });
  await new Promise(() => undefined);
} };
const guild = { ownerId: row.actorId, members: { fetch: async ({ user }) => user === row.targetId ? target : actor, fetchMe: async () => bot } };
await executeModerationAction({ operationId: row.operationId, guild, caseRecord: row, store: prisma });
