# disableDelegation

Revoke a delegation on-chain so it can no longer be redeemed. Follow these
steps in order.

**Requires:** `$RPC`, `$CHAIN_ID`, `$DELEGATION_MANAGER` from
`reference/delegation.md`, and the full signed delegation object being revoked
(`operations/create-delegation.md` output).

**Function:** `disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)`

## Semantics

- **The signer must be the delegator** of the delegation being disabled —
  `msg.sender == delegation.delegator` is enforced on-chain
  (`InvalidDelegator` otherwise). For a 7702-upgraded delegator this is a
  normal transaction from the EOA key.
- Revocation is keyed by delegation hash and takes the **full struct** as
  calldata (the contract recomputes the hash; the `signature` field is carried
  but not hashed).
- **Revocation propagates downstream.** Redemption validates every delegation
  hash in the chain, so disabling a delegation kills every redelegation that
  chains through it. Disabling the root revokes the entire tree at once.
  Disabling an intermediate delegation kills only its subtree — the parent and
  siblings stay live.
- Revocation is reversible: the delegator can call
  `enableDelegation(delegation)` with the same struct to restore it.
- **On-chain revocation vs expiry:** prefer short `TimestampEnforcer` windows
  at creation so authority dies by default with zero gas. Use
  `disableDelegation` for immediate kills — compromised agent, scope mistake,
  task finished early — or when a long-lived grant must end now. Expiry needs
  no transaction but cannot be accelerated; revocation is instant but costs a
  transaction and must be sent per delegation (per subtree).

## Step 1: Query Prerequisites

```bash
# Compute the delegation hash from the full struct (pure)
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,[($ENFORCER_1,$TERMS_1,0x),($ENFORCER_2,$TERMS_2,0x)],$SALT,$SIGNATURE)" \
  --rpc-url $RPC)

# Check current revocation state — disabling twice reverts with AlreadyDisabled
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" $DELEGATION_HASH --rpc-url $RPC
# must be false to proceed
```

Confirm the signer of this transaction is `delegation.delegator`. If the goal
is revoking an entire grant tree, target the root delegation; revoking leaves
one by one leaves the root redeemable.

## Step 2: Encode the Calldata

### Using cast

```bash
CALLDATA=$(cast calldata \
  "disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,[($ENFORCER_1,$TERMS_1,0x),($ENFORCER_2,$TERMS_2,0x)],$SALT,$SIGNATURE)")
```

### Using viem

```typescript
import { encodeFunctionData, parseAbi } from 'viem'

const dmAbi = parseAbi([
  'function disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)',
])

const data = encodeFunctionData({
  abi: dmAbi,
  functionName: 'disableDelegation',
  args: [signedDelegation],   // the exact struct from the delegation object
})
```

The struct must match the signed delegation field-for-field (including
`salt` and each caveat's `enforcer`/`terms`) — any difference produces a
different hash and disables nothing. Take it verbatim from the signed
delegation object.

## Step 3: msg.value

```
msg.value = 0 (non-payable)
```

## Step 4: Output the Unsigned Transaction JSON

Output one unsigned transaction object with resolved values from this session:

```json
{
  "to": "0x<delegation-manager-address>",
  "data": "0x<calldata>",
  "value": "0",
  "chainId": "<chain ID as base-10 string>"
}
```

Set `to` to `$DELEGATION_MANAGER` — not the MultiVault — and `chainId` to
`$CHAIN_ID`. The transaction must be signed and broadcast **by the
delegator's key**.

## Important

- Only the delegator can disable. An agent holding a delegation cannot revoke
  it — it can only let it expire or stop using it. (A redelegating agent *is*
  the delegator of its child delegations and can disable those.)
- Disabling the root kills all downstream redelegations in one transaction;
  disabling a child does not affect the parent.
- Disabled state is permanent for that hash until `enableDelegation` is
  called. Signing a byte-identical delegation again (same salt) does not
  bypass it; a new salt does — treat leaked delegator keys as a full
  compromise, not something revocation can contain.
- Works while the DelegationManager is paused — pausing stops redemptions,
  not revocations.
- In-flight redemptions land by transaction order: a redemption mined before
  the revocation still executes. Verify post-broadcast state before treating
  authority as dead.
- For routine scope-down, prefer issuing a tighter delegation and revoking
  the old one, in that order, to avoid an authority gap.

## Post-Broadcast Verification

After the wallet layer broadcasts the tx, verify per
`reference/post-write-verification.md`:

- Receipt `status = success`.
- `disabledDelegations(delegationHash)` now returns `true`.
- Receipt contains one `DisabledDelegation` event from the DelegationManager
  with `delegationHash`, `delegator`, and `delegate` topics matching the
  revoked delegation.
  Event topic0: `0xea589ba9473ee1fe77d352c7ed919747715a5d22931b972de9b02a907c66d5dd`
- A re-simulated redemption as the delegate now reverts with
  `CannotUseADisabledDelegation` (selector `0x05baa052`):
  `cast call $DELEGATION_MANAGER <redeemDelegations calldata> --from 0x<delegateAddr> --rpc-url $RPC`
