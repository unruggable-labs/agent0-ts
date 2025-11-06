# ENSIP-25 Verification Logic (TypeScript SDK Reference)

This document summarizes the implementation that was added to the TypeScript
SDK so the same behaviour can be reproduced in the Python SDK.

## High-Level Flow

Given an agent record on chain and an ENS name, we need to verify that the
ENS text record `agent-registry:<CHAIN_HEX>` correctly points back to the same
registry contract and agent id.

The TypeScript logic performs:

1. **Build the record key**
   - Normalize a numeric chain id into the ERC‑7930 “chain only” envelope
     (version 1, chainType = namespace code, chainReference bytes, address
     length = 0).
   - Hex encode that binary string (lowercase, no `0x` prefix) and prepend the
     `agent-registry:` prefix.
2. **Fetch & decode the text record value**
   - `provider.getResolver(ensName)` ➜ resolver ➜ `resolver.getText(key)`.
   - Expect value in the format `EIP55_ADDRESS + agentIdLengthHex (2 chars) +
     agentIdHex (lowercase)`.  This matches ENSIP‑25 §“Agent Registry and Agent
     ID Format”.
   - Validate: value starts with `0x`, address portion is 42 chars, length byte
     parses, agent id hex decodes to bytes and matches the declared length.
3. **Normalize decoded data**
   - Address normalized with EIP‑55 checksum (`ethers.getAddress`).
   - Agent id converted to a bigint.
   - Return object `{version:1, chainType:0x0000, chainReference, address,
     agentId}`.
4. **Compare against on-chain expectations**
   - Fetch the identity registry address from the SDK.
   - Ensure version == 1 and chainType == eip155 (0x0000).
   - Ensure chainReference equals expected chain id and registry address
     matches (after checksum normalization).
   - Ensure agent id matches.

## Key Functions (TypeScript)

### `buildAgentRegistryRecordKey(chainId, namespace='eip155')`
```ts
const payload = InteropAddressProvider.buildFromPayload({
  version: 1,
  chainType: namespace,
  chainReference: ethers.toBeHex(BigInt(chainId)),
  address: '0x',
});
return `agent-registry:${payload.slice(2).toLowerCase()}`;
```

*Python equivalent:* use the interop-sdk helper once added (or port the same
binary construction). The key requirement is `addrLen = 0` and lowercase hex
without the `0x` prefix.

### `decodeAgentRegistryRecord(value: str)`

Validates and returns:

```ts
{
  version: 1,
  chainType: 0x0000,
  chainReference: 0n,      // we re-inject actual chain id later
  address: <EIP55>
  agentId: <bigint>
}
```

Important validations:

- Value must start with `0x` and be at least 42 (address) + 2 (length) chars
- Agent id length parsed from two hex characters, must be >= 0
- Agent id hex must decode to bytes successfully and match the length
- Address normalized via EIP‑55 checksum (raises if invalid)

*Python equivalent:* split string, use `eth_utils.to_checksum_address`, use
`bytes.fromhex` for the agent id and compare lengths.

### `loadAgentRegistryRecord(provider, ensName, chainId)`

Fetches resolver ➜ text record ➜ decode (with `try/except`).  Returns `None`
if resolver missing, record missing, or decoding fails.

### `recordMatchesAgent(record, {chainId, registryAddress, agentId})`

Checks version, namespace, chain id, registry address (again checksum
normalized) and agent id.  Returns boolean.

## Tests (what to cover in Python)

1. **Success path** – resolver returns the record, registry/address match.
2. **Wrong agent id** – same value but agent id differs ➜ verification false.
3. **Wrong registry address** – value matches but recorded registry mismatches.
4. **Missing resolver** – return false without calling registry check.
5. **Encoding symmetry** – optional helper ensuring decoder handles edge cases
   like single-byte agent ids (`01a7`).

All tests mock the underlying resolver and registry calls.  The critical pieces
are verifying the key used, validating the decoded payload, and ensuring
expected comparisons happen.

## Example CLI (TypeScript `examples/verify-ens.ts`)

Outline of the example you can mirror in Python:

```ts
const sdk = new SDK({ chainId, rpcUrl });
const recordKey = buildAgentRegistryRecordKey(chainId);
const record = await loadAgentRegistryRecord(provider, ensName, chainId);
if (!record) { console.log('missing'); return; }
const isMatch = recordMatchesAgent(record, {
  chainId,
  registryAddress: expectedRegistry,
  agentId: expectedAgentId,
});
```

Python version can live in an example script replicating this flow and printing
similar output.

## Port Checklist for Python SDK

1. Implement `build_agent_registry_key(chain_id: int, namespace='eip155')->str`
   - Call helper from interop-sdk if available, else manual assembly.
2. Implement `decode_agent_registry_value(value: str) -> AgentRegistryRecord`
   - Validate prefix, length, checksummed address, agent id hex.
   - Return dataclass with `version`, `chain_type`, `chain_reference` (0,
     set later), `address`, `agent_id` (int).
3. Implement `load_agent_registry_record(provider, ens_name, chain_id)`
   - Mirror TS logic, catching resolver/text errors.
4. Implement `record_matches_agent(record, expected)`
   - Use `eth_utils.to_checksum_address` to normalize addresses before
     comparison.
5. Wire into the Agent class – `Agent.verify_ens_name()` should call these
   helpers and return `True/False` just like the TS version.
6. Add pytest suite mirroring the five TypeScript tests above.
7. Optional: Provide command-line example mirroring `examples/verify-ens.ts`.

With this mapping the Python SDK will behave identically to the TypeScript SDK
for ENSIP‑25 verification.

