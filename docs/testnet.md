# Testnet deployment, smoke test and demo market

## Status (2026-11-05)

**Partially executed. The frontend demo market is NOT deployed yet.** The remaining blocker is funding, nothing else:

* The deployment account **`nearodds-deploy.testnet`** exists (created through the official faucet helper,
  `cargo near create-dev-account` path, 10 NEAR). Its key is stored only in `~/.near-credentials/testnet/`
  (directory 700, file 600, outside the repository). The scripts read it from there; it is never printed or committed.
* **Balance now: 3.46 NEAR.** The smoke test needs **7.5 NEAR** available and the demo needs **7.5 NEAR**; the smoke
  accounts delete themselves and return their NEAR, so one top-up to **at least ~8 NEAR more** (total >= 11.5, 15 is
  comfortable) lets both run. Asking the faucet for several more accounts to pool funds was refused by the
  environment, so this needs an explicit top-up of `nearodds-deploy.testnet` (e.g. the web faucet
  <https://near-faucet.io/>, or send testnet NEAR from your wallet) or your go-ahead to create another faucet account.
* `deployments/testnet.json` and `deployments/testnet-demo.json` do **not** exist. They are written only by a run that
  passed every assertion.

### What actually ran on testnet (first smoke attempt, tag `3872357`)

The first attempt used up ~6.5 NEAR and stopped at the resolution wait: the old public RPC
(`rpc.testnet.near.org`, deprecated) answered `TooManyRequests`, and the harness at that time generated the throw-away
sub-account keys in memory only, so those 5 sub-accounts (and their NEAR) cannot be recovered. Both problems are fixed
(FastNEAR RPC by default, keys persisted before account creation, backoff on rate limits, recovery test).

Everything before the failure **succeeded on testnet** and its on-chain state was read back afterwards:

| Fact | Value |
| - | - |
| Market (disposable) | `mkt-3872357.nearodds-deploy.testnet` |
| Token (disposable, fixture) | `tok-3872357.nearodds-deploy.testnet`, name `NearOdds TEST Collateral (no value)`, symbol `tNOC`, 6 decimals |
| Resolver / token owner | `nearodds-deploy.testnet` |
| Market code hash (base58) | `D87VzcAmR32hXwqUcwZfRvrC7HLHXREoSTjmsHwsezon` = sha256 `b41ea88129be572c3f3c48e4fcaec31afa12aca4d49c97cf237bea88f4f22d45` of `target/wasm/market.wasm` (236,408 bytes, production build) |
| Token code hash (base58) | `3csjd1rDuCq3vtAcffZbsawyKRQuT8y2GMDmPhbdQV98` = sha256 `26e81178403522a377ff4039c75923e95bbc0341aa1ae767699910532da25ddf` of `target/wasm/test_collateral.wasm` |
| Built from | commit `49983d2` (contract sources unchanged since `7d50c6c`; both hashes match the artifacts exactly) |
| Schema version | 3 |
| Balances read from the contract | Alice 7.80 collateral / 87 YES / 100 NO, Bob 7.30 / 5 / 0, Carol 4.90 / 8 / 0 |
| Totals | backing 100, available 20, reserved 0, open offers 0; market's token balance 120 (= 100 + 20) |

Transactions (testnet; look them up on any testnet explorer; sender is the named account):

| Step | Tx hash |
| - | - |
| token init | `CfYHFcAYmAvDjuTMHLheAayKN8aDgDch15vBHV1rfE1b` |
| market deploy + init (one tx) | `J6adfRkpFMp4ys9PrfgNwrKRrpGJSPSDGNqXtuDq15c3` |
| deposit x3 (ft_transfer_call) | `4SmPorAnPygmwQFMzEEDmFaMkj9pcXNpp3q7rV1FEquy`, `6xzY2JwmBvxtMJ2137gfXSBG8Rbbn7sM3X5VYCwNwB5G`, `F7g1ovcCXwYazdYCP96DWw7LHRHPKAYejihzQ44u6v2u` |
| Alice split 100 | `2vLDJtmV4a9yUsEJzQ3GmNzaHKE3X3v2eNr8c59LMT58` |
| Alice create_offer 20 YES @0.60 | `HeymxsjHxVvNQaTMtxPPEgH7C8jB2NQQaSqBr8DVZkTH` |
| Bob fill 8 / Carol fill 5 | `4SfJ1nqdMZG5Lxb2uDYyfBgQL1eoxtKn7JkfVSpePkNX` / `AoGvzdFodYZ8eGbeWWTVwHtpx8NW3StwPYC6STtjburw` |
| Alice cancel remainder (7) | `JBvQ2NLjmBRUVJbE9cAdiA5undinBhqqhzDAmoCYukqZ` |
| Bob resale offer 3 YES @0.70 / Carol fills 3 | `6sY53FZnFCvGv1frjY4yfM2aNNLuzkHvAo7F4VnM4djn` / `8cUsJDhpoW6VWS7tPotBq37ZNUvr8gqKmSTRSEZHExnJ` |
| Owner mint of 1 tNOC (mint script, tested) | `D8bKcjNsFKAP6Zrr7aK4muyVAgK5hKABfnQnQwdVWh6X` |
| Resolver `resolve_market` (resolve script, tested) | `7THtURsih927eBkcMxEaGsTEGAE1tYZi1S59HUtXwS7e` (status read back as `Resolved`, outcome `Yes`) |

**Verified on testnet:** deploy + atomic init, registration, real `ft_transfer_call` deposits, split, offers, two partial
fills, cancellation, resale, exact acceptance balances, escrow conservation, owner mint, resolver resolution.
**Not yet verified on testnet:** redeem and withdraw (the participants' keys were lost), and the post-resolution
blocking checks. They are covered by the Sandbox suite and will be exercised by the next full smoke run.

## Two separate deployments (unchanged design)

| | Smoke test | Frontend demo market |
| - | - | - |
| Purpose | Prove the whole lifecycle on testnet | Persistent market for the web app |
| Final state | **Resolved**, withdrawn, then its accounts are **deleted** (NEAR returns to the parent) | **Open** until the cutoff, never resolved by the script |
| Script | `scripts/testnet-smoke.sh` | `scripts/testnet-demo.sh` |
| Output | `deployments/testnet.json` | `deployments/testnet-demo.json` |
| Needs | 7.5 NEAR available | 7.5 NEAR available |

Per-account funding (milliNEAR): smoke token 2000, market 3000, Alice/Bob/Carol 500 each (6.5 NEAR); demo token 2000,
market 3000, liquidity provider 1500 (6.5 NEAR); plus a 1 NEAR fee margin each. The harness checks the parent's balance
first and stops with a message naming the shortfall. These sizes were validated on the Sandbox (same storage costs).

The demo market is seeded with a liquidity provider: sell YES 10 each @0.65/0.70/0.75, sell NO 10 each @0.35/0.40,
bid YES 10 each @0.55/0.50.

## Run (once the parent is funded)

```bash
export NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet     # key is read from ~/.near-credentials/testnet/
bash scripts/testnet-smoke.sh                              # ~15 min: waits for its 10-minute cutoff
bash scripts/testnet-demo.sh                               # open demo market, cutoff NEARODDS_DEMO_CUTOFF_DAYS (default 7)
NEARODDS_TOKEN=<token> NEARODDS_MINT="you.testnet:100" bash scripts/testnet-mint.sh
NEARODDS_MARKET=<market> NEARODDS_OUTCOME=Yes NEARODDS_EVIDENCE="<source link>" bash scripts/testnet-resolve.sh
```

If a run is interrupted, its sub-account keys are already on disk; recover the NEAR with
`NEARODDS_DELETE_ACCOUNTS="a.nearodds-deploy.testnet,b..." cargo test -p nearodds-market --test testnet_smoke delete_testnet_accounts -- --ignored --nocapture`.
RPC: `https://test.rpc.fastnear.com` by default (`NEARODDS_RPC_URL` to override); `rpc.testnet.near.org` is deprecated.

## Notes

* The generated market account keeps a full-access key and the parent is both resolver and token owner. That trust is
  disclosed in `get_config()`; decide on key handling before presenting the deployment as trust-minimised.
* The market account must stay funded: resolution adds up to 547 bytes of state paid from its own balance.
* All tokens are worthless test tokens.
