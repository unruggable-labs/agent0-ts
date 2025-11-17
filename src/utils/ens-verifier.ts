/**
 * Utilities used by `Agent.verifyENSName()` to read and validate ENSIP‑25 records.
 *
 * We fetch the ENS text key `agent-registry:<7930 chain id>`,
 * decode the value (`<EIP55 registry address><agentIdLength><agentIdHex>`), then
 * compare the decoded registry + token id against what the SDK expects.
 * ENSIP-25: 
*/

import type { AbstractProvider } from 'ethers';
import { getAddress, getBytes, hexlify, toBeHex } from 'ethers';
import { InteropAddressProvider } from '@defi-wonderland/interop-addresses';

// Currently restricted to EVM (eip155) namespaces; future namespaces can be added here.
const CAIP_NAMESPACE_CODES: Record<string, number> = {
  eip155: 0x0000,
};

/**
 * Input payload used when encoding an ENS agent-registry record.
 */
export interface AgentRegistryRecordInput {
  namespace?: keyof typeof CAIP_NAMESPACE_CODES;
  chainId: bigint | number | string;
  registryAddress: string;
  agentId: bigint | number | string;
}

/**
 * Decoded representation of the ENS registry record.
 */
export interface AgentRegistryRecord {
  version: number;
  chainType: number;
  chainReference: bigint;
  address: string;
  agentId: bigint;
}

/**
 * Build key: `agent-registry:<hex 7930 chain id>` (EVM only).
 * See ERC‑7930 for chain id binary envelope (addrLen=0), hex‑encoded.
 */
export function buildAgentRegistryRecordKey(
  chainId: bigint | number | string,
  namespace: keyof typeof CAIP_NAMESPACE_CODES = 'eip155'
): string {
  if (CAIP_NAMESPACE_CODES[namespace] === undefined) {
    throw new Error(`Unsupported CAIP namespace: ${namespace}`);
  }
  const chainIdentifierHex = encode7930ChainIdentifierHex(BigInt(chainId), namespace);
  return `agent-registry:${chainIdentifierHex}`;
}

/**
 * Resolve the raw text record for the given ENS name and record key.
 * Returns null if missing or if the resolver lookup fails.
 */
export async function fetchAgentRegistryRecord(
  provider: AbstractProvider,
  ensName: string,
  recordKey: string
): Promise<string | null> {
  const normalizedKey = recordKey.toLowerCase();
  let resolver;
  try {
    resolver = await provider.getResolver(ensName);
  } catch {
    return null;
  }

  if (!resolver) {
    return null;
  }

  try {
    const text = await resolver.getText(normalizedKey);
    return text;
  } catch (error) {
    return null;
  }
}

/**
 * Decode value text: `<EIP55 address><agentIdLen><agentId>`.
 * Validates minimum length and hex sizes; normalizes address via EIP‑55.
 */
export function decodeAgentRegistryRecord(valueHex: string): AgentRegistryRecord {
  if (!valueHex.startsWith('0x')) {
    throw new Error('CAIP-350 segment must start with 0x');
  }

  const ADDRESS_HEX_LENGTH = 42; // 0x + 40 hex chars for EVM addresses
  // Require checksum address (42 chars) + at least one byte for agentId length.
  if (valueHex.length < ADDRESS_HEX_LENGTH + 2) {
    throw new Error('Agent registry record value too short');
  }

  // Split the payload into `<address><len><agentId>` per ENSIP-25.
  const addressText = valueHex.slice(0, ADDRESS_HEX_LENGTH);
  const agentIdLengthHex = valueHex.slice(ADDRESS_HEX_LENGTH, ADDRESS_HEX_LENGTH + 2);
  const agentIdLength = parseInt(agentIdLengthHex, 16);
  if (!Number.isFinite(agentIdLength) || agentIdLength < 0) {
    throw new Error('Invalid agent ID length');
  }

  const agentIdHex = valueHex.slice(ADDRESS_HEX_LENGTH + 2).toLowerCase();
  // Verify byte size and hex validity at the boundary.
  const agentIdBytes = getBytes(`0x${agentIdHex}`);
  if (agentIdBytes.length !== agentIdLength) {
    throw new Error('Agent ID length does not match payload');
  }

  const agentId = agentIdBytes.length === 0 ? 0n : BigInt(hexlify(agentIdBytes));
  const normalizedAddress = getAddress(addressText);

  return {
    version: 1,
    chainType: CAIP_NAMESPACE_CODES.eip155,
    chainReference: 0n,
    address: normalizedAddress,
    agentId,
  };
}

/**
 * Encode the ERC-7930 chain identifier (no address) as lowercase hex without leading 0x.
 */
function encode7930ChainIdentifierHex(chainId: bigint, namespace: keyof typeof CAIP_NAMESPACE_CODES): string {
  if (chainId < 0n) {
    throw new Error('Chain reference must be non-negative');
  }

  if (CAIP_NAMESPACE_CODES[namespace] === undefined) {
    throw new Error(`Unsupported CAIP namespace: ${namespace}`);
  }

  const payload = InteropAddressProvider.buildFromPayload({
    version: 1,
    chainType: namespace,
    chainReference: toBeHex(chainId).toLowerCase(),
    address: '0x',
  });

  return payload.slice(2).toLowerCase();
}

/**
 * Load and decode an ENS agent-registry record for a specific chain.
 *
 * @param provider ethers provider used to resolve ENS text records.
 * @param ensName ENS name to inspect (e.g. `agent.eth`).
 * @param chainId Chain identifier encoded in the ENSIP key (eip155 only).
 * @param namespace CAIP namespace (defaults to `eip155`; other namespaces not yet supported).
 */
export async function loadAgentRegistryRecord(
  provider: AbstractProvider,
  ensName: string,
  chainId: bigint | number | string,
  namespace: keyof typeof CAIP_NAMESPACE_CODES = 'eip155'
): Promise<AgentRegistryRecord | null> {
  // Build the ENS text key that points to the agent registry payload.
  const recordKey = buildAgentRegistryRecordKey(chainId, namespace);
  const value = await fetchAgentRegistryRecord(provider, ensName, recordKey);
  if (!value) {
    return null;
  }

  try {
    // Decode the ENS record.
    const decoded = decodeAgentRegistryRecord(value);
    return {
      ...decoded,
      chainReference: BigInt(chainId),
    };
  } catch (error) {
    return null;
  }
}

/**
 * Compare a decoded record against expected agent data (EVM only).
 */
export function recordMatchesAgent(
  record: AgentRegistryRecord,
  expected: { chainId: bigint; registryAddress: string; agentId: bigint }
): boolean {
  // Currently limited to EVM-compatible records (eip155 namespace).
  if (record.version !== 1 || record.chainType !== CAIP_NAMESPACE_CODES.eip155) {
    return false;
  }

  // The ENS record must be anchored to the same chain, registry contract, and token id.
  if (record.chainReference !== expected.chainId) {
    return false;
  }

  if (getAddress(expected.registryAddress) !== record.address) {
    return false;
  }

  if (record.agentId !== expected.agentId) {
    return false;
  }

  return true;
}
