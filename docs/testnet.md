# Testnet deployment, smoke test and demo market

## Status

**Blocked, not executed.** The tooling is complete and runs end-to-end on the local Sandbox (`smoke_on_sandbox`,
`demo_on_sandbox`), but this machine has no testnet credentials: no funded parent account and no key
(`~/.near-credentials` is absent, nothing is set in the environment). So there are **no verified testnet account IDs,
Wasm hashes or transaction hashes**, and `deployments/testnet.json` / `deployments/testnet-demo.json` do not exist.
Those files are written only by a successful testnet run and only from values the run observed.

**Missing prerequisite:** a funded testnet account and its full-access secret key. Required balance: **18 NEAR** for
the smoke test (4+5+2+2+2 created accounts + 3 fee margin) and **15 NEAR** for the demo market (4+5+3 + 3).
The harness checks the parent's balance first and stops with a message naming the shortfall.

## Two separate deployments

| | Smoke test | Frontend demo market |
| - | - | - |
| Purpose | Prove the whole lifecycle on testnet | Persistent market for the web app |
| Final state | **Resolved**, everyone withdrawn | **Open** (cutoff `NEARODDS_DEMO_CUTOFF_DAYS`, default 7), never resolved by the script |
| Script | `scripts/testnet-smoke.sh` | `scripts/testnet-demo.sh` |
| Output | `deployments/testnet.json` | `deployments/testnet-demo.json` |
| Accounts | fresh `tok-/mkt-/alice-/bob-/carol-<tag>` sub-accounts | fresh `tok-demo-/mkt-demo-/lp-demo-<tag>` sub-accounts |
| Liquidity | none left | liquidity provider: sell YES 10 each @0.65/0.70/0.75, sell NO 10 each @0.35/0.40, bid YES 10 each @0.55/0.50 |

The frontend must read the contract ID, token ID and market ID from `deployments/testnet-demo.json` (never from the
smoke-test file).

## What the smoke test does

1. creates fresh sub-accounts of the parent; deploys `test_collateral.wasm` and the **production** `market.wasm`
   (never `market_failure_injection.wasm`), initializing the market in the same transaction as the deploy with the
   parent as `resolver_id`;
2. registers accounts, mints test tokens (parent = fixture owner), deposits with real `ft_transfer_call`;
3. Alice splits 100, offers 20 YES @0.60; Bob fills 8, Carol fills 5; Alice cancels the remainder; Bob resells 3 to
   Carol @0.70; checks the documented balances (7.80/87/100, 7.30/5/0, 4.90/8/0);
4. checks resolution is refused before the cutoff, waits for it, resolves **YES** as the parent;
5. everyone redeems (expects 94.80, 12.30, 12.90; backing 0; total 120), then withdraws and the token balances are
   checked (market holds 0);
6. records accounts, token metadata, config, git commit, on-chain contract state (code hash) and **every transaction hash**.

The smoke cutoff is 10 minutes after the market is created (testnet needs about 40 transactions); the run then waits for
the rest of it. If trading finishes after the cutoff the harness fails with a message rather than recording facts.

## Run

```bash
export NEARODDS_TESTNET_PARENT=<funded testnet account id>
export NEARODDS_TESTNET_PARENT_KEY=ed25519:<its full-access secret key>   # env only, never written to disk
bash scripts/testnet-smoke.sh                                             # throw-away lifecycle market
NEARODDS_DEMO_MINT="you.testnet:100" bash scripts/testnet-demo.sh         # open demo market (+ optional test tokens)
```

Demo users must also register with the market (`storage_deposit` with `storage_cost_per_account`) before depositing;
the frontend does this in its funds flow. Only the parent can mint test tokens (fixture owner).

## Notes

* The generated market account keeps a full-access key. Decide whether to delete it or hand it to a governed account
  before presenting the deployment as trust-minimised (see `docs/accounting.md`). The parent also remains the resolver
  and token owner: that trust is disclosed in `get_config()`.
* The market account must stay funded: resolution adds up to 547 bytes of state paid from its own balance.
* All tokens are worthless test tokens.
