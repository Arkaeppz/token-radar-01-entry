# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Arkaeppz/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Arkaeppz/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar: a token launch radar whose values are fitted, not asserted. The program reads the
sealed DefiLlama snapshot, fits a launch-value model on the snapshot's own tokenised protocols
(category multiples of market cap to TVL in log space, shrunk toward the field median, with
growth and age terms that must earn their place in five-fold cross-validation), and ranks every
rankable pre-token protocol by implied value, each with the model's own held-out error band and
a costed farm plan. The dashboard it writes shows the board, a detail view per protocol, the
live-token peers the model learned from, and a method view with the full validation table and
an accounting of every protocol in the snapshot.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

In the grader, the sealed snapshot is mounted at `/input` and the output lands in `/output`.
Locally, point `--input` at any copy of the competition's `snapshot.json`. The run is
deterministic: two runs over the same snapshot write the same bytes. Open
`out/dashboard/index.html` in a browser to read the radar; it renders with no network.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
