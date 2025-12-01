/**
 * Unit tests for ENS verification logic.
 * Covers ENSIP-TBD-20’s registry-backed ENS name verification using mocked web3 providers.
 */

import { ethers } from 'ethers';
import { Agent } from '../src/core/agent';
import type { SDK } from '../src/core/sdk';
import { EndpointType } from '../src/models/enums';
import type { RegistrationFile } from '../src/models/interfaces';
import { decodeAgentRegistryRecord, buildAgentRegistryRecordKey } from '../src/utils/ens-verifier';

// Test helper to encode value as `<EIP55 address><len(2 hex)><idHex>`
function encodeAgentRegistryRecord(input: {
  chainId: number | string | bigint; // kept for signature parity
  registryAddress: string;
  agentId: number | string | bigint;
}): string {
  const addressText = ethers.getAddress(input.registryAddress);
  const agentIdBigInt = BigInt(input.agentId);
  const agentIdBytes = ethers.getBytes(ethers.toBeHex(agentIdBigInt));
  const agentIdHex = ethers.hexlify(agentIdBytes).slice(2).toLowerCase();
  const agentIdLengthHex = agentIdBytes.length.toString(16).padStart(2, '0');
  return `${addressText}${agentIdLengthHex}${agentIdHex}`;
}

describe('Agent.verifyENSName', () => {
  const chainId = 1;
  const tokenId = 42;
  const ensName = 'test-agent.eth';
  const registryAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  // Builds an agent instance backed by mocked web3/ENS dependencies for each scenario.
  function createAgentWithResolver(recordValue: string | null) {
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
      getText: jest.fn().mockResolvedValue(recordValue),
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
    const recordValue = encodeAgentRegistryRecord({
      chainId,
      registryAddress,
      agentId: tokenId,
    });

    const { agent, resolver, provider, identityRegistry } = createAgentWithResolver(recordValue);
    const result = await agent.verifyENSName();

    expect(result).toBe(true);

    // Ensure we looked up the correct ENS key and resolver methods.
    const expectedKey = buildAgentRegistryRecordKey(chainId);
    expect(provider.getResolver).toHaveBeenCalledWith(ensName);
    expect(resolver.getText).toHaveBeenCalledWith(expectedKey);
    expect(identityRegistry.getAddress).toHaveBeenCalled();
  });

  it('returns false when registry agent ID does not match', async () => {
    const recordValue = encodeAgentRegistryRecord({
      chainId,
      registryAddress,
      agentId: tokenId + 1,
    });

    const { agent, identityRegistry } = createAgentWithResolver(recordValue);
    const result = await agent.verifyENSName();

    expect(result).toBe(false);
    expect(identityRegistry.getAddress).toHaveBeenCalled();
  });

  it('returns false when registry address does not match', async () => {
    const recordValue = encodeAgentRegistryRecord({
      chainId,
      registryAddress,
      agentId: tokenId,
    });

    const { agent, identityRegistry } = createAgentWithResolver(recordValue);
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

    const encoded = encodeAgentRegistryRecord({
      chainId,
      registryAddress,
      agentId,
    });

    expect(encoded.endsWith('01a7')).toBe(true);

    const decoded = decodeAgentRegistryRecord(encoded);
    expect(decoded.address).toBe(ethers.getAddress(registryAddress));
    expect(decoded.agentId).toBe(agentId);
  });
});
