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
} from '../src/utils/ens-verifier';

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

  const erc7930Len = erc7930Bytes.length;
  const erc7930LenBytes = new Uint8Array([(erc7930Len >> 8) & 0xff, erc7930Len & 0xff]);
  const agentIdLen = new Uint8Array([agentIdBytes.length]);
  const valueBytes = ethers.concat([erc7930LenBytes, erc7930Bytes, agentIdLen, agentIdBytes]);
  return ethers.hexlify(valueBytes);
}

describe('Agent.verifyENSName', () => {
  const chainId = 1;
  const tokenId = 42;
  const ensName = 'test-agent.eth';
  const registryAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

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

    const provider = {
      getResolver: jest.fn().mockResolvedValue(null),
    };

    const identityRegistry = {
      getAddress: jest.fn().mockResolvedValue(registryAddress),
    };

    const fakeSdk = {
      web3Client: { provider },
      getIdentityRegistry: jest.fn().mockReturnValue(identityRegistry),
    } as unknown as SDK;

    const agent = new Agent(fakeSdk, registrationFile);
    const result = await agent.verifyENSName();
    expect(result).toBe(false);
    expect(identityRegistry.getAddress).not.toHaveBeenCalled();
  });

  it('encodes and decodes registry values with single-byte agent IDs', () => {
    const registryAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const agentId = 0xa7n;

    const encoded = encodeAgentRegistryDataRecord({
      chainId,
      registryAddress,
      agentId,
    });

    expect(encoded.endsWith('01a7')).toBe(true);

    return decodeAgentRegistryDataRecord(ethers.getBytes(encoded)).then((decoded) => {
      expect(decoded.chainReference).toBe(BigInt(chainId));
      expect(decoded.address).toBe(ethers.getAddress(registryAddress));
      expect(decoded.agentId).toBe(agentId);
    });
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
