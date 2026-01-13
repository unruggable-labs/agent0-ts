/**
 * Unit tests for ENS verification logic.
 * Covers ENSIP-25’s registry-backed ENS name verification using mocked web3 providers.
 */

import { ethers } from 'ethers';
import { InteropAddressProvider } from '@defi-wonderland/interop-addresses';
import { Agent } from '../src/core/agent';
import type { SDK } from '../src/core/sdk';
import { EndpointType } from '../src/models/enums';
import type { RegistrationFile } from '../src/models/interfaces';
import {
  decodeAgentRegistryDataRecord,
  buildAgentRegistryRecordKeys,
  fetchAgentRegistryDataRecord,
  loadAgentRegistryRecords,
  recordMatchesAgent,
} from '../src/utils/ens-verifier';
import * as ensVerifier from '../src/utils/ens-verifier';

// Test helper to encode value as `<ERC-7930 address bytes><len(1 byte)><agentId bytes>`
function encodeAgentRegistryDataRecord(input: {
  chainId: number | string | bigint;
  registryAddress: string;
  agentId: number | string | bigint;
}): string {
  const agentIdBigInt = BigInt(input.agentId);
  const agentIdBytes = ethers.getBytes(ethers.toBeHex(agentIdBigInt));

  const erc7930 = InteropAddressProvider.buildFromPayload({
    version: 1,
    chainType: 'eip155',
    chainReference: ethers.toBeHex(BigInt(input.chainId)).toLowerCase(),
    address: ethers.getAddress(input.registryAddress),
  });
  const erc7930Bytes = ethers.getBytes(erc7930);

  const agentIdLen = new Uint8Array([agentIdBytes.length]);
  const valueBytes = ethers.concat([erc7930Bytes, agentIdLen, agentIdBytes]);
  return ethers.hexlify(valueBytes);
}

describe('Agent.verifyENSName', () => {
  const chainId = 11155111;
  const tokenId = 1875;
  const ensName = 'test-agent.eth';
  const registryAddress = '0x8004a6090Cd10A7288092483047B097295Fb8847';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Builds an agent instance backed by mocked web3/ENS dependencies for each scenario.
  function createAgentWithResolver(recordValuesByKey: Record<string, string | null>) {
    const registrationFile: RegistrationFile = {
      agentId: `${chainId}:${tokenId}`,
      agentURI: undefined,
      name: 'Test Agent',
      description: 'Description',
      endpoints: [
        {
          type: EndpointType.ENS,
          value: ensName,
          meta: {},
        },
      ],
      trustModels: [],
      owners: [],
      operators: [],
      active: true,
      x402support: false,
      metadata: {},
      updatedAt: Math.floor(Date.now() / 1000),
    };

    const resolver = {
      address: registryAddress,
      data: jest.fn().mockImplementation(async (_node: string, key: string) => {
        const value = recordValuesByKey[key];
        return value ?? '0x';
      }),
    };

    const provider = {
      getResolver: jest.fn().mockResolvedValue(resolver),
    };

    const identityRegistry = {
      getAddress: jest.fn().mockResolvedValue(registryAddress),
    };

    const fakeSdk = {
      web3Client: { provider },
      getIdentityRegistry: jest.fn().mockReturnValue(identityRegistry),
    } as unknown as SDK;

    const agent = new Agent(fakeSdk, registrationFile);

    return {
      agent,
      resolver,
      provider,
      identityRegistry,
    };
  }

  it('returns true when ENS record matches registry data', async () => {
    const recordValue = encodeAgentRegistryDataRecord({
      chainId,
      registryAddress,
      agentId: tokenId,
    });

    const { agent, resolver, provider, identityRegistry } = createAgentWithResolver({
      'agent-registry': recordValue,
    });
    const result = await agent.verifyENSName();

    expect(result).toBe(true);

    // Ensure we looked up the correct resolver methods.
    expect(provider.getResolver).toHaveBeenCalledWith(ensName);
    expect(resolver.data).toHaveBeenCalledWith(ethers.namehash(ensName), 'agent-registry');
    expect(identityRegistry.getAddress).toHaveBeenCalled();
  });

  it('returns true when a lower-priority key matches', async () => {
    const recordValue = encodeAgentRegistryDataRecord({
      chainId,
      registryAddress,
      agentId: tokenId,
    });

    const { agent, resolver } = createAgentWithResolver({
      'agent-registry': null,
      'agent-registry: 1': recordValue,
    });

    const result = await agent.verifyENSName();
    expect(result).toBe(true);

    expect(resolver.data).toHaveBeenCalledWith(ethers.namehash(ensName), 'agent-registry');
    expect(resolver.data).toHaveBeenCalledWith(ethers.namehash(ensName), 'agent-registry: 1');
  });

  it('returns false when registry agent ID does not match', async () => {
    const recordValue = encodeAgentRegistryDataRecord({
      chainId,
      registryAddress,
      agentId: tokenId + 1,
    });

    const { agent, identityRegistry } = createAgentWithResolver({
      'agent-registry': recordValue,
    });
    const result = await agent.verifyENSName();

    expect(result).toBe(false);
    expect(identityRegistry.getAddress).toHaveBeenCalled();
  });

  it('returns false when registry address does not match', async () => {
    const recordValue = encodeAgentRegistryDataRecord({
      chainId,
      registryAddress,
      agentId: tokenId,
    });

    const { agent, identityRegistry } = createAgentWithResolver({
      'agent-registry': recordValue,
    });
    identityRegistry.getAddress.mockResolvedValueOnce('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');

    const result = await agent.verifyENSName();

    expect(result).toBe(false);
    expect(identityRegistry.getAddress).toHaveBeenCalled();
  });

  it('returns false when resolver missing', async () => {
    const { agent, provider, identityRegistry } = createAgentWithResolver({});
    provider.getResolver.mockResolvedValueOnce(null);

    const result = await agent.verifyENSName();
    expect(result).toBe(false);
    expect(identityRegistry.getAddress).not.toHaveBeenCalled();
  });

  it('detects chain or registry mismatch via recordMatchesAgent', () => {
    const baseRecord = {
      version: 1,
      chainType: 0,
      chainReference: BigInt(chainId),
      address: registryAddress,
      agentId: BigInt(tokenId),
    };

    expect(
      recordMatchesAgent(baseRecord, {
        chainId: BigInt(chainId + 1),
        registryAddress,
        agentId: BigInt(tokenId),
      })
    ).toBe(false);

    expect(
      recordMatchesAgent(baseRecord, {
        chainId: BigInt(chainId),
        registryAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        agentId: BigInt(tokenId),
      })
    ).toBe(false);
  });

  describe('parseAgentRegistryRecord', () => {
    it('splits ERC-7930 payload and agentId bytes', () => {
      const agentId = 0x1234;
      const encoded = encodeAgentRegistryDataRecord({
        chainId,
        registryAddress,
        agentId,
      });

      const bytes = ethers.getBytes(encoded);
      const { erc7930Hex, agentIdBytes } = (ensVerifier as any).parseAgentRegistryRecord(bytes);
      const ercSegmentLength = bytes.length - (1 + agentIdBytes.length);

      expect(erc7930Hex).toBe(ethers.hexlify(bytes.slice(0, ercSegmentLength)));
      expect(ethers.hexlify(agentIdBytes)).toBe('0x1234');
    });

    it('throws when trailing bytes remain after agentId', () => {
      const valid = ethers.getBytes(
        encodeAgentRegistryDataRecord({
          chainId,
          registryAddress,
          agentId: tokenId,
        })
      );
      const malformed = ethers.concat([valid, ethers.getBytes('0xff')]);

      expect(() => (ensVerifier as any).parseAgentRegistryRecord(malformed)).toThrow();
    });
  });

  it('fetchAgentRegistryDataRecord returns null when resolver throws', async () => {
    const resolver = {
      address: registryAddress,
      data: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const node = ethers.namehash(ensName);
    const result = await fetchAgentRegistryDataRecord(resolver, node, 'agent-registry');

    expect(result).toBeNull();
    expect(resolver.data).toHaveBeenCalledWith(node, 'agent-registry');
  });

  it('loadAgentRegistryRecords skips malformed entries and preserves order', async () => {
    const badValue = '0xdead';
    const goodValue = encodeAgentRegistryDataRecord({
      chainId,
      registryAddress,
      agentId: tokenId,
    });

    const resolver = {
      address: registryAddress,
      data: jest.fn().mockImplementation(async (_node: string, key: string) => {
        if (key === 'agent-registry') return badValue;
        if (key === 'agent-registry: 1') return goodValue;
        return '0x';
      }),
    };

    const provider = {
      getResolver: jest.fn().mockResolvedValue(resolver),
    };

    const records = await loadAgentRegistryRecords(provider as unknown as ethers.AbstractProvider, ensName, 2);
    expect(records).toHaveLength(1);
    expect(records[0].agentId).toBe(BigInt(tokenId));
    expect(resolver.data).toHaveBeenCalledWith(ethers.namehash(ensName), 'agent-registry');
    expect(resolver.data).toHaveBeenCalledWith(ethers.namehash(ensName), 'agent-registry: 1');
  });

  it('builds prioritized keys agent-registry through agent-registry: 4', () => {
    expect(buildAgentRegistryRecordKeys(4)).toEqual([
      'agent-registry',
      'agent-registry: 1',
      'agent-registry: 2',
      'agent-registry: 3',
      'agent-registry: 4',
    ]);
  });
});
