import { prisma } from './index.js';
import { initializeRecoveryAuthorization } from './recovery-gate.js';

try {
  const epoch = process.env.VEYROBOT_RECOVERY_EPOCH;
  if (process.env.RECOVERY_GATE_INITIALIZE !== '1' || !epoch) {
    console.error('Refus: initialisation explicite requise avec RECOVERY_GATE_INITIALIZE=1 et VEYROBOT_RECOVERY_EPOCH externe.');
    process.exitCode = 2;
  } else {
    await initializeRecoveryAuthorization(prisma, epoch);
    console.info('Recovery authorization initialized.');
  }
} finally { await prisma.$disconnect(); }
