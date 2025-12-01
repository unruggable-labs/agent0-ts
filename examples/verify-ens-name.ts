/**
 * ENS Agent Verification Example
 *
 * Demonstrates how to:
 * 1. Resolve ENS agent-registry records for a registered agent.
 * 2. Decode the registry payload and compare it against expected data.
 *
 * Run with: npx tsx examples/verify-ens-name.ts
 */

import { getAddress, JsonRpcProvider } from 'ethers';
import { DEFAULT_REGISTRIES } from '../src/core/contracts';
import { buildAgentRegistryRecordKey, loadAgentRegistryRecord, recordMatchesAgent } from '../src/utils';

async function main() {
  const ENS_NAME = 'ens-8004-verifier.eth'; // Replace with the ENS name you want to verify
  const CHAIN_ID = 11155111n; // Replace with the chain ID your agent is registered on
  const EXPECTED_AGENT_ID = 1875n; // Replace with the agent ID you expect in the registry
  const chainIdNumber = Number(CHAIN_ID);
  const registryAddresses = DEFAULT_REGISTRIES[chainIdNumber];
  if (!registryAddresses) {
    throw new Error(`No registry configuration found for chain ${chainIdNumber}`);
  }
  const EXPECTED_REGISTRY_ADDRESS = getAddress(registryAddresses.IDENTITY); // Override if using a custom registry
  const ENS_REGISTRY_ADDRESS = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e'; // Replace with the ENS registry for your network
  const rpcUrl = 'https://eth-sepolia.g.alchemy.com/v2/demo'; // Swap with your preferred RPC endpoint
  const provider = new JsonRpcProvider(rpcUrl, {
    chainId: chainIdNumber,
    name: 'sepolia',
    ensAddress: ENS_REGISTRY_ADDRESS,
  });

  console.log('[verify-agent-records] configuration', {
    ensName: ENS_NAME,
    chainId: CHAIN_ID.toString(),
    registryAddress: EXPECTED_REGISTRY_ADDRESS,
    rpcUrl,
    ensRegistry: ENS_REGISTRY_ADDRESS,
  });

  const recordKey = buildAgentRegistryRecordKey(CHAIN_ID);
  console.log(`[verify-agent-records] Fetching ENS text key ${recordKey}`);

  const record = await loadAgentRegistryRecord(provider, ENS_NAME, CHAIN_ID);

  if (!record) {
    console.error('No agent-registry record found.');
    return;
  }

  console.log('Decoded registry record:');
  console.log(record);

  const matches = recordMatchesAgent(record, {
    chainId: CHAIN_ID,
    registryAddress: EXPECTED_REGISTRY_ADDRESS,
    agentId: EXPECTED_AGENT_ID,
  });

  console.log(matches ? '✅ Registry record matches expected agent data.' : '❌ Registry record does not match expected agent data.');

  const resolver = await provider.getResolver(ENS_NAME);
  console.log('[verify-agent-records] Resolver address:', resolver?.address ?? 'not set');
  if (!resolver) {
    console.error('Resolver not found for ENS name.');
    return;
  }
}

main().catch((error) => {
  console.error('Failed to verify ENS records:', error);
});
