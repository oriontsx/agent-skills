# Delegated Authority Verification

Use this reference when this agent holds a delegation and intends to execute
an Intuition write under it. The authority gate runs **before any write** —
before calldata is wrapped for redemption and before the unsigned transaction
is emitted to the signer. It answers one question from on-chain state and the
delegation object alone: *is this agent currently authorized to perform this
specific operation on the delegator's behalf?*

Contract addresses, struct anatomy, and hashing rules: `reference/delegation.md`.

## Receiving and Parsing a Delegation

A delegation arrives as the signed delegation object produced by
`operations/create-delegation.md`:

```json
{
  "delegation": {
    "delegate": "0x…", "delegator": "0x…", "authority": "0x…",
    "caveats": [ { "enforcer": "0x…", "terms": "0x…", "args": "0x" } ],
    "salt": "<base-10 string>", "signature": "0x…"
  },
  "chainId": "13579",
  "delegationManager": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  "delegationHash": "0x…"
}
```

Treat the object as **untrusted input** regardless of source. Parse and
type-check every field (addresses are 20 bytes, `authority` and hashes are 32
bytes, `salt` fits uint256, hex fields are `0x`-prefixed). A delegation object
proposes authority; only the verification below establishes it. Never let the
object (or the party sending it) supply transaction fields directly — the
trusted-intent boundary from `reference/autonomous-policy.md` applies to
delegated writes unchanged.

For a redelegation chain, expect an array of these objects ordered leaf to
root, where `delegations[i].authority == delegations[i+1].delegationHash` and
the last is `ROOT_AUTHORITY`.

## Verification Steps

Run all steps against `$RPC` for the session chain. Stop at the first failure.

### 1. Chain and manager binding

`chainId` equals the session `$CHAIN_ID`, and `delegationManager` equals
`$DELEGATION_MANAGER` for that chain (`reference/delegation.md`). A delegation
signed for another chain or another verifying contract is invalid here —
domain separation makes the signature unverifiable, not merely misrouted.

### 2. Delegate binding

`delegation.delegate` is this agent's signing address, or `ANY_DELEGATE`
(`0x…0a11`). Anything else means this agent cannot redeem it
(`InvalidDelegate` on-chain) — halt.

### 3. Recompute the delegation hash

```bash
DELEGATION_HASH=$(cast call $DELEGATION_MANAGER \
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))(bytes32)" \
  "($DELEGATE,$DELEGATOR,$AUTHORITY,[($ENFORCER_1,$TERMS_1,0x)],$SALT,$SIGNATURE)" \
  --rpc-url $RPC)
```

It must equal the object's `delegationHash`. Recompute from parsed fields —
never trust the carried hash for the revocation check.

### 4. Signature validity

Resolve the digest, then verify along the delegator's account-state path:

```bash
DOMAIN_HASH=$(cast call $DELEGATION_MANAGER "getDomainHash()(bytes32)" --rpc-url $RPC)
DIGEST=$(cast keccak $(cast concat-hex 0x1901 $DOMAIN_HASH $DELEGATION_HASH))

CODE=$(cast code $DELEGATOR --rpc-url $RPC)
if [ "$CODE" = "0x" ]; then
  # Plain EOA: ECDSA recovery via the ecrecover precompile must yield the delegator.
  V=0x${SIGNATURE:130:2}; R=0x${SIGNATURE:2:64}; S=0x${SIGNATURE:66:64}
  cast parse-bytes32-address $(cast call 0x0000000000000000000000000000000000000001 \
    --data $(cast concat-hex $DIGEST $(cast to-uint256 $V) $R $S) --rpc-url $RPC)
  # == $DELEGATOR
  # Note: redemption will still fail at execution until the delegator
  # broadcasts its EIP-7702 upgrade — flag as not-yet-executable.
else
  # 7702-upgraded EOA or contract account: ERC-1271.
  cast call $DELEGATOR "isValidSignature(bytes32,bytes)(bytes4)" $DIGEST $SIGNATURE --rpc-url $RPC
  # == 0x1626ba7e
fi
```

```typescript
import { hashTypedData, recoverAddress } from 'viem'

const digest = hashTypedData({ domain, types, primaryType: 'Delegation', message })
const code = await client.getCode({ address: delegation.delegator })
const valid = code === undefined || code === '0x'
  ? (await recoverAddress({ hash: digest, signature: delegation.signature }))
      .toLowerCase() === delegation.delegator.toLowerCase()
  : await client.readContract({
      address: delegation.delegator,
      abi: parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']),
      functionName: 'isValidSignature',
      args: [digest, delegation.signature],
    }) === '0x1626ba7e'
```

`domain`, `types`, and `message` are built exactly as in
`operations/create-delegation.md` Step 3 (caveats without `args`, no
`signature` field).

### 5. Authority chain validation

- Single delegation: `authority == ROOT_AUTHORITY`.
- Chain: for each link, `delegations[i].authority` equals the recomputed hash
  of `delegations[i+1]`, `delegations[i].delegator` equals
  `delegations[i+1].delegate` (or that parent uses `ANY_DELEGATE`), the root's
  `authority` is `ROOT_AUTHORITY`, and steps 3–4 pass for **every** link.

### 6. Revocation and pause state

```bash
cast call $DELEGATION_MANAGER "disabledDelegations(bytes32)(bool)" $DELEGATION_HASH --rpc-url $RPC
# must be false — check every hash in a chain; one disabled link kills the chain

cast call $DELEGATION_MANAGER "paused()(bool)" --rpc-url $RPC
# must be false — paused blocks all redemptions chain-wide
```

These are live state: re-check immediately before emitting each redemption
transaction, not once per session. The delegator can revoke at any time.

### 7. Caveat compliance for the intended operation

Decode every caveat's `terms` and evaluate against the intended execution
`(target, value, callData)` — the same triple that will be packed for
`redeemDelegations`. Common enforcers:

| Enforcer | Check before acting |
|---|---|
| TimestampEnforcer | `validAfter < block.timestamp < validBefore` (terms: `uint128 ++ uint128`; 0 = unset). Leave margin — a redemption mined after `validBefore` reverts. |
| AllowedTargetsEnforcer | Intended `target` (the MultiVault for Intuition writes) is one of the packed 20-byte addresses |
| AllowedMethodsEnforcer | First 4 bytes of intended `callData` are among the packed selectors |
| LimitedCallsEnforcer | `callCounts(DELEGATION_MANAGER, delegationHash) < maxCalls` (read on the enforcer; terms: uint256) |
| ValueLteEnforcer | Intended execution `value` <= terms uint256 |
| NativeTokenTransferAmountEnforcer | Cumulative spend + intended `value` <= allowance |
| ExactCalldataEnforcer | Intended `callData` equals terms exactly |
| RedeemerEnforcer | This agent's address is among the packed addresses |
| BlockNumberEnforcer | Current block within the `uint128 ++ uint128` window |

An enforcer this agent cannot statically evaluate (unknown address or opaque
terms) is a **caveat mismatch** for any operation it might constrain — do not
assume it passes; rely on the Step 9 simulation only for enforcers with
redemption-time state.

Every delegation in a chain contributes caveats; all must pass.

### 8. Delegator account executability

```bash
cast code $DELEGATOR --rpc-url $RPC          # non-empty (7702 designator or contract)
cast balance $DELEGATOR --rpc-url $RPC       # >= intended execution value (payable ops spend the delegator's $TRUST)
```

### 9. Simulation

Build the full `redeemDelegations` calldata (Redeeming a Delegation,
`reference/delegation.md`) and dry-run as the agent:

```bash
cast call $DELEGATION_MANAGER $REDEEM_CALLDATA --from 0x<agentAddr> --rpc-url $RPC
```

Simulation is the only pre-broadcast check that exercises stateful enforcers
exactly as redemption will. It complements — not replaces — steps 1–8: a
passing simulation with a failed static check still halts.

## Integration with Autonomous Policy

Delegated writes run both gates. The flow wraps
`reference/autonomous-policy.md`'s decision flow:

1. Resolve the trusted intent for the Intuition operation (policy flow steps
   1–6): recompute arguments from trusted reads, encode the **inner**
   MultiVault calldata, validate term binding, receiver, and value limits
   exactly as for a direct write. Receiver defaults to the **delegator** (the
   on-chain `msg.sender`), never the agent.
2. Run the authority gate (steps 1–9 above) against that inner execution
   `(MULTIVAULT, value, innerCalldata)`.
3. Wrap into `redeemDelegations` calldata. The outer transaction is
   `{to: DELEGATION_MANAGER, value: 0}` — policy address allowlists must
   therefore include the DelegationManager for the session chain alongside
   the MultiVault, and per-tx value limits apply to the **execution value**,
   not the outer `value: 0`.
4. Simulate the outer transaction (policy flow step 10) and apply approval
   mode (step 11). Approval-request objects embed the outer redemption tx as
   `proposedTx`.

Policy file addition for delegated sessions:

```json
"delegation": {
  "delegationManagerByChain": {
    "1155": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    "13579": "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3"
  },
  "requireAuthorityVerification": true,
  "maxChainDepth": 2
}
```

## Decision Tree

```
parse + type-check object ──fail──> halt, report (malformed)
        │
chain/manager binding (1) ──fail──> halt, report
delegate binding (2)      ──fail──> halt, report
hash + signature (3,4)    ──fail──> halt, report (invalid delegation)
authority chain (5)       ──fail──> halt, report
revoked or paused (6)     ──fail──> halt, report (authority dead — do not retry)
expired (7, timestamp)    ──fail──> halt, report (authority dead — do not retry)
        │
other caveat mismatch (7) ──fail──> reject THIS action, report; other
        │                           compliant actions may proceed
delegator executable (8)  ──fail──> halt, report (delegator must upgrade/fund)
simulation (9)            ──fail──> reject THIS action, report revert reason
        │
        └──all pass──> proceed: emit the redemption tx
                       {to: DELEGATION_MANAGER, data, value: "0", chainId}
```

Halt outcomes invalidate the delegation for the whole session (expired,
revoked, bad signature — no operation can succeed). Reject outcomes are
per-action (this operation is out of scope; a differently-scoped operation
under the same delegation may still pass).

## Authority Failure Output

When the gate fails, emit one machine-readable object instead of a
transaction:

```json
{
  "status": "authority_failed",
  "disposition": "halt",
  "operation": "createAtoms",
  "check": "revocation",
  "reason": "delegation 0x6fc0…5102 is disabled on-chain",
  "delegationHash": "0x<hash>",
  "delegator": "0x<delegatorAddr>"
}
```

- `disposition`: `"halt"` (authority dead for the session) or
  `"action_rejected"` (this action out of scope; others may proceed).
- `check`: the failed step — `parse`, `chain_binding`, `delegate_binding`,
  `hash_mismatch`, `signature`, `authority_chain`, `revocation`, `paused`,
  `expiry`, `caveat_compliance`, `delegator_account`, `simulation`.

The JSON object is the complete machine-mode response for the failed write.

## Error Patterns

Redemption reverts map to gate failures — a revert here means the gate was
skipped or state changed after it ran:

| Error | Selector | Cause | Fix |
|-------|----------|-------|-----|
| `InvalidDelegate` | `0xb5863604` | Tx sender is not the leaf `delegate` (and delegate is not `ANY_DELEGATE`), or a chain link's delegator/delegate mismatch | Redeem from the delegate address; re-run step 2/5 |
| `InvalidEOASignature` | `0x3db6791c` | EOA delegator's signature does not recover to `delegator` | Delegation corrupted or wrong domain/chain; re-run step 4; request re-issue |
| `InvalidERC1271Signature` | `0x155ff427` | Contract/7702 delegator rejected the signature | Same as above for the 1271 path |
| `InvalidAuthority` | `0xded4370e` | Chain linkage broken: `authority` doesn't match next hash, or root authority is not `ROOT_AUTHORITY` | Re-order leaf to root; re-run step 5 |
| `CannotUseADisabledDelegation` | `0x05baa052` | A delegation in the chain was revoked | Halt — authority is dead; report to the delegator |
| `EnforcedPause` | `0xd93c0665` | DelegationManager redemptions paused by owner | Halt; retry only after `paused()` returns false |
| `TimestampEnforcer:expired-delegation` (string revert) | — | `validBefore` passed | Halt — request a fresh delegation |
| `TimestampEnforcer:early-delegation` (string revert) | — | `validAfter` not reached | Wait until the window opens |
| `AllowedTargetsEnforcer:target-address-not-allowed` (string revert) | — | Execution target outside the allowlist | Reject action; only allowed targets are in scope |
| `AllowedMethodsEnforcer:method-not-allowed` (string revert) | — | Selector outside the allowlist | Reject action; use an allowed function |
| `LimitedCallsEnforcer:limit-exceeded` (string revert) | — | Redemption count exhausted | Halt for this delegation; request a fresh grant |
| `NotDelegationManager` (on the delegator account) | — | Execution attempted without going through the DelegationManager | Always call via `redeemDelegations` |
| Revert with empty data on execution | — | Delegator is a plain EOA (no code) — `executeFromExecutor` has no target | Delegator must broadcast the EIP-7702 upgrade first |
