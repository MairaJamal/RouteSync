import 'dotenv/config'; // Loads your .env file automatically
import { processTripRequestMatches } from './runIntegration';

async function main() {
  console.log('🚀 Starting Day 3 Integration Test...');

  // Target request ID from seed script (V1 F-10 Rider)
  const testRequestId = '20000000-0000-4000-8000-000000000002';

  await processTripRequestMatches(testRequestId);
  console.log('✅ Day 3 Test Execution Finished!');
}

main().catch((err) => {
  console.error('❌ Integration Test Failed:', err);
});