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
import { Contract, getAddress, getBytes, hexlify, namehash } from 'ethers';
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

export interface DataResolverContract {
  data(node: string, key: string): Promise<BytesLike>;
}

const DATA_RESOLVER_ABI = ['function data(bytes32 node, string key) view returns (bytes)'] as const;

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

export function parseAgentRegistryRecord(valueBytes: Uint8Array): {
  erc7930Hex: `0x${string}`;
  agentIdBytes: Uint8Array;
} {
  // ENSIP-25:
  //   `<erc7930AddressBytes><agentIdLen(1 byte)><agentIdBytes>`
  if (valueBytes.length < 6) {
    throw new Error('agent-registry record value too short');
  }

  // Parse the ERC-7930 envelope to find where it ends.
  let offset = 0;
  offset += 4; // version (2 bytes) + chain type (2 bytes)
  if (offset >= valueBytes.length) {
    throw new Error('ERC-7930 segment out of bounds');
  }
  const chainRefLen = valueBytes[offset];
  offset += 1;
  if (offset + chainRefLen > valueBytes.length) {
    throw new Error('ERC-7930 segment out of bounds');
  }
  offset += chainRefLen;
  if (offset >= valueBytes.length) {
    throw new Error('ERC-7930 segment out of bounds');
  }
  const addrLen = valueBytes[offset];
  offset += 1;
  if (offset + addrLen > valueBytes.length) {
    throw new Error('ERC-7930 segment out of bounds');
  }
  offset += addrLen;

  const erc7930Hex = hexlify(valueBytes.slice(0, offset)) as `0x${string}`;

  if (!InteropAddressProvider.isValidBinaryAddress(erc7930Hex)) {
    throw new Error('Invalid ERC-7930 binary address');
  }

  // Next byte is agent ID length, followed by that many bytes of agent ID.
  if (offset >= valueBytes.length) {
    throw new Error('agent-registry record value too short');
  }
  const agentIdLen = valueBytes[offset];
  const agentIdStart = offset + 1;
  const recordEnd = agentIdStart + agentIdLen;
  if (recordEnd !== valueBytes.length) {
    throw new Error(
      recordEnd > valueBytes.length
        ? 'Agent ID out of bounds'
        : 'Unexpected trailing bytes in agent-registry record'
    );
  }
  const agentIdBytes = valueBytes.slice(agentIdStart, recordEnd);

  return { erc7930Hex, agentIdBytes };
}

async function ensureSupportedNamespace(erc7930Hex: `0x${string}`): Promise<void> {
  // Only EVM addresses are supported today; other namespaces should be rejected early.
  const bytes = getBytes(erc7930Hex);
  if (bytes.length < 4) {
    throw new Error('ERC-7930 segment out of bounds');
  }
  const chainType = (bytes[2] << 8) | bytes[3];
  if (chainType !== CHAIN_TYPE_EIP155) {
    throw new Error('Unsupported namespace');
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
    const value = await resolver.data(node, recordKey);
    const bytes = getBytes(value);
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}

// Resolve the ENS resolver for a name; returns null if it is missing or does not support data().
async function resolveEnsDataResolver(
  provider: AbstractProvider,
  ensName: string
): Promise<DataResolverContract | null> {
  try {
    const resolver = await provider.getResolver(ensName);

    if (!resolver) {
      return null;
    }

    if ('data' in resolver && typeof (resolver as any).data === 'function') {
      return resolver as unknown as DataResolverContract;
    }

    if (!('address' in resolver) || !resolver.address) {
      return null;
    }

    return new Contract(resolver.address, DATA_RESOLVER_ABI, provider) as unknown as DataResolverContract;
  } catch {
    return null;
  }
}

/**
 * Decode ENSIP-25 bytes:
 * `<erc7930AddressBytes><agentIdLen(1 byte)><agentIdBytes>`.
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
