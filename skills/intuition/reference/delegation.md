# ERC-7710 Delegation and the Smart Accounts Kit

Use this reference when an agent acts under another account's authority instead
of its own. The MetaMask Delegation Framework (the contracts behind the Smart
Accounts Kit) is deployed on both Intuition networks. It lets a **delegator**
grant a **delegate** scoped, revocable authority to execute transactions from
the delegator's account — so Intuition writes performed by an agent are
attributed on-chain to the delegator's wallet, keeping reputation and
attestations on one address.

All addresses, struct layouts, hashes, and selectors below are verified against
the live deployments on Intuition mainnet (1155) and testnet (13579),
framework version **v1.3.0** (`DelegationManager.VERSION()` returns `"1.3.0"`
on both chains).

## Contract Addresses

The framework deploys deterministically via CREATE2 (salt `"GATOR"`), so
addresses are **identical on mainnet (1155) and testnet (13579)**:

| Contract | Address (both chains) |
|---|---|
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| EIP7702StatelessDeleGator (impl) | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` |
| HybridDeleGator (impl) | `0x48dBe696A4D990079e039489bA2053B36E8FFEC4` |
| MultiSigDeleGator (impl) | `0x56a9EdB16a0105eb5a4C54f4C062e2868844f3A7` |
| SimpleFactory | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

The DelegationManager is the single entry point for redemption and revocation.
The DeleGator implementations are account contracts; for EOA delegators on
Intuition, use `EIP7702StatelessDeleGator` via EIP-7702 (see below).

Session environment values used by the delegation docs:

```bash
DELEGATION_MANAGER="0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
EIP7702_DELEGATOR_IMPL="0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B"
TIMESTAMP_ENFORCER="0x1046bb45C8d673d4ea75321280DB34899413c069"
ALLOWED_TARGETS_ENFORCER="0x7F20f61b1f09b08D970938F6fa563634d65c4EeB"
ALLOWED_METHODS_ENFORCER="0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5"
LIMITED_CALLS_ENFORCER="0x04658B29F6b82ed55274221a06Fc97D318E25416"
ROOT_AUTHORITY="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
```

### Caveat Enforcers Deployed on Intuition

All v1.3.0 enforcers are deployed at the same address on both chains. The ones
most relevant to Intuition writes:

| Enforcer | Address | Terms encoding | Restricts |
|---|---|---|---|
| TimestampEnforcer | `0x1046bb45C8d673d4ea75321280DB34899413c069` | 32 bytes: `uint128 validAfter ++ uint128 validBefore` (0 = unset, bounds exclusive) | Redemption time window / expiry |
| AllowedTargetsEnforcer | `0x7F20f61b1f09b08D970938F6fa563634d65c4EeB` | packed 20-byte addresses | Which contracts the delegate may call (e.g. only the MultiVault) |
| AllowedMethodsEnforcer | `0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5` | packed 4-byte selectors | Which functions the delegate may call (e.g. only `createAtoms`) |
| LimitedCallsEnforcer | `0x04658B29F6b82ed55274221a06Fc97D318E25416` | 32 bytes: `uint256 maxCalls` | Total number of redemptions (stateful counter) |
| ValueLteEnforcer | `0x92Bf12322527cAA612fd31a0e810472BBB106A8F` | 32 bytes: `uint256 maxWei` | Max native value per execution |
| NativeTokenTransferAmountEnforcer | `0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320` | 32 bytes: `uint256 allowanceWei` | Cumulative native $TRUST spend |
| ExactCalldataEnforcer | `0x99F2e9bF15ce5eC84685604836F71aB835DBBdED` | exact calldata bytes | Pin the execution calldata exactly |
| BlockNumberEnforcer | `0x5d9818dF0AE3f66e9c3D0c5029DAF99d1823ca6c` | 32 bytes: `uint128 afterBlock ++ uint128 beforeBlock` | Block-height window |
| NonceEnforcer | `0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f` | 32 bytes: `uint256 nonce` | Mass-revocation by nonce bump |
| RedeemerEnforcer | `0xE144b0b2618071B4E56f746313528a669c7E65c5` | packed 20-byte addresses | Which addresses may submit the redemption |
| ArgsEqualityCheckEnforcer | `0x44B8C6ae3C304213c3e298495e12497Ed3E56E41` | bytes to match against `args` | Pins redemption-time `args` |
| LogicalOrWrapperEnforcer | `0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c` | nested caveat groups | OR-composition of caveats |

Also deployed (same-address, full v1.3.0 set): `AllowedCalldataEnforcer`,
`DeployedEnforcer`, `IdEnforcer`, `OwnershipTransferEnforcer`,
`ExactCalldataBatchEnforcer`, `ExactExecutionEnforcer`,
`ExactExecutionBatchEnforcer`, `MultiTokenPeriodEnforcer`,
`NativeBalanceChangeEnforcer`, `NativeTokenPaymentEnforcer`,
`NativeTokenStreamingEnforcer`, `NativeTokenPeriodTransferEnforcer`,
`SpecificActionERC20TransferBatchEnforcer`, the ERC20/721/1155 balance, transfer,
streaming, and period enforcers, the four `*MultiOperationIncreaseBalanceEnforcer`
variants, and `ApprovalRevocationEnforcer`. Resolve any address from the
[v1.3.0 deployments list](https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md)
and verify with `cast code <address> --rpc-url $RPC` before use.

## Delegation Struct Anatomy

```solidity
struct Delegation {
    address delegate;     // who may redeem (or ANY_DELEGATE = 0x0a11)
    address delegator;    // whose account executes
    bytes32 authority;    // ROOT_AUTHORITY or parent delegation hash
    Caveat[] caveats;     // scope restrictions, ANDed together
    uint256 salt;         // disambiguates otherwise-identical delegations
    bytes signature;      // EIP-712 signature by the delegator
}

struct Caveat {
    address enforcer;     // caveat enforcer contract
    bytes terms;          // enforcer-specific config, fixed at signing
    bytes args;           // optional redemption-time input, NOT signed
}
```

Two hashing rules matter for both signing and verification:

1. **`signature` is excluded from the delegation hash.** The hash commits to
   `(delegate, delegator, authority, caveats, salt)` only.
2. **`Caveat.args` is excluded from the caveat hash.** Only
   `(enforcer, keccak256(terms))` is signed. `args` may be set at redemption
   time; enforcers that read `args` must validate it themselves (e.g.
   `ArgsEqualityCheckEnforcer`).

Special constants on the DelegationManager:

| Constant | Value | Meaning |
|---|---|---|
| `ROOT_AUTHORITY` | `0xffff…ffff` (32 bytes of `ff`) | The delegator's own account is the authority |
| `ANY_DELEGATE` | `0x0000000000000000000000000000000000000a11` | Any caller may redeem this delegation |

## ROOT_AUTHORITY vs Chained Authority

- A **root delegation** sets `authority = ROOT_AUTHORITY`. The delegator grants
  authority directly from their own account.
- A **redelegation** sets `authority = getDelegationHash(parentDelegation)`.
  The redelegating account must be the `delegate` of the parent (or the parent
  must use `ANY_DELEGATE`), and signs as `delegator` of the child.

At redemption the full chain is presented ordered **leaf to root** in a single
permission context. The DelegationManager validates, for every link:

1. The leaf `delegate` is `msg.sender` (or `ANY_DELEGATE`).
2. Each delegation's signature is valid for its `delegator`.
3. Each non-root `authority` equals the hash of the next delegation in the
   array, and each delegation's `delegator` equals the next delegation's
   `delegate`.
4. The last delegation's `authority` is `ROOT_AUTHORITY`.
5. No delegation hash in the chain is disabled.

Caveats accumulate: every enforcer of every delegation in the chain runs
against the execution. A redelegation can only narrow authority, never widen
it. Execution is performed by the **root delegator's** account.

## The Delegator Must Be a Smart Account (EIP-7702)

`redeemDelegations` executes by calling
`executeFromExecutor(mode, executionCalldata)` on the root delegator's account.
A plain EOA has no code, so redemption against it reverts. On Intuition
(ArbOS 40+, EIP-7702 live on both chains) an EOA delegator upgrades in place:

1. The delegator signs an EIP-7702 authorization for
   `EIP7702_DELEGATOR_IMPL` (`0x63c0…E32B`) and broadcasts a type-4
   transaction (self-executed or sponsored).
2. After inclusion, `eth_getCode(delegator)` returns the 23-byte delegation
   designator `0xef0100 ++ EIP7702_DELEGATOR_IMPL`. The account is now an
   `EIP7702StatelessDeleGator`: the EOA key keeps full control and is the only
   signer.

```bash
# Upgrade an EOA delegator (sender = the delegator key; tx to self with an auth list)
cast send $(cast wallet address --private-key $DELEGATOR_PK) \
  --auth $EIP7702_DELEGATOR_IMPL --private-key $DELEGATOR_PK --rpc-url $RPC

# Verify the designator
cast code 0x<delegatorAddr> --rpc-url $RPC
# 0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b
```

```typescript
const authorization = await delegatorWallet.signAuthorization({
  account: delegatorAccount,
  contractAddress: EIP7702_DELEGATOR_IMPL,
  executor: 'self', // delegator broadcasts its own authorization
})
const hash = await delegatorWallet.sendTransaction({
  authorizationList: [authorization],
  to: delegatorAccount.address,
  data: '0x',
})
```

Signature validation at redemption follows the delegator's account state:

- **No code (plain EOA):** ECDSA recovery of the EIP-712 digest must yield
  `delegator`. Valid for signing, but redemption still fails at execution —
  upgrade before redeeming.
- **Code present (7702-upgraded or contract account):** ERC-1271
  `isValidSignature(digest, signature)` is called on the delegator. The
  `EIP7702StatelessDeleGator` implementation recovers the same ECDSA signature
  against `address(this)`, so a delegation signed by the EOA key remains valid
  before and after the upgrade.

The delegate/agent does **not** need a smart account. The agent EOA calls
`redeemDelegations` directly as a normal transaction signer.

## EIP-712 Signing Flow

Domain (per chain; verify with `getDomainHash()`):

```json
{
  "name": "DelegationManager",
  "version": "1",
  "chainId": 13579,
  "verifyingContract": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
}
```

Type definitions (exact strings hashed by the contract — `signature` and
`args` omitted):

```
Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)
Caveat(address enforcer,bytes terms)
```

The signed digest is
`keccak256("\x19\x01" ++ domainSeparator ++ delegationStructHash)`. The
delegation struct hash is also the key for revocation state — compute it
on-chain with `getDelegationHash` (pure) rather than reimplementing the
encoder. Full signing patterns: `operations/create-delegation.md`.

## Reading Delegation State

```bash
# Domain separator for this chain (changes per chainId)
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC

# Delegation hash (pure; tuple is (delegate,delegator,authority,caveats[],salt,signature))
cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$ROOT_AUTHORITY,[($TIMESTAMP_ENFORCER,$TIMESTAMP_TERMS,0x)],$SALT,0x)" \
  --rpc-url $RPC

# Revocation status (true = disabled)
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" 0x<delegationHash> --rpc-url $RPC

# Redemption kill switch (owner-controlled; redemptions revert while paused)
cast call $DELEGATION_MANAGER "paused()(bool)" --rpc-url $RPC

# Remaining uses under a LimitedCallsEnforcer caveat
cast call $LIMITED_CALLS_ENFORCER "callCounts(address,bytes32)(uint256)" \
  $DELEGATION_MANAGER 0x<delegationHash> --rpc-url $RPC
```

Expiry is not stored in the DelegationManager — it lives in the
`TimestampEnforcer` caveat's `terms`. Decode the 32-byte terms as
`uint128 validAfter ++ uint128 validBefore` and compare against the current
block timestamp. There is no on-chain delegation registry: the signed
delegation object travels off-chain (passed to the agent), and only
revocations and redemptions touch chain state.

## Redeeming a Delegation

`redeemDelegations` is the only write path for acting under delegated
authority. The agent (leaf delegate) is the transaction signer.

**Function:**
`redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)`

- `permissionContexts[i]` — ABI-encoded `Delegation[]`, ordered leaf to root.
- `modes[i]` — ERC-7579 execution mode. For Intuition writes use single-call
  default mode: `0x00…00` (bytes32 zero). Batch mode
  (`0x01` in the first byte) is rejected by single-mode enforcers like
  `AllowedTargetsEnforcer`.
- `executionCallDatas[i]` — packed single execution:
  `abi.encodePacked(address target, uint256 value, bytes callData)`.

The execution's `value` is paid **from the delegator's account balance**, not
by the agent. The outer `redeemDelegations` transaction carries `value = 0`;
the delegator account must hold enough $TRUST to cover payable Intuition
operations (e.g. `createAtoms` costs).

```bash
# Inner Intuition call (any operations/ encoding, e.g. createAtoms)
INNER_CALLDATA=$(cast calldata "createAtoms(bytes[],uint256[])" "[$ATOM_DATA]" "[$ATOM_COST]")

# Packed execution: target ++ value ++ calldata
EXECUTION=$(cast concat-hex $MULTIVAULT $(cast to-uint256 $ATOM_COST) $INNER_CALLDATA)

# Permission context: abi.encode(Delegation[]) — signed delegation incl. signature
PERMISSION_CONTEXT=$(cast abi-encode \
  "f((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)[])" \
  "[($DELEGATE,$DELEGATOR,$ROOT_AUTHORITY,[($TIMESTAMP_ENFORCER,$TIMESTAMP_TERMS,0x),($ALLOWED_TARGETS_ENFORCER,$MULTIVAULT,0x)],$SALT,$SIGNATURE)]")

MODE=0x0000000000000000000000000000000000000000000000000000000000000000

CALLDATA=$(cast calldata "redeemDelegations(bytes[],bytes32[],bytes[])" \
  "[$PERMISSION_CONTEXT]" "[$MODE]" "[$EXECUTION]")
```

```typescript
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi } from 'viem'

const MODE_SINGLE_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000000'

const execution = encodePacked(
  ['address', 'uint256', 'bytes'],
  [MULTIVAULT, atomCost, innerCalldata],   // value paid by the delegator account
)

const permissionContext = encodeAbiParameters(
  [{ type: 'tuple[]', components: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'tuple[]', components: [
      { name: 'enforcer', type: 'address' },
      { name: 'terms', type: 'bytes' },
      { name: 'args', type: 'bytes' },
    ]},
    { name: 'salt', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ]}],
  [[signedDelegation]],                    // leaf to root
)

const data = encodeFunctionData({
  abi: parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']),
  functionName: 'redeemDelegations',
  args: [[permissionContext], [MODE_SINGLE_DEFAULT], [execution]],
})
```

The redemption transaction object follows the standard output contract with
`to` set to the **DelegationManager** (not the MultiVault):

```json
{
  "to": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  "data": "0x<redeemDelegations calldata>",
  "value": "0",
  "chainId": "13579"
}
```

Before emitting a redemption transaction, run the authority gate in
`reference/delegation-authority.md`. Simulate with the agent as sender:
`cast call $DELEGATION_MANAGER $CALLDATA --from 0x<agentAddr> --rpc-url $RPC`.

## Attribution

Inside a redeemed execution, the MultiVault sees `msg.sender = delegator`.
Atoms are created by, deposits credited to, and `AtomCreated.creator` set to
the **delegator's address**. Receiver-bearing operations (`deposit`, `redeem`)
should still set `receiver` to the delegator unless the delegation's intent
says otherwise — the skill's non-zero-receiver rule applies unchanged.

## Agent Wallet Setup with OpenWallet

[OpenWallet (OWS — Open Wallet Standard)](https://openwallet.sh/) provides
local, policy-gated key custody for agents: keys are generated and stored
encrypted on the agent's machine (`~/.ows/`), never exported, and every
signature passes a pre-signing policy engine. This fits the skill's signing
boundary — the skill emits unsigned objects; OWS signs them.

```bash
# Install (CLI + Node/Python bindings)
curl -fsSL https://docs.openwallet.sh/install.sh | bash

# 1. Generate the agent wallet (BIP-39, EVM address derived at m/44'/60'/0'/0/0)
ows wallet create --name "intuition-agent"

# 2. Derive and expose the agent's EVM address — give this to the delegator
#    as the `delegate` field of the delegation. The same address applies on
#    every EVM chain, including Intuition 1155/13579.
ows wallet list
```

Hand the printed `eip155` address to the delegator. The delegator signs a
delegation with `delegate` set to that address and passes the signed
delegation object back to the agent — no funds or keys move.

Sign redemption transactions with the agent wallet by chain ID (Intuition is
not a named chain in OWS; the bare chain ID selects the EVM signer):

```bash
# Sign a prepared redemption tx (hex of the unsigned type-2 tx)
ows sign tx --wallet "intuition-agent" --chain 13579 --tx "02f8…"

# EIP-712 signing (used when the agent redelegates as a delegator itself)
ows sign message --wallet "intuition-agent" --chain 13579 --typed-data "$TYPED_DATA_JSON"
```

```typescript
// Node SDK equivalents
import { createWallet, signTypedData } from '@open-wallet-standard/core'

const wallet = createWallet('intuition-agent')         // returns derived accounts
const sig = signTypedData('intuition-agent', 'evm', typedDataJson)
```

For unattended agents, attach an OWS policy and API key so the agent process
can sign only Intuition-chain transactions within an expiry window:

```json
{
  "id": "intuition-delegate",
  "name": "Intuition delegate signer",
  "version": 1,
  "rules": [
    { "type": "allowed_chains", "chain_ids": ["eip155:13579", "eip155:1155"] },
    { "type": "expires_at", "timestamp": "2026-12-31T23:59:59Z" }
  ],
  "action": "deny"
}
```

```bash
ows policy create --file policy.json
ows key create   # API key for the agent process; passphrase via OWS_PASSPHRASE
```

OWS policy gates complement — they do not replace — this skill's autonomous
policy and the on-chain caveat enforcers. The layering is: skill policy gates
(`reference/autonomous-policy.md`) → authority gate
(`reference/delegation-authority.md`) → OWS pre-signing policy → caveat
enforcers on-chain.

## Events

| Event | topic0 |
|---|---|
| `RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, Delegation delegation)` | `0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873` |
| `DisabledDelegation(bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, Delegation delegation)` | `0xea589ba9473ee1fe77d352c7ed919747715a5d22931b972de9b02a907c66d5dd` |
| `EnabledDelegation(bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, Delegation delegation)` | `0x3feadce88fc1b49db633a56fd5307ed6ee18734df83bcc4011daa720c9cd95f1` |

## Governance Note

The DelegationManager is `Ownable2Step` + `Pausable`: the owner can pause all
redemptions chain-wide (`paused()` flips to `true`; redemptions revert with
`EnforcedPause`). Revocation (`disableDelegation`) and re-enablement remain
available while paused. Check `paused()` during session setup for delegation
work, and re-verify the addresses above against
`reference/network-config.md`-style trusted sources before copying them
elsewhere.

## Contract Source

- **Delegation Framework v1.3.0:** https://github.com/MetaMask/delegation-framework/tree/v1.3.0
- **Interface:** `src/interfaces/IDelegationManager.sol`
- **Struct hashing:** `src/libraries/EncoderLib.sol`, `src/utils/Constants.sol`
- **ERC-7710:** https://eips.ethereum.org/EIPS/eip-7710
- **Smart Accounts Kit docs:** https://docs.metamask.io/smart-accounts-kit/
