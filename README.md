# HLS WebVTT Subtitle Normalizer

把 HLS 分段下发的 WebVTT 字幕还原到一条**统一的、不回绕的 90 kHz MPEGTS
时间轴**上，避免 33 位 MPEGTS 计数器回绕后字幕跳回节目开头。

- 零运行时依赖（仅使用 Node.js ≥22 内置模块）
- 提供 `POST /api/subtitles/normalize` 与 `GET /health`
- 完整校验：WebVTT 头、毫秒级时间戳、cue 区间、33 位 MPEGTS 值、段序号连续性
- 基于首段绝对锚点与相邻锚点最大间隔，**唯一**展开回绕
- 结果按 `(startTicks, sequence, 段内次序)` 稳定排序，跨回绕边界仍保持先后关系
- Docker / Docker Compose 交付，另有一次性 `verify` 服务：等待应用健康后
  运行代码测试、构建检查与含回绕样例的 API 冒烟，并以退出码报告结果

## 运行

```bash
# 应用（宿主机端口可用 APP_PORT 覆盖，默认 8080）
docker compose up app
APP_PORT=9090 docker compose up app

# 一次性校验（应用健康后自动运行，退出码即结果）
docker compose run --build verify
# 或编排方式（verify 结束后整体退出）
docker compose up --build --abort-on-container-exit --exit-code-from verify
```

本地无 Docker 时：

```bash
npm start                 # 启动服务，PORT 环境变量可改端口
npm test                  # node --test 单元/HTTP 测试
APP_URL=http://127.0.0.1:8080 npm run smoke
```

## API

### `POST /api/subtitles/normalize`

请求：

```json
{
  "firstSegmentAnchor": 8589484592,
  "maxAnchorInterval": 10000000,
  "segments": [
    {
      "sequence": 0,
      "text": "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:8589484592,LOCAL:00:00:00.000\n\n00:00:04.000 --> 00:00:05.000\nbefore wrap\n"
    },
    {
      "sequence": 1,
      "text": "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:100000,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:00:02.000\nafter wrap\n"
    }
  ]
}
```

字段约束：

| 字段 | 约束 |
| --- | --- |
| `firstSegmentAnchor` | 非负安全整数；首段 `MPEGTS` 的绝对值（低 33 位须与首段头一致） |
| `maxAnchorInterval` | ≥1 的安全整数（90 kHz ticks），相邻段锚点距离的上界 |
| `segments` | 1–64 个对象，`sequence` 必须连续（可乱序提交），`text` 为 UTF-8 |
| 每段文本 | 必须以 `WEBVTT` 开头，**恰好一个** `X-TIMESTAMP-MAP` |
| 全部文本合计 | ≤ 1 MiB（按 UTF-8 字节计） |
| `MPEGTS` | 0..2³³−1 的整数 |
| 时间戳 | `[HH:]MM:SS.mmm`，毫秒三位必填；cue 起点严格小于终点 |

成功响应（`200`）：

```json
{
  "segmentCount": 2,
  "firstSequence": 0,
  "cues": [
    { "startTicks": 8589844592, "endTicks": 8589934592, "text": "before wrap" },
    { "startTicks": 8590034592, "endTicks": 8590214592, "text": "after wrap" }
  ]
}
```

`ticks` 全部为整数 90 kHz 单位；排序键为绝对起点、段序号、段内次序。

错误响应：

```json
{ "error": { "code": "ANCHOR_INCOMPATIBLE", "message": "…", "segment": 1 } }
```

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_JSON` / `INVALID_REQUEST` | 400 | 报文或字段非法 |
| `TOTAL_PAYLOAD_TOO_LARGE` / `EMPTY_SEGMENT_LIST` / `SEGMENT_COUNT_OUT_OF_RANGE` | 400 | 体量/数量限制 |
| `INVALID_SEQUENCE` / `DUPLICATE_SEQUENCE` | 400 | 段序号不连续或重复 |
| `INVALID_WEBVTT_HEADER` / `MISSING_TIMESTAMP_MAP` / `MULTIPLE_TIMESTAMP_MAPS` | 400 | 头结构错误 |
| `INVALID_MPEGTS` / `INVALID_LOCAL` | 400 | 33 位 MPEGTS / LOCAL 非法 |
| `INVALID_CUE_TIME` / `INVALID_CUE_RANGE` / `CUE_TIME_OUT_OF_RANGE` | 400 | 时间戳格式、区间或分量非法 |
| `ANCHOR_INCOMPATIBLE` | 422 | 首锚点与首段不相容，或不存在满足最大间隔的展开 |
| `AMBIGUOUS_UNWRAP` | 422 | 存在两个及以上回绕次数都满足间隔，无法唯一展开 |

可归因的错误均带 `segment`（段序号）。

## 回绕展开算法

对相邻段，记上一段绝对锚点为 `P`、本段原始 33 位计数为 `r`，前向模距离

```
delta = (r - (P mod 2^33)) mod 2^33
```

则真实距离必为 `distance = delta + k·2^33`（k ≥ 0），并要求
`0 ≤ distance ≤ maxAnchorInterval`（`distance = 0` 表示计数器恰好未前进）：

- 无 k 满足 → `ANCHOR_INCOMPATIBLE`
- 两个或更多 k 满足 → `AMBIGUOUS_UNWRAP`
- 唯一 k → 本段锚点 = `P + distance`

每条 cue 的绝对时间：

```
startTicks = anchor - LOCAL + cueLocalStart
endTicks   = anchor - LOCAL + cueLocalEnd
```

## 目录结构

```
src/errors.mjs      错误码与常量（2^33、1 MiB、1..64 段）
src/parser.mjs      WebVTT 单段解析与校验
src/normalize.mjs   请求校验 + 回绕唯一展开 + 稳定排序
src/server.mjs      零依赖 HTTP 服务（/health、/api/subtitles/normalize）
scripts/smoke.mjs   API 冒烟（含跨回绕样例）
scripts/verify.mjs  健康等待 + 代码测试 + 构建检查 + 冒烟，退出码汇总
test/               node:test 测试（解析、归一化、HTTP）
Dockerfile          node:22-alpine，非 root，内置 HEALTHCHECK
docker-compose.yml  app（APP_PORT 可配）+ 一次性 verify（depends_on: healthy）
```
