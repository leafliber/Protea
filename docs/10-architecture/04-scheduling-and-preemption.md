# 调度与抢占

> 状态：Draft · 更新：2026-11-03 · 决策：[ADR-0004](../20-decisions/ADR-0004-priority-levels-and-delivery-modes.md)

## 1. 调度器要回答的四个问题

1. **何时**把 pending 事件组成一批交给主会话？（批窗口）
2. 主会话正忙时，新来的事件是**等**还是**抢**？（抢占矩阵）
3. 低等级事件会不会**饿死**？（老化）
4. 模型容量与钱**不够**时先砍谁？（预算与 Fork 调度）

调度器只看 `level`、`trigger`、`cursor`、时间与会话状态；不看事件内容（P1）。

> **实现状态（M0）**：已实现批窗口、flush、piggyback、store、空闲与回合边界投递、门禁降级。`preempt` / `interrupt` 暂按 `flush` 处理（首次出现时记一条日志）；抢占矩阵、老化、预算与 Fork 调度在 M1 实现。

## 2. 批窗口（debounce）

每个等级一个窗口定时器。事件进入 pending 时：

```
on event(e):
  if e.trigger == 'store': archive; return
  if e.trigger == 'piggyback': pending.add(e); return        // 不开窗口
  if e.trigger == 'debounce':
      pending.add(e)
      window[e.level] ??= timer(levels[e.level].debounceMs, closeWindow(e.level))
  else:  // flush / preempt / interrupt
      pending.add(e); closeAllWindows(); tryDeliver(e.trigger, e.level)
```

`closeWindow(level)` 把**所有**pending 事件（不只该等级）合并成一批——一批的等级 = 其中最高（数值最小）的事件等级。原因：既然要唤醒模型，顺带把积压都带上更省 token。

窗口默认值：L0 0 ms · L1 300 ms · L2 2 s · L3 30 s · L4 不开窗。

## 3. 投递时机与回合边界

```
tryDeliver(trigger, level):
  if main.phase == 'idle': deliver(batch); return
  if trigger in ('debounce','flush','piggyback'): waitForBoundary(); return
  decision = preemptionMatrix(level, main.currentBatch.level, trigger, main.phase)
  switch decision:
    case 'wait':      waitForBoundary()
    case 'preempt':   main.cancelModelCall(); deliver(merge(main.currentBatch.unfinished, batch))
    case 'interrupt': main.cancelTurn(); deliver(batch)
```

**回合边界**（新事件可进入上下文的时刻）：

- 一个回合内所有工具都返回之后、下一次模型调用之前；
- 模型调用被 `preempt` 或 `interrupt` 取消之后；
- 主会话 `idle`。

在 `model`（模型正在流式输出）和 `tools`（工具正在执行）阶段，非抢占事件只能等待。

## 4. 抢占矩阵

行：新事件（等级 N、trigger T）；列：主会话当前批等级 C 与阶段。

| 条件 | `phase=model`，无外部输出，无工具在跑 | `phase=model`，已有外部输出 | `phase=tools` |
|---|---|---|---|
| N < C，T=`preempt` | **preempt**：取消模型调用，合并后重请求 | wait | wait |
| N < C，T=`interrupt` | **interrupt** | **interrupt**（保留已外化输出） | **interrupt**（通知可中断工具；未开始的跳过） |
| N = C，T=`preempt` | wait | wait | wait |
| N = C，T=`interrupt` | **interrupt** | **interrupt** | **interrupt** |
| N > C，任意 | wait | wait | wait |

- "外部输出"指经由出口工具（如 `tg_send`）或流式输出分接（`outputTap`）已经到达外部世界的内容。只在内部流式缓冲里的 token 不算。
- `interrupt` 后，被取消回合的事件**保留在上下文**（它们已被模型看到），并追加一条 `internal` 事件：`turn cancelled: interrupted by L1 event #18240`。模型因此知道自己被打断过（P3）。
- 被取消的模型调用计入该批的回合数；`onTurnEnded` 不触发。

### 4.1 等级门禁

`preemptionMatrix` 之前先做门禁：事件的 `trigger` 必须在其等级允许的集合内（[02-event-model.md](02-event-model.md) §4）。越权请求被降级并记录。因此 **L3/L4 事件永远无法抢占**，无论插件怎么写。

### 4.2 抢占风暴防护

- 同一来源 10 秒内触发 ≥ 3 次 preempt/interrupt → 该来源进入 60 秒冷却，期间其 preempt 降级为 flush。冷却以 `internal` 事件告知模型与控制台。
- 可配置：`scheduler.preemptStorm.{count,windowMs,cooldownMs}`。

## 5. 老化（防饿死）

每个等级有 `maxWaitMs`（默认 L2 30 s · L3 5 min · L4 30 min）。pending 事件等待超过该值：

- 其 trigger 被提升为 `flush`（**等级不变**）；
- 若主会话持续忙于更高等级回合，flush 会在下一个回合边界生效。

因为 L1 回合通常很短（对话），L3/L4 的最坏等待 = L1 当前回合时长 + maxWait。老化不会让 L4 获得抢占能力（I-5）。

## 6. 预算

每个等级一个预算池，按滚动 24 小时窗口计 token 与费用（由 Provider 上报）：

| 等级 | 默认日预算（示例） | 耗尽时行为 |
|---|---|---|
| L0 | 不限 | — |
| L1 | 60% | 继续，但 `internal` 事件提醒模型"今日 L1 预算已用 90%" |
| L2 | 20% | 新 L2 事件降级为 `piggyback` |
| L3 | 15% | 新 L3 事件 `store`，并发 `internal` 通知；主人可通过控制台放行 |
| L4 | 5% | `store` |

- 预算只影响**调度**（是否投递、以何模式），不影响已在进行的回合。
- Fork 的预算记在其派生时的等级。
- 预算耗尽是 L0 `internal` 事件：模型会被告知，可以主动向主人汇报。

## 7. Fork 调度

Fork 是独立的工具循环（[05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §4），有自己的等级（默认继承派生它的批的等级，可降不可升）。

- **并发上限**：`scheduler.forks.maxConcurrent`（默认 2）。超出的 Fork 排队。
- **容量让渡**：当主会话需要开始一个等级 ≤ L1 的模型调用而 Provider 并发/速率池已满时，调度器按"等级低者先、启动晚者先"顺序对 Fork 执行：
  1. `pause`：Fork 在下一个回合边界停下并写检查点（合作式，默认）；
  2. `cancel`：若 30 秒内未到边界且 Fork 等级 ≥ L3，取消其模型调用（Fork 的工具调用不被打断），写检查点。
- **恢复**：主会话回到 `idle` 后，被暂停的 Fork 按原顺序恢复。
- Fork 之间不互相抢占。

## 8. 关停与排空

收到 SIGTERM（容器停止）或控制台"优雅重启"：

1. 记录 `internal` 事件 `daemon.stopping`（L4 `store`，只记录、不唤醒模型），并切换调度器为**排空模式**：不再开启新批，pending 事件保留在存储中。
2. 等待主会话当前回合结束（最多 `shutdown.graceMs`，默认 25 s；Docker 默认 10 s 的 `stop_grace_period` 需在部署里调大）。
3. 向 Fork 发 `pause`；超时则 `cancel` 并写检查点。
4. 通知插件 `stop`，等待其 `shutdownVerification` 快照（只读），记录到运行目录。
5. 刷新 SQLite WAL，退出。

重启后：pending 事件按游标继续投递；被暂停的 Fork 恢复；缺失工具结果的回合按 [05-sessions-and-agent-loop.md](05-sessions-and-agent-loop.md) §6 修复。

## 9. 可观测点

调度器对外暴露（[15-observability.md](15-observability.md)）：

- 指标：各等级 pending 数、批等待时长直方图、抢占次数（按来源）、老化提升次数、预算余量、Fork 暂停/取消次数。
- 事件：所有抢占、降级、老化、预算动作都写成 `internal` 事件，在控制台事件流中可见。

## 10. 示例时序：晨报被主人打断

```
07:00:00  cron.tick (L3, debounce)          → 30s 窗口
07:00:30  窗口关闭 → batch#1 (L3) → main: model → tools(rss_fetch×5) ...
07:00:41  telegram.message owner (L1, preempt)
          matrix: N=1 < C=3, phase=tools → wait
07:00:43  rss_fetch 全部返回 → 回合边界 → 投递 batch#2 (L1: 主人消息)
          （batch#1 的事件已在上下文；模型看到主人消息优先回复）
07:00:47  模型回复主人（tg_send），回合结束
07:00:47  主会话 idle → 模型可继续 batch#1 的晨报工作（人格决定），或派生 Fork 异步完成
```

若主人发送的是 "停下" 并由连接器标为 `interrupt`，则 07:00:41 时 rss_fetch 立即被取消（它们声明了 `interruptible`），返回部分回执。
