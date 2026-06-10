# createDelegation

Grant another account scoped, revocable authority to execute transactions from
your account. Follow these steps in order.

**Requires:** `$RPC`, `$CHAIN_ID`, `$DELEGATION_MANAGER`, enforcer addresses
from `reference/delegation.md`.

**Function:** none — a delegation is an off-chain EIP-712 signature over the
`Delegation` struct (verifying contract: DelegationManager). Nothing is
broadcast; the output is a signed delegation object.

## Semantics

- **The signer is the delegator** — the account whose funds and identity the
  delegate will act with. For a fresh (root) delegation that is the user's
  account; for a redelegation it is the agent passing narrowed authority
  downstream.
- The `delegate` is the address being granted authority (an agent wallet —
  see Agent Wallet Setup with OpenWallet in `reference/delegation.md` — or
  `ANY_DELEGATE` = `0x0000000000000000000000000000000000000a11` to allow any
  redeemer; avoid `ANY_DELEGATE` unless a caveat like `RedeemerEnforcer`
  restricts submission).
- Caveats are ANDed. An empty `caveats[]` grants unlimited authority over the
  delegator's account — never emit one. Minimum recommended scope for
  Intuition work: a `TimestampEnforcer` expiry plus an
  `AllowedTargetsEnforcer` pinned to the MultiVault.
- An EOA delegator must be upgraded via EIP-7702 before the delegation can be
  **redeemed** (signing works either way). See The Delegator Must Be a Smart
  Account in `reference/delegation.md`.

## Step 1: Query Prerequisites

```bash
# Pin the verifying contract and chain binding for the EIP-712 domain
cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC

# Redemptions must not be paused (signing still works, but verify the path)
cast call $DELEGATION_MANAGER "paused()(bool)" --rpc-url $RPC

# Delegator account state: 0xef0100++impl means already 7702-upgraded.
# Plain EOA (0x) must broadcast the type-4 upgrade before redemption.
cast code 0x<delegatorAddr> --rpc-url $RPC

# For a redelegation only: the parent delegation hash becomes `authority`
cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "(<parent tuple>)" --rpc-url $RPC

# And the parent must not be revoked
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" 0x<parentHash> --rpc-url $RPC
```

Choose a fresh `salt` (e.g. unix milliseconds). Disabling is keyed by
delegation hash, so re-signing identical fields with the same salt produces a
delegation that is **already revoked** if that hash was ever disabled.

## Step 2: Encode the Caveat Terms

Terms are fixed at signing time and hashed into the delegation. Encode per
enforcer (`reference/delegation.md` has the full table):

### Using cast

```bash
# TimestampEnforcer: uint128 validAfter ++ uint128 validBefore (0 = unset, exclusive)
EXPIRY=$(($(date +%s) + 86400))                       # 24h from now
TIMESTAMP_TERMS=$(cast concat-hex \
  $(printf "0x%032x" 0) $(printf "0x%032x" $EXPIRY))  # two uint128 halves

# AllowedTargetsEnforcer: packed 20-byte addresses (here: only the MultiVault)
TARGET_TERMS=$MULTIVAULT

# AllowedMethodsEnforcer: packed 4-byte selectors (optional narrowing)
METHOD_TERMS=$(cast concat-hex $(cast sig "createAtoms(bytes[],uint256[])") \
  $(cast sig "deposit(address,bytes32,uint256,uint256)"))

# LimitedCallsEnforcer: uint256 max redemptions
CALLS_TERMS=$(cast to-uint256 5)
```

### Using viem

```typescript
import { encodePacked, toFunctionSelector, toHex } from 'viem'

const expiry = BigInt(Math.floor(Date.now() / 1000) + 86400)
const timestampTerms = encodePacked(['uint128', 'uint128'], [0n, expiry])

const targetTerms = MULTIVAULT                            // single packed address
const methodTerms = encodePacked(['bytes4', 'bytes4'], [
  toFunctionSelector('createAtoms(bytes[] atomDatas, uint256[] assets)'),
  toFunctionSelector('deposit(address receiver, bytes32 termId, uint256 curveId, uint256 minShares)'),
])
const callsTerms = toHex(5n, { size: 32 })
```

`AllowedTargetsEnforcer` and `AllowedMethodsEnforcer` only accept single-call
default mode (`0x00…00`) — they reject batch executions. Set every caveat's
`args` to `0x` unless the enforcer documents redemption-time arguments.

## Step 3: Build and Sign the Delegation (EIP-712)

Set `authority` to `ROOT_AUTHORITY`
(`0xffff…ffff`, 32 bytes of `ff`) for a fresh delegation, or to the parent
delegation hash from Step 1 for a redelegation. For a redelegation the signer
must be the parent's `delegate`.

### Using cast

Write the typed data to a file and sign. `types`/`domain` must match exactly —
`Caveat` omits `args`, `Delegation` omits `signature`:

```bash
cat > delegation-typed-data.json << EOF
{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" },
      { "name": "verifyingContract", "type": "address" }
    ],
    "Delegation": [
      { "name": "delegate", "type": "address" },
      { "name": "delegator", "type": "address" },
      { "name": "authority", "type": "bytes32" },
      { "name": "caveats", "type": "Caveat[]" },
      { "name": "salt", "type": "uint256" }
    ],
    "Caveat": [
      { "name": "enforcer", "type": "address" },
      { "name": "terms", "type": "bytes" }
    ]
  },
  "primaryType": "Delegation",
  "domain": {
    "name": "DelegationManager",
    "version": "1",
    "chainId": $CHAIN_ID,
    "verifyingContract": "$DELEGATION_MANAGER"
  },
  "message": {
    "delegate": "$DELEGATE",
    "delegator": "$DELEGATOR",
    "authority": "$ROOT_AUTHORITY",
    "caveats": [
      { "enforcer": "$TIMESTAMP_ENFORCER", "terms": "$TIMESTAMP_TERMS" },
      { "enforcer": "$ALLOWED_TARGETS_ENFORCER", "terms": "$TARGET_TERMS" }
    ],
    "salt": $SALT
  }
}
EOF

SIGNATURE=$(cast wallet sign --data --from-file delegation-typed-data.json --private-key $DELEGATOR_PK)
```

### Using viem

```typescript
const types = {
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
} as const

const signature = await delegatorWallet.signTypedData({
  account: delegatorAccount,
  domain: {
    name: 'DelegationManager',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: DELEGATION_MANAGER,
  },
  types,
  primaryType: 'Delegation',
  message: {
    delegate: AGENT_ADDRESS,
    delegator: delegatorAccount.address,
    authority: ROOT_AUTHORITY,           // or parentDelegationHash to redelegate
    caveats: [
      { enforcer: TIMESTAMP_ENFORCER, terms: timestampTerms },
      { enforcer: ALLOWED_TARGETS_ENFORCER, terms: targetTerms },
    ],
    salt,
  },
})
```

With an OpenWallet-managed key, pass the same JSON to
`ows sign message --chain $CHAIN_ID --typed-data "$TYPED_DATA_JSON"` or the
SDK `signTypedData` (see `reference/delegation.md`).

## Step 4: Output the Signed Delegation Object

Output one signed delegation object with resolved values from this session:

```json
{
  "delegation": {
    "delegate": "0x<delegateAddr>",
    "delegator": "0x<delegatorAddr>",
    "authority": "0x<ROOT_AUTHORITY or parent delegation hash>",
    "caveats": [
      { "enforcer": "0x<enforcerAddr>", "terms": "0x<terms>", "args": "0x" }
    ],
    "salt": "<base-10 string>",
    "signature": "0x<65-byte signature>"
  },
  "chainId": "<chain ID as base-10 string>",
  "delegationManager": "0x<delegation-manager-address>",
  "delegationHash": "0x<getDelegationHash result>"
}
```

`delegationHash` comes from the on-chain `getDelegationHash` call in
Verification below. This object is the complete machine-mode response — pass
it to the delegate agent or store it for later redemption. It contains no
secrets, but anyone holding it learns the grant's scope.

## Verification

Verify before handing the object to a delegate:

```bash
# 1. Struct hash from the contract encoder (also the revocation key)
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$ROOT_AUTHORITY,[($TIMESTAMP_ENFORCER,$TIMESTAMP_TERMS,0x),($ALLOWED_TARGETS_ENFORCER,$TARGET_TERMS,0x)],$SALT,$SIGNATURE)" \
  --rpc-url $RPC)

# 2. Not pre-disabled under this hash
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" $DELEGATION_HASH --rpc-url $RPC
# false

# 3. Signature verifies against the delegator (reuses the typed-data file from Step 3)
cast wallet verify --address $DELEGATOR --data --from-file delegation-typed-data.json $SIGNATURE
# Validation succeeded. Address 0x<delegatorAddr> signed this message.
```

The full agent-side acceptance flow (including the 7702/ERC-1271 path and
caveat compliance) is `reference/delegation-authority.md`.

## Important

- The signer is always the delegator. A delegation signed by any other key
  fails redemption with `InvalidEOASignature` / `InvalidERC1271Signature`.
- `Caveat.args` is not signed. Never rely on `args` for scope — scope lives in
  `terms`. Leave `args` as `0x` unless the enforcer requires it.
- Never emit an empty `caveats[]`. Always include an expiry
  (`TimestampEnforcer`) so authority dies by default, and pin targets to the
  MultiVault for Intuition-scoped agents.
- Salt reuse resurrects revocation state: a hash disabled once is disabled
  forever unless explicitly re-enabled. Use a fresh salt per grant.
- A redelegation cannot widen authority — parent caveats still run at
  redemption. Chain depth multiplies enforcer gas costs.
- Redelegation requires the parent's `delegate` to sign the child as
  `delegator`, and the child's redemption presents both delegations leaf to
  root.
- Nothing on-chain happens at creation. The delegation only takes effect when
  redeemed, and only constrains what redemption can do.

## Post-Signing Verification

A signed delegation produces no receipt. Confirm instead:

- `getDelegationHash` on-chain matches the hash recorded in the output object.
- `cast wallet verify` over the typed data confirms the delegator signed (for
  contract/7702 delegators, `isValidSignature(digest, signature)` via
  `cast call` returns `0x1626ba7e`).
- `disabledDelegations(delegationHash)` is `false`.
- Optional dry run: simulate a representative redemption as the delegate with
  `cast call $DELEGATION_MANAGER <redeemDelegations calldata> --from 0x<delegateAddr>`
  (see Redeeming a Delegation in `reference/delegation.md`). An EOA delegator
  that has not yet broadcast its EIP-7702 upgrade will revert here — upgrade
  first.
