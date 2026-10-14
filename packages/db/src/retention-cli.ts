import { prisma } from './index.js';
import { pruneRetainedData } from './retention.js';

try { console.info(JSON.stringify(await pruneRetainedData(prisma))); }
finally { await prisma.$disconnect(); }
