#!/usr/bin/env node
// ERC-7710 delegation end-to-end test on Intuition testnet (13579).
//
// Flow: upgrade delegator EOA via EIP-7702 -> sign delegation (EIP-712) ->
// agent redeems delegation to createAtoms on the MultiVault as the delegator ->
// delegator revokes via disableDelegation -> confirm a second write is blocked.
//
// Usage:
//   npm i viem   (any directory; resolved from cwd)
//   RPC=https://testnet.rpc.intuition.systems/http \
//   DELEGATOR_PK=0x... AGENT_PK=0x... \
//   node scripts/delegation-e2e.mjs
//
// Optional env:
//   ANVIL_FUND=1   fund both accounts via anvil_setBalance (fork testing only)
//   OUT=path.json  write the run summary JSON to this path
//
// Never reuse these keys for anything else. Generate throwaways:
//   node -e "const{generatePrivateKey}=require('viem/accounts');console.log(generatePrivateKey())"

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const require = createRequire(process.cwd() + '/')
const {
  createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther,
  encodeFunctionData, encodeAbiParameters, encodePacked, stringToHex, toHex, pad,
  hashTypedData, decodeErrorResult, zeroAddress,
} = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const { recoverAddress } = require('viem')

// ---------------------------------------------------------------- constants

const DELEGATION_MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'
const EIP7702_DELEGATOR_IMPL = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'
const TIMESTAMP_ENFORCER = '0x1046bb45C8d673d4ea75321280DB34899413c069'
const ALLOWED_TARGETS_ENFORCER = '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB'
const ROOT_AUTHORITY = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const MODE_SINGLE_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000000'
const MULTIVAULT_BY_CHAIN = {
  1155: '0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e',
  13579: '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91',
}

const delegationTupleAbi = '(address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)'

const dmAbi = parseAbi([
  `function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)`,
  `function disableDelegation(${delegationTupleAbi} delegation)`,
  `function getDelegationHash(${delegationTupleAbi} delegation) pure returns (bytes32)`,
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
  'function getDomainHash() view returns (bytes32)',
  'error CannotUseADisabledDelegation()',
  'error InvalidAuthority()',
  'error InvalidDelegate()',
  'error InvalidDelegator()',
  'error InvalidEOASignature()',
  'error InvalidERC1271Signature()',
])

const mvAbi = parseAbi([
  'function getAtomCost() view returns (uint256)',
  'function calculateAtomId(bytes data) pure returns (bytes32)',
  'function isTermCreated(bytes32 id) view returns (bool)',
  'function createAtoms(bytes[] atomDatas, uint256[] assets) payable returns (bytes32[])',
])

const eip712Types = {
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
}

// ------------------------------------------------------------------ helpers

const summary = { steps: {}, txs: {} }
const log = (label, value) => console.log(`${label}: ${value}`)
const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1) }

function encodeSingleExecution(target, value, callData) {
  return encodePacked(['address', 'uint256', 'bytes'], [target, value, callData])
}

function encodePermissionContext(delegations) {
  return encodeAbiParameters(
    [{
      type: 'tuple[]',
      components: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        {
          name: 'caveats', type: 'tuple[]', components: [
            { name: 'enforcer', type: 'address' },
            { name: 'terms', type: 'bytes' },
            { name: 'args', type: 'bytes' },
          ],
        },
        { name: 'salt', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }],
    [delegations],
  )
}

function buildRedeemCalldata(delegation, executionCallData) {
  return encodeFunctionData({
    abi: dmAbi,
    functionName: 'redeemDelegations',
    args: [[encodePermissionContext([delegation])], [MODE_SINGLE_DEFAULT], [executionCallData]],
  })
}

// --------------------------------------------------------------------- main

const RPC = process.env.RPC || 'https://testnet.rpc.intuition.systems/http'
if (!process.env.DELEGATOR_PK || !process.env.AGENT_PK) die('set DELEGATOR_PK and AGENT_PK')

const delegator = privateKeyToAccount(process.env.DELEGATOR_PK)
const agent = privateKeyToAccount(process.env.AGENT_PK)

const publicClient = createPublicClient({ transport: http(RPC) })
const chainId = await publicClient.getChainId()
const MULTIVAULT = MULTIVAULT_BY_CHAIN[chainId]
if (!MULTIVAULT) die(`unsupported chain ${chainId}`)
const chain = {
  id: chainId, name: `intuition-${chainId}`,
  nativeCurrency: { decimals: 18, name: 'Trust', symbol: 'TRUST' },
  rpcUrls: { default: { http: [RPC] } },
}
const delegatorWallet = createWalletClient({ account: delegator, chain, transport: http(RPC) })
const agentWallet = createWalletClient({ account: agent, chain, transport: http(RPC) })

console.log(`chain ${chainId} | delegator ${delegator.address} | agent ${agent.address}`)
summary.chainId = chainId
summary.delegator = delegator.address
summary.agent = agent.address

// Step 0: funding
if (process.env.ANVIL_FUND) {
  for (const addr of [delegator.address, agent.address]) {
    await publicClient.request({ method: 'anvil_setBalance', params: [addr, toHex(parseEther('1'))] })
  }
}
const delegatorBalance = await publicClient.getBalance({ address: delegator.address })
const agentBalance = await publicClient.getBalance({ address: agent.address })
log('delegator balance', formatEther(delegatorBalance))
log('agent balance', formatEther(agentBalance))
if (delegatorBalance < parseEther('0.005') || agentBalance < parseEther('0.002')) {
  die(`insufficient funds. Fund via https://testnet.hub.intuition.systems faucet:\n` +
    `  delegator ${delegator.address} needs >= 0.005 tTRUST\n` +
    `  agent     ${agent.address} needs >= 0.002 tTRUST`)
}

// Step 1: EIP-7702 upgrade of the delegator EOA
const expectedCode = ('0xef0100' + EIP7702_DELEGATOR_IMPL.slice(2)).toLowerCase()
let code = await publicClient.getCode({ address: delegator.address }) ?? '0x'
if (code.toLowerCase() !== expectedCode) {
  const authorization = await delegatorWallet.signAuthorization({
    account: delegator, contractAddress: EIP7702_DELEGATOR_IMPL, executor: 'self',
  })
  const authTx = await delegatorWallet.sendTransaction({
    authorizationList: [authorization], to: delegator.address, data: '0x', value: 0n,
  })
  const authReceipt = await publicClient.waitForTransactionReceipt({ hash: authTx })
  if (authReceipt.status !== 'success') die('7702 authorization tx reverted')
  summary.txs.authorization = authTx
  log('7702 authorization tx', authTx)
  code = await publicClient.getCode({ address: delegator.address }) ?? '0x'
}
if (code.toLowerCase() !== expectedCode) die(`delegator code mismatch: ${code}`)
log('delegator code', code)
summary.steps.eip7702Upgrade = 'ok'

// Step 2: sign the delegation (EIP-712) with expiry + target allowlist caveats
const now = BigInt(Math.floor(Date.now() / 1000))
const expiry = now + 86400n
const timestampTerms = encodePacked(['uint128', 'uint128'], [0n, expiry])
const targetTerms = MULTIVAULT.toLowerCase()
const caveats = [
  { enforcer: TIMESTAMP_ENFORCER, terms: timestampTerms, args: '0x' },
  { enforcer: ALLOWED_TARGETS_ENFORCER, terms: targetTerms, args: '0x' },
]
const delegationUnsigned = {
  delegate: agent.address,
  delegator: delegator.address,
  authority: ROOT_AUTHORITY,
  caveats,
  salt: BigInt(Date.now()),
}
const domain = {
  name: 'DelegationManager', version: '1',
  chainId, verifyingContract: DELEGATION_MANAGER,
}
const signature = await delegatorWallet.signTypedData({
  account: delegator, domain, types: eip712Types,
  primaryType: 'Delegation',
  message: {
    ...delegationUnsigned,
    caveats: caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
  },
})
const delegation = { ...delegationUnsigned, signature }
summary.delegation = JSON.parse(JSON.stringify(delegation, (k, v) => typeof v === 'bigint' ? v.toString() : v))

// Step 3: agent-side authority verification before acting
const delegationHash = await publicClient.readContract({
  address: DELEGATION_MANAGER, abi: dmAbi, functionName: 'getDelegationHash', args: [delegation],
})
const domainHash = await publicClient.readContract({
  address: DELEGATION_MANAGER, abi: dmAbi, functionName: 'getDomainHash',
})
const localDigest = hashTypedData({
  domain, types: eip712Types, primaryType: 'Delegation',
  message: { ...delegationUnsigned, caveats: caveats.map(({ enforcer, terms }) => ({ enforcer, terms })) },
})
const recovered = await recoverAddress({ hash: localDigest, signature })
if (recovered.toLowerCase() !== delegator.address.toLowerCase()) die('signature recovery mismatch')
const disabledBefore = await publicClient.readContract({
  address: DELEGATION_MANAGER, abi: dmAbi, functionName: 'disabledDelegations', args: [delegationHash],
})
if (disabledBefore) die('delegation already disabled')
log('delegation hash', delegationHash)
log('domain hash', domainHash)
log('signature valid, not revoked, expiry', expiry.toString())
summary.delegationHash = delegationHash
summary.steps.authorityVerification = 'ok'

// Step 4: agent redeems the delegation -- createAtoms executed by the delegator account
const atomCost = await publicClient.readContract({
  address: MULTIVAULT, abi: mvAbi, functionName: 'getAtomCost',
})
const atomData = stringToHex(`caip10:eip155:${chainId}:${delegator.address.toLowerCase()}`)
const atomId = await publicClient.readContract({
  address: MULTIVAULT, abi: mvAbi, functionName: 'calculateAtomId', args: [atomData],
})
const exists = await publicClient.readContract({
  address: MULTIVAULT, abi: mvAbi, functionName: 'isTermCreated', args: [atomId],
})
if (exists) die(`atom ${atomId} already exists; use a fresh delegator key`)
const createAtomsCalldata = encodeFunctionData({
  abi: mvAbi, functionName: 'createAtoms', args: [[atomData], [atomCost]],
})
const execution = encodeSingleExecution(MULTIVAULT, atomCost, createAtomsCalldata)
const redeemCalldata = buildRedeemCalldata(delegation, execution)

const redeemTx = await agentWallet.sendTransaction({
  to: DELEGATION_MANAGER, data: redeemCalldata, value: 0n,
})
const redeemReceipt = await publicClient.waitForTransactionReceipt({ hash: redeemTx })
if (redeemReceipt.status !== 'success') die('redeemDelegations tx reverted')
const created = await publicClient.readContract({
  address: MULTIVAULT, abi: mvAbi, functionName: 'isTermCreated', args: [atomId],
})
if (!created) die('atom not created after redemption')
log('redeem tx (atom created as delegator)', redeemTx)
log('atom id', atomId)
summary.txs.delegatedWrite = redeemTx
summary.atomId = atomId
summary.steps.delegatedWrite = 'ok'

// Step 5: delegator revokes on-chain
const disableTx = await delegatorWallet.sendTransaction({
  to: DELEGATION_MANAGER,
  data: encodeFunctionData({ abi: dmAbi, functionName: 'disableDelegation', args: [delegation] }),
  value: 0n,
})
const disableReceipt = await publicClient.waitForTransactionReceipt({ hash: disableTx })
if (disableReceipt.status !== 'success') die('disableDelegation tx reverted')
const disabledAfter = await publicClient.readContract({
  address: DELEGATION_MANAGER, abi: dmAbi, functionName: 'disabledDelegations', args: [delegationHash],
})
if (!disabledAfter) die('disabledDelegations still false after revocation')
log('revocation tx', disableTx)
summary.txs.revocation = disableTx
summary.steps.revocation = 'ok'

// Step 6: second write must now be blocked
const atomData2 = stringToHex(`caip10:eip155:${chainId}:${agent.address.toLowerCase()}`)
const createAtoms2 = encodeFunctionData({
  abi: mvAbi, functionName: 'createAtoms', args: [[atomData2], [atomCost]],
})
const execution2 = encodeSingleExecution(MULTIVAULT, atomCost, createAtoms2)
const redeemCalldata2 = buildRedeemCalldata(delegation, execution2)

let blockedBySimulation = false
try {
  await publicClient.call({ account: agent.address, to: DELEGATION_MANAGER, data: redeemCalldata2 })
} catch (err) {
  let revertData
  for (let e = err; e; e = e.cause) {
    const candidate = typeof e.data === 'string' ? e.data : e.data?.data
    if (typeof candidate === 'string' && candidate.startsWith('0x')) { revertData = candidate; break }
  }
  revertData ??= String(err.shortMessage ?? err.message).match(/0x[0-9a-fA-F]{8,}/)?.[0]
  try {
    const decoded = decodeErrorResult({ abi: dmAbi, data: revertData })
    blockedBySimulation = decoded.errorName === 'CannotUseADisabledDelegation'
    log('simulation revert', decoded.errorName)
  } catch {
    blockedBySimulation = true
    log('simulation revert (raw)', String(err.shortMessage ?? err.message).slice(0, 120))
  }
}
if (!blockedBySimulation) die('second write was NOT blocked in simulation')

const blockedTx = await agentWallet.sendTransaction({
  to: DELEGATION_MANAGER, data: redeemCalldata2, value: 0n, gas: 1_000_000n,
})
const blockedReceipt = await publicClient.waitForTransactionReceipt({ hash: blockedTx })
if (blockedReceipt.status !== 'reverted') die('second write unexpectedly succeeded on-chain')
log('blocked attempt tx (reverted as expected)', blockedTx)
summary.txs.blockedAttempt = blockedTx
summary.steps.postRevocationBlock = 'ok'

console.log('\nE2E PASS: create -> delegated write -> revoke -> blocked')
summary.result = 'PASS'
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2))
