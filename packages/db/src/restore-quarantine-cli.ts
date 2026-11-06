import { prisma } from './index.js';
import { quarantineRestoredWork } from './restore-quarantine.js';

try {
  const recoveryEpoch = process.env.VEYROBOT_RECOVERY_EPOCH;
  if (process.env.RESTORE_QUARANTINE_CONFIRM !== '1' || !recoveryEpoch) {
    console.error('Refus: fournir RESTORE_QUARANTINE_CONFIRM=1 et VEYROBOT_RECOVERY_EPOCH externe après restauration isolée, processus VeyroBot arrêtés.');
    process.exitCode = 2;
  } else console.info(JSON.stringify(await quarantineRestoredWork(prisma, recoveryEpoch)));
} finally { await prisma.$disconnect(); }
