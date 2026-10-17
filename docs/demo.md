# Demo output

Generated with `bun run demo 100` against a seeded throwaway database (times render in the local timezone).

```text

turn · prompt cache survived (the endpoint that served the turn)
────────────────────────────────────────────────────────────────────────────────────────────────────
09:29:00 · Δ 24m00s · orcarouter-dsv4.1-flash-free · in 9.4k (1.62M), cached 1.61M, out 1.25k · sess in 107.1k (3M), cached 2.89M, out 7k

turn · prompt cache expired after an idle gap
────────────────────────────────────────────────────────────────────────────────────────────────────
15:09:00 · Δ 1d0h · orcarouter-glm-5.3-flash · in 63.7k (76.1k), cached 12.4k, out 4.8k · sess in 121.7k (754.1k), cached 632.4k, out 9.9k · ⚠ cache expired (−607.6k)

turn · provider changed (no endpoint learned: falls back to provider/model)
────────────────────────────────────────────────────────────────────────────────────────────────────
09:52:00 · Δ 17m00s · anthropic/claude-opus-4.6 (via AWS Bedrock) · changed · in 12.8k (108.8k), cached 96k, out 3.3k · sess in 107.1k (3M), cached 2.89M, out 7k

turn · tool-call loop, latest view (the prompt size the turn ended with)
────────────────────────────────────────────────────────────────────────────────────────────────────
21:27:00 · orcarouter-dsv4.1flash · 3 steps · in 1.02k (292.6k), cached 291.6k, out 1.49k · sess in 107.1k (3M), cached 2.89M, out 7k

turn · tool-call loop, sum view (turnTotals: "sum" — every step of the turn)
────────────────────────────────────────────────────────────────────────────────────────────────────
21:27:00 · orcarouter-dsv4.1flash · 3 steps · in 2.67k (875.2k), cached 872.6k, out 2.23k · sess in 107.1k (3M), cached 2.89M, out 7k

turn · response still streaming (no line until the response ends)
────────────────────────────────────────────────────────────────────────────────────────────────────
(no line yet)

/usage overview
────────────────────────────────────────────────────────────────────────────────────────────────────
all time · 7 steps · 3 sessions · 6 prompts
steps      7                                      input      241.5k
cached     4.58M (95.0% hit)                      output     25.6k
reasoning  900                                    cost       $2.70
first      12/10/2026, 09:01:00                   last       15/10/2026, 07:20:31

this session
steps      2                                      input      30.4k
cached     712k (95.9% hit)                       output     8.4k
cost       $0.2500

/usage models
────────────────────────────────────────────────────────────────────────────────────────────────────
model                          provider                steps        in    cached       out      cost
deepseek-v4.1-flash-free       opencode                    4      124k     3.86M     13.3k   $0.5200
                               via Fireworks, DeepSeek · upstream fireworks/deepseek-v4.1-flash-fre…
glm-5.3-flash                  opencode                    2    104.7k    632.4k      9.9k   $0.7600
claude-opus-4.6                anthropic                   1     12.8k       96k      2.4k     $1.42
                               via AWS Bedrock · upstream bedrock/anthropic.claude-opus-4-6-v1 · en…

/usage cache
────────────────────────────────────────────────────────────────────────────────────────────────────
reuse losses  1 event · 607.6k tokens
  expired    1 · 607.6k

observed cache TTL bounds
model                                        hits up to   drops from   samples
opencode/deepseek-v4.1-flash-free                   22m            –         2
opencode/glm-5.3-flash                                –        23.9h         1

recent losses
15:00:00   opencode/glm-5.3-flash                        −607.6k 23.9h idle · expired

/usage latency
────────────────────────────────────────────────────────────────────────────────────────────────────
wall       p50  58.0s     p90  1m28s     p99  1m28s     n 7
stream     p50  1.2s      p90  2.8s      p99  2.8s
throughput p50  72.6/s    p90  85.1/s    p99  85.1/s

wall = request to completed · stream = request to last chunk · throughput = output+reasoning tokens…

/usage sessions
────────────────────────────────────────────────────────────────────────────────────────────────────
title                                      steps       in   cached      cost
Docs pass [opencode]                           2    30.4k     712k   $0.2500
Fix the cache regression [opencode]            2   104.7k   632.4k   $0.7600
Refactor the recor… [opencode,anthropic]       3   106.4k    3.24M     $1.69

/usage turns
────────────────────────────────────────────────────────────────────────────────────────────────────
2 turns · newest first
09:42:14 · Δ 40m00s · orcarouter-claude · changed · in 23.8k (119.8k), cached 96k, out 3.3k
09:24:20 · orcarouter-dsv4.1-flash-free · 2 steps · in 10.3k (1.62M), cached 1.61M, out 1.25k

sidebar history (compact, last 3 turns)
────────────────────────────────────────────────────────────────────────────────────────────────────
09:42 orcarouter-claude
  in 23.8k (119.8k) · out 3.3k
09:24 orcarouter-dsv4.1-flash-free
  in 10.3k (1.62M) · out 1.25k

```
