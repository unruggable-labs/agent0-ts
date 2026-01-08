/**
 * Utilities used by `Agent.verifyENSName()` to read and validate ENSIP‑25 records.
 *
 * ENS names MAY publish one or more ENSIP-25 data records using keys
 * `agent-registry` and `agent-registry: N` (N = 1,2,3,...) in priority order.
 *
 * Each record value is `bytes` with:
 *   <ERC‑7930 address bytes><agentIdLength(1 byte)><agentId bytes>
 */

import type { AbstractProvider, BytesLike } from 'ethers';
import { getAddress, getBytes, hexlify, namehash } from 'ethers';
import { InteropAddressProvider } from '@defi-wonderland/interop-addresses';

// ERC-7930 chain type code for eip155 (EVM).
const CHAIN_TYPE_EIP155 = 0x0000;

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

export interface DataResolverInterface {
  data(node: string, key: string): Promise<BytesLike>;
}

/**
 * Keys to check, in priority order: `agent-registry` then `agent-registry: N`.
 */
export function buildAgentRegistryRecordKeys(maxAdditionalEntries: number = 4): string[] {
  const keys = ['agent-registry'];
  for (let i = 1; i <= maxAdditionalEntries; i += 1) {
    keys.push(`agent-registry: ${i}`);
  }
  return keys;
}

function parseAgentRegistryRecord(valueBytes: Uint8Array): {
  erc7930Hex: `0x${string}`;
  agentIdBytes: Uint8Array;
} {
  // First 2 bytes are the ERC-7930 segment length.
  if (valueBytes.length < 2) {
    throw new Error('agent-registry record value too short');
  }
  const header = valueBytes.slice(0, 2);
  const erc7930Len = (header[0] << 8) | header[1];

  // Remaining bytes start with the ERC-7930 payload, then the agent-id portion.
  const body = valueBytes.slice(2);
  if (erc7930Len > body.length) {
    throw new Error('ERC-7930 segment out of bounds');
  }

  // Slice out the ERC-7930 binary payload so we can use the interop library to decode it.
  const erc7930Hex = hexlify(body.slice(0, erc7930Len)) as `0x${string}`;

  if (!InteropAddressProvider.isValidBinaryAddress(erc7930Hex)) {
    throw new Error('Invalid ERC-7930 binary address');
  }

  // Next byte is agent ID length, followed by that many bytes of agent ID.
  const lengthOffset = erc7930Len;
  if (lengthOffset >= body.length) {
    throw new Error('agent-registry record value too short');
  }
  const agentIdLen = body[lengthOffset];
  const agentIdStart = lengthOffset + 1;
  const recordEnd = agentIdStart + agentIdLen;
  if (recordEnd !== body.length) {
    throw new Error(
      recordEnd > body.length
        ? 'Agent ID out of bounds'
        : 'Unexpected trailing bytes in agent-registry record'
    );
  }
  const agentIdBytes = body.slice(agentIdStart, recordEnd);

  return { erc7930Hex, agentIdBytes };
}

async function ensureSupportedNamespace(erc7930Hex: `0x${string}`): Promise<void> {
  // Only EVM addresses are supported today; other namespaces should be rejected early.
  const humanReadable = await InteropAddressProvider.binaryToHumanReadable(erc7930Hex);
  const match = humanReadable.match(/@([^:]+):/);
  const namespace = match?.[1];
  if (namespace !== 'eip155') {
    throw new Error(`Unsupported namespace: ${namespace ?? 'unknown'}`);
  }
}

/**
 * Resolve a single ENSIP-24 `data()` record and return raw bytes.
 */
export async function fetchAgentRegistryDataRecord(
  resolver: { data: (node: string, key: string) => Promise<BytesLike> },
  node: string,
  recordKey: string
): Promise<Uint8Array | null> {
  try {
    // assumption: resolver implements ENSIP-24 `data(bytes32,string)`.
    const value = await resolver.data(node, recordKey);
    const bytes = getBytes(value);
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}

// Resolve the ENS resolver for a name; returns null if it is missing or lookup fails.
async function resolveEnsDataResolver(
  provider: AbstractProvider,
  ensName: string
): Promise<DataResolverInterface | null> {
  try {
    return (await provider.getResolver(ensName)) as unknown as DataResolverInterface;
  } catch {
    return null;
  }
}

/**
 * Decode ENSIP-25 bytes:
 *   `<erc7930Len(2 bytes)><erc7930AddressBytes><agentIdLen(1 byte)><agentIdBytes>`.
 */
export async function decodeAgentRegistryDataRecord(
  valueBytes: Uint8Array
): Promise<AgentRegistryRecord> {
  if (valueBytes.length < 3) {
    throw new Error('agent-registry record value too short');
  }
  const { erc7930Hex, agentIdBytes } = parseAgentRegistryRecord(valueBytes);

  // Ensure only supported namespaces are processed. (EVM)
  await ensureSupportedNamespace(erc7930Hex);

  const chainReference = BigInt(await InteropAddressProvider.getChainId(erc7930Hex));
  const interopAddress = await InteropAddressProvider.getAddress(erc7930Hex);

  const agentId = agentIdBytes.length === 0 ? 0n : BigInt(hexlify(agentIdBytes));
  const normalizedAddress = getAddress(interopAddress);

  return {
    version: 1,
    chainType: CHAIN_TYPE_EIP155,
    chainReference,
    address: normalizedAddress,
    agentId,
  };
}

/**
 * Load and decode ENS agent-registry records using the prioritized key list.
 */
export async function loadAgentRegistryRecords(
  provider: AbstractProvider,
  ensName: string,
  maxAdditionalEntries: number = 4
): Promise<AgentRegistryRecord[]> {
  const keys = buildAgentRegistryRecordKeys(maxAdditionalEntries);
  // Resolve the ENS resolver.
  const resolver = await resolveEnsDataResolver(provider, ensName);
  if (!resolver) {
    return [];
  }

  const node = namehash(ensName);
  const records = await Promise.all(
    keys.map(async (key) => {
      const valueBytes = await fetchAgentRegistryDataRecord(resolver, node, key);
      if (!valueBytes) return null;
      try {
        return await decodeAgentRegistryDataRecord(valueBytes);
      } catch {
        // Ignore malformed entries and continue scanning lower-priority keys.
        return null;
      }
    })
  );

  // Preserve key priority order (Promise.all keeps input ordering).
  return records.filter((record): record is AgentRegistryRecord => record !== null);
}

/**
 * Compare a decoded record against expected agent data (EVM only).
 */
export function recordMatchesAgent(
  record: AgentRegistryRecord,
  expected: { chainId: bigint; registryAddress: string; agentId: bigint }
): boolean {
  // Currently limited to EVM-compatible records (eip155).
  if (record.version !== 1 || record.chainType !== CHAIN_TYPE_EIP155) {
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
