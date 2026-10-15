import { prisma } from './index.js';
import { quarantineRestoredWork } from './restore-quarantine.js';

try {
  if (process.env.RESTORE_QUARANTINE_CONFIRM !== '1') {
    console.error('Refus: définissez RESTORE_QUARANTINE_CONFIRM=1 après avoir restauré une sauvegarde dans une base isolée et arrêté tous les processus VeyroBot.');
    process.exitCode = 2;
  } else console.info(JSON.stringify(await quarantineRestoredWork(prisma)));
} finally { await prisma.$disconnect(); }
