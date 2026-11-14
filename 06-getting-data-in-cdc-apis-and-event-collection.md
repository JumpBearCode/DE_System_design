# Getting data in: CDC, APIs and event collection｜数据接入：CDC、API 和 event 采集

> 原文：[DataInterview · Data Engineering System Design · Getting data in: CDC, APIs and event collection](https://www.datainterview.com/courses/data-engineering-system-design/concept-cdc)（课程第 2 部分 Building blocks 的第 2 课，原文标注阅读约 24 分钟），抓取于 2026-11-14。

译文说明：

- 段落：英文原文放在引用块里，中文紧跟其后。
- 列表：用「English｜中文」两栏表格逐条对照。多列的大表格只直接展示中文版，英文原表折叠在下方。
- 原页面的交互组件（数据源切换图、cursor 时间线图表、逐步演示、API backfill 图表、时间戳滑块）已改写成静态表格；折叠的 hint、参考答案和 strong answer 都已展开；测验用 ✅ 标出正确选项。练习的编辑器里显示的是官方 solution，这里直接作为参考答案。
- 译者自己加的内容都标了「译注」。

## 速览（译注）

- 数据来源只有四类：数据库（读 log 或定时 query）、第三方 API、客户端 event、合作方丢进 bucket 的文件。每一类丢数据的方式都不一样。
- 基于 query 的增量抽取会漏：delete、中间版本、晚提交的长 transaction、相同时间戳。修法是 cursor 取自数据本身，并且每次往回多读一个 lookback 窗口，靠 load 时按 id 去重。
- Log-based CDC（Debezium 读 Postgres slot 或 MySQL binlog）按提交顺序看到每一次变更。风险在于 connector 停着时 slot 会把 WAL 堆在数据库磁盘上，以及投递是 at-least-once。
- API 抽取受分页、延迟和 rate limit 约束：backfill 按时间切片并行，429 时退避，页面落地后再存 checkpoint。
- 客户端 event 会迟到、重复、时钟不准：按 event ID 去重，用 receivedAt - (sentAt - originalTimestamp) 校正时间。raw zone 只追加、用确定性的 key，所以任何一条路径都能安全重跑。

---

## 开篇

> Most data engineering designs start with the same sentence from the interviewer: “our orders are in Postgres, payments go through Stripe, and the app sends events from three million phones; get all of it into the lake, every hour, without losing or doubling anything.” Those are three different problems. A database can be read through its log or queried; an API is someone else’s system with its own limits; phones send data late, twice, and with wrong clocks. Each path loses data in its own way, and the ingestion layer is where most correctness bugs in a data platform begin.

大多数数据工程设计题，面试官的开场白都差不多：「订单在 Postgres 里，支付走 Stripe，app 从三百万台手机上发 event；把这些全部每小时导进 lake，一条不丢也一条不重。」这其实是三个不同的问题。数据库可以读它的 log，也可以直接 query；API 是别人的系统，有它自己的限制；手机发来的数据会迟到、会重复、时钟还不准。每条路径丢数据的方式都不一样，数据平台里大部分正确性 bug 都是从 ingestion 层开始的。

> In this lesson you’ll compare the four ways data arrives, watch an updated_at cursor miss rows on a timeline, step through log-based capture from a replication slot to the raw zone, size a backfill against an API’s rate limit, and correct a phone’s clock. Then you’ll write an incremental extract that survives late commits and clock skew, an API pager that survives crashes, and the cleaning step for client events.

这一课会比较数据进来的四种方式；在时间线上看 `updated_at` cursor 怎么漏行；一步步走过 log-based capture，从 replication slot 一直到 raw zone；按 API 的 rate limit 估算 backfill 要多久；以及校正手机时钟。然后写三段代码：一个扛得住晚提交和时钟偏差的增量抽取，一个崩溃后能续上的 API 翻页器，以及客户端 event 的清洗步骤。

---

## Four ways data arrives｜数据进来的四种方式

> A source is one of four kinds. A database you can read through its change log (log-based change data capture, CDC) or with periodic queries. A third-party API (Stripe, Salesforce, an ads platform) that you page through. Clients, apps and browsers, that push events to a collector. And files that partners drop in a bucket, which behave like a slow API. Pick a source and switch on its typical failure.

数据源只有四类：

1. 数据库：可以读它的 change log（log-based change data capture，CDC），也可以定时 query。
2. 第三方 API（Stripe、Salesforce、广告平台）：一页一页翻着拉。
3. 客户端（app 和浏览器）：把 event 推给 collector。
4. 合作方丢进 bucket 的文件：行为上像一个很慢的 API。

原文下面是一个交互图：选一个数据源，再打开它典型的故障。

### 四种数据源的路径和故障（原文为交互组件）

各数据源的数据路径：

| 数据源 | 路径 |
|---|---|
| database log | Postgres（`wal_level=logical`）→ WAL via slot → Debezium（Kafka Connect）→ changes → Kafka（每表一个 topic）→ S3 sink → Raw zone (S3)（按 offset 命名文件） |
| database query | Postgres（`orders.updated_at`）→ hourly SQL → Extractor job（cursor query）→ 每次 run 一个文件 → Raw zone (S3)（`dt=/hour=`）→ load → Warehouse（MERGE by id） |
| third-party API | Stripe API（live 模式 100 req/s）→ paged GETs → Extractor job（`starting_after`）→ JSON 页面 → Raw zone (S3)（每页一个 key）→ load → Warehouse（dedupe by id） |
| client SDK | Phones（每 20 条或 30 s flush 一次）→ batches → Collector API（校验、ack）→ produce → Kafka（events topic）→ S3 sink → Raw zone (S3)（按接收小时分区） |

正常情况和典型故障：

| 数据源 | 正常情况 | 典型故障 | 故障时发生什么 |
|---|---|---|---|
| database log | 每个已提交的 insert、update、delete 都从 write-ahead log 里按提交顺序读出来，提交后几秒到达，完全不 query 表。 | connector 停了 60 小时 | replication slot 会保留所有 connector 还没确认的 WAL segment。假设数据库每小时写 1.5 GB WAL，60 小时后 slot 在数据库自己的磁盘上压着约 90 GB。connector 回来后什么都不会丢，但磁盘写满会让数据库停摆。 |
| database query | 定时 query 读取 `updated_at` 超过上次 high-water mark 的行。简单，只要读权限，但它看到的是每一行在 query 那一刻的样子。 | job 连续失败 3 次 | 下一次成功的 run 从存下来的 cursor 开始读，一次补上三个小时。query 能看到的都不会丢；但这几个小时里被删掉的行，任何 query 都看不到。 |
| third-party API | job 用 cursor 翻 list endpoint，把原始 JSON 落进 raw zone。页面大小、rate limit、能按什么过滤、历史保留多久，都由 vendor 决定。 | 被限流（HTTP 429） | 超出限制时 Stripe 返回 429 Too Many Requests。job 用带 jitter 的指数退避等待，然后重新请求同一页；它的 checkpoint 是最后一个已落地页面的 cursor。 |
| client SDK | app 用手机时钟记录 event，分批发送。collector 先把 batch 写进 Kafka 再 ack，所以 ack 过的 event 不会丢。 | collector 返回 503 持续 20 分钟 | 手机把没发出去的 batch 存在本地并重试。collector 恢复后，20 分钟的 event 一下子涌进来，全部迟到，其中一部分还重复（ack 丢了的 batch 会带着相同的 message ID 再发一次）。 |

四种方式的对比（就是面试官想听的那张表）：

| | database log | database query | third-party API | client SDK |
|---|---|---|---|---|
| 能看到 delete | 能 | 不能（只能看到 soft delete） | 只有 vendor 提供时才能（events feed） | 不适用：event 是事实 |
| 能看到一行的每个版本 | 能，按提交顺序 | 不能，每次 poll 只看到最新的 | 只能通过 events 或 changes endpoint | 能，每个 event 就是一个事实 |
| 对数据源的负载 | 读 log，不扫表 | 每次 run 一个走索引的 range query | 占用共享的 rate limit | 手机的电量和流量 |
| 典型延迟 | 秒级 | 取决于调度：几分钟到一天 | 几分钟到一天 | 秒级，但离线手机会拖出几天的长尾 |
| 需要数据源团队提供 | logical replication、一个 slot、一个 replication 用户 | 读权限和可靠的 `updated_at` | 一个有读权限的 API key | tracking plan，以及 app 里集成 SDK |

<details>
<summary>交互组件里的英文原文</summary>

| Source | Failure | Description |
|---|---|---|
| database log | none | Every committed insert, update and delete is read from the write-ahead log in commit order, a few seconds after commit, without querying the tables. |
| database log | connector down for 60 hours | The replication slot keeps every WAL segment the connector has not confirmed. Assume the database writes 1.5 GB of WAL an hour: after 60 hours the slot holds about 90 GB on the database’s own disk. Nothing is lost when the connector comes back, but a full disk stops the database. |
| database query | none | A scheduled query reads rows whose updated_at is past the last high-water mark. Simple and needs only read access, but it sees each row as it is at query time. |
| database query | job fails 3 runs in a row | The next successful run reads from the stored cursor and catches up on three hours at once. Nothing is lost that a query can see; rows deleted in those hours were never visible to any query. |
| third-party API | none | A job pages through list endpoints with a cursor and lands the raw JSON. The vendor decides the page size, the rate limit, what can be filtered and how long history is kept. |
| third-party API | rate limited (HTTP 429) | Stripe answers 429 Too Many Requests when you exceed its limits. The job waits with exponential backoff and jitter and asks for the same page again; its checkpoint is the cursor of the last page it landed. |
| client SDK | none | The app records events with the phone’s clock and sends them in batches. The collector writes each batch to Kafka before it acknowledges, so an acknowledged event is not lost. |
| client SDK | collector returns 503 for 20 minutes | Phones keep unsent batches on disk and retry. When the collector recovers, 20 minutes of events arrive at once, some of them twice (a batch whose acknowledgement was lost is sent again with the same message IDs), and all of them late. |

| | database log | database query | third-party API | client SDK |
|---|---|---|---|---|
| Sees deletes | yes | no (only soft deletes) | only if the vendor exposes them (an events feed) | not applicable: events are facts |
| Sees every version of a row | yes, in commit order | no, only the latest per poll | only through an events or changes endpoint | yes, each event is one fact |
| Load on the source | reads the log, no table scans | an indexed range query per run | counts against shared rate limits | battery and bandwidth on the phone |
| Typical delay | seconds | the schedule: minutes to a day | minutes to a day | seconds, with a tail of days for offline phones |
| Needs from the source team | logical replication, a slot, a replication user | read access and a reliable updated_at | an API key with read scope | a tracking plan and the SDK in the app |

</details>

> The table under the diagram is the comparison an interviewer is looking for. Only the log sees deletes and every intermediate version of a row. Queries are the easiest to get approved, because they need nothing but read access, and the hardest to get exactly right. APIs put a vendor’s limits between you and the data. Client events are facts rather than rows, so there is nothing to update, but delivery is slow and repeated.

图下面那张表，就是面试官想听到的对比：

- 只有读 log 能看到 delete 和一行的每个中间版本。
- query 最容易拿到审批，因为只需要读权限；但也最难做到完全正确。
- API 在你和数据之间夹了一层 vendor 的限制。
- 客户端 event 是事实而不是行，没有 update 这回事；但投递又慢又会重复。

> Whatever the source, the first landing place is the same: a raw zone in object storage that keeps what arrived, as it arrived, append-only. It is what you replay from when a downstream bug is found, so it must never depend on a transformation being right.

不管数据源是什么，第一个落脚点都一样：object storage 里的 raw zone，按到达时的原样保存，只追加。下游发现 bug 时要从这里重放，所以它绝不能依赖任何转换逻辑是对的。

---

## Query-based extraction and what it misses｜基于 query 的抽取会漏掉什么

> The query version is a job that runs SELECT * FROM orders WHERE updated_at > :cursor every few minutes and stores the largest updated_at it saw as the next cursor. It looks complete. The figure plots ten writes to an orders table over two minutes: each bar runs from the moment the transaction stamped updated_at to the moment it committed. Polls are the dashed lines. Try the three cursor rules, the poll interval and a database clock that runs behind the extractor.

query 版本就是一个每隔几分钟跑一次 `SELECT * FROM orders WHERE updated_at > :cursor` 的 job，把看到的最大 `updated_at` 存成下一次的 cursor。看起来很完整。原文的图画了 orders 表两分钟内的 10 次写入：每根横条从 transaction 写下 `updated_at` 的那一刻，画到它提交的那一刻；虚线是每次 poll。可以切换三种 cursor 规则、poll 间隔，以及数据库时钟比 extractor 慢多少。

### cursor 会漏掉什么（原文为交互图表）

图中的写入：#1 new、#2 new、#4 paid、#3 paid、#5 new、#6 refunded、#7 paid、#8 new、#9 paid、#10 new，外加一次 delete #2。

默认参数下（每 25 秒 poll 一次，数据库时钟不慢）三种规则的读数：

| 下一次 poll 读什么 | 漏掉的 update | 漏掉的 delete | 被重复读的行 |
|---|---|---|---|
| `updated_at > last poll time`（用上次 poll 的时间） | 2 | 1 | 0 |
| `updated_at > max seen`（用看到的最大值） | 2 | 1 | 0 |
| `updated_at >= max seen - 45 s`（往回多读 45 秒） | 0 | 1 | 18 |

> Green: a version some poll copied. Red: a version no poll copied. A delete is never visible to a query, whatever the cursor.

绿色：被某次 poll 复制到的版本。红色：没有任何 poll 复制到的版本。不管 cursor 怎么设，query 永远看不到 delete。

<details>
<summary>交互组件里的英文原文</summary>

- Title: What a cursor misses — 10 writes and a delete on one table in 2 minutes
- Controls: Next poll reads (`updated_at > last poll time` / `updated_at > max seen` / `updated_at >= max seen - 45 s`); Poll every (default 25 s); Database clock behind the extractor (default 0 s)
- Axis: seconds; a bar runs from the transaction's updated_at to its commit
- Readouts: Updates missed / Deletes missed / Rows read more than once

</details>

> With the common rule, updated_at > max seen, polling every 25 seconds misses 2 of the 10 updates. Order #3 shares its timestamp (20 s) with order #4 but commits 7 seconds later, after a poll has already moved the cursor to 20; a strict > skips it forever. Order #6 belongs to a transaction that stamps updated_at at 38 s and commits at 72 s, and in Postgres now() is the transaction’s start time, so by the time it commits the cursor is at 44 and the row is behind it. Using the extractor’s own poll time as the cursor is worse: with the database clock 15 seconds behind it misses 5. Reading again from 45 seconds before the cursor catches all of them, at the cost of 18 extra row reads in two minutes, which the loader absorbs by keeping the newest version per id.

最常见的规则 `updated_at > max seen`，每 25 秒 poll 一次，会漏掉 10 次 update 中的 2 次：

- **订单 #3**：和 #4 的时间戳相同（20 s），但晚 7 秒才提交。这时某次 poll 已经把 cursor 推到 20，严格的 `>` 让它永远被跳过。
- **订单 #6**：所在 transaction 在 38 s 写下 `updated_at`，72 s 才提交。Postgres 里 `now()` 是 transaction 的开始时间，所以等它提交时 cursor 已经到了 44，这一行落在 cursor 后面。

用 extractor 自己的 poll 时间当 cursor 更糟：数据库时钟慢 15 秒时，会漏掉 5 次。从 cursor 往前 45 秒开始重读，能全部接住，代价是两分钟里多读 18 行；loader 按 id 只保留最新版本，就把这些重复吸收掉了。

> No cursor rule sees the delete of order #2: a deleted row matches no query. Query-based extraction needs soft deletes (a deleted_at column the application sets) or a periodic full comparison of keys. Kafka Connect’s JDBC source connector, a widely used query-based extractor, has the same problems and the same fixes as configuration: mode=timestamp+incrementing pairs the timestamp with a strictly increasing id, and timestamp.delay.interval.ms waits before reading recent rows so that transactions with earlier timestamps can commit.

没有哪种 cursor 规则能看到订单 #2 被删：删掉的行不会匹配任何 query。基于 query 的抽取需要 soft delete（应用写一个 `deleted_at` 列），或者定期做一次全量 key 比对。Kafka Connect 的 JDBC source connector 是用得很广的 query 型 extractor，它有同样的问题，修法也做成了配置：

- `mode=timestamp+incrementing`：时间戳再配一个严格递增的 id。
- `timestamp.delay.interval.ms`：读最近的行之前先等一会儿，让时间戳更早的 transaction 有机会提交。

### 测验 1

> An hourly job extracts SELECT * FROM payments WHERE updated_at > :max_seen. Reconciliation finds a few payments missing every week, all from large batch transactions. What is the most likely cause?

一个 hourly job 执行 `SELECT * FROM payments WHERE updated_at > :max_seen`。对账发现每周都缺几笔支付，全都来自大批量的 transaction。最可能的原因是什么？

| | English | 中文 |
|---|---|---|
| A | Kafka dropped the messages | Kafka 丢了消息 |
| B ✅ | Long transactions set updated_at when they start and commit after a later run has already moved the cursor past that time | 长 transaction 在开始时写 `updated_at`，提交时后面某次 run 已经把 cursor 推过了这个时间 |
| C | The updated_at column is not indexed | `updated_at` 列没建索引 |
| D | The extractor runs in a different time zone | extractor 跑在另一个时区 |

> Right. In Postgres now() is the transaction’s start time, so a batch that runs for minutes commits rows stamped in the past. Re-read a lookback window longer than your longest transaction and dedupe on load, or move to log-based CDC, which reads in commit order. Kafka Connect’s JDBC source has timestamp.delay.interval.ms for the same reason.

解析：Postgres 里 `now()` 是 transaction 的开始时间，所以一个跑了几分钟的批量操作，提交的行带着过去的时间戳。要么重读一个比最长 transaction 还长的 lookback 窗口、load 时去重，要么改用按提交顺序读的 log-based CDC。Kafka Connect 的 JDBC source 有 `timestamp.delay.interval.ms`，也是出于同样的原因。

### 练习：不丢行的增量抽取

> Now write the extractor. The checks drive it through polls of a simulated table, land each batch by keeping the newest version per id, and compare the result with the table.

现在来写这个 extractor。测试会让它对一张模拟表做多次 poll，每个 batch 落地时按 id 保留最新版本，最后把结果和表对比。

> Write extract(rows, cursor, lookback_s, now), one poll of an updated_at cursor. The starter filters updated_at > cursor and stores the extractor’s own clock as the next cursor. Take the cursor from the data, never move it backwards, and re-read lookback_s seconds before it; the loader keeps the newest version per id, so re-read rows are harmless.

写 `extract(rows, cursor, lookback_s, now)`，做一次基于 `updated_at` cursor 的 poll。starter 代码用 `updated_at > cursor` 过滤，并把 extractor 自己的时钟存成下一次的 cursor。正确做法：cursor 取自数据，永远不往回退，并且从 cursor 往前 `lookback_s` 秒开始重读；loader 按 id 保留最新版本，所以重读的行没有害处。

> The checks replay a transaction that commits 45 seconds after its updated_at, two rows with the same updated_at that commit on either side of a poll, a database clock 30 seconds behind the extractor, and 2,000 random writes, with a limit on how many rows you may re-read.

测试会重放：一个在 `updated_at` 之后 45 秒才提交的 transaction；两行 `updated_at` 相同、分别在某次 poll 前后提交；数据库时钟比 extractor 慢 30 秒；以及 2,000 次随机写入。重读的行数也有上限。

> Hint: Without a cursor return every row. Otherwise keep rows with updated_at >= cursor - lookback_s. The new cursor is the largest updated_at in the batch, or the old cursor if that is larger.

提示：没有 cursor 时返回所有行。否则保留 `updated_at >= cursor - lookback_s` 的行。新 cursor 是 batch 里最大的 `updated_at`；如果旧 cursor 更大，就保留旧的。

参考答案：

```python
def extract(rows, cursor, lookback_s, now):
    """One poll of: SELECT * FROM orders WHERE updated_at >= :low

    rows:       the rows visible to this poll (committed), dicts with "id",
                "updated_at" (seconds, the database's clock) and "status".
    cursor:     the high-water mark this function returned last time (None on the first poll).
    lookback_s: how many seconds before the cursor to read again.
    now:        the extractor's own clock when the poll runs.

    Return (batch, new_cursor). Rows read twice are fine: the loader keeps
    the newest version of each id."""
    if cursor is None:
        batch = list(rows)
    else:
        low = cursor - lookback_s          # re-read a window: late commits and ties land in it
        batch = [r for r in rows if r["updated_at"] >= low]
    # The cursor comes from the data (database clock), never from our own clock,
    # and it never moves backwards.
    seen = [r["updated_at"] for r in batch]
    new_cursor = max(seen + ([cursor] if cursor is not None else []), default=None)
    return batch, new_cursor
```

---

## Log-based CDC｜Log-based CDC

> A database already records every change, in order, in its log: the write-ahead log (WAL) in Postgres, the binary log in MySQL. Log-based CDC reads that log. Postgres exposes it through logical decoding and a replication slot, a named position that the server will not discard WAL past; Debezium’s Postgres connector requires wal_level=logical and can use pgoutput, the decoding plugin built into Postgres 10 and later (set plugin.name=pgoutput; the default, decoderbufs, has to be installed on the server). MySQL needs binlog_format=ROW and binlog_row_image=FULL. Step through a connector’s life, including a long weekend when it is switched off.

数据库本来就在 log 里按顺序记录了每一次变更：Postgres 的 write-ahead log（WAL），MySQL 的 binary log。Log-based CDC 读的就是这个 log。

- **Postgres**：通过 logical decoding 和 replication slot 暴露 log。slot 是一个有名字的位置，server 不会丢弃这个位置之后的 WAL。Debezium 的 Postgres connector 要求 `wal_level=logical`，可以用 Postgres 10 及以后内置的 decoding plugin `pgoutput`（设 `plugin.name=pgoutput`；默认的 `decoderbufs` 需要在 server 上另装）。
- **MySQL**：需要 `binlog_format=ROW` 和 `binlog_row_image=FULL`。

下面一步步走过一个 connector 的生命周期，包括它被关掉的一个长周末。

### 从 slot 到 raw zone 的 log-based capture（原文为逐步演示）

演示里的组件：Postgres、Debezium、Kafka、S3。每一步列出四块状态：Postgres（表、WAL 位置、slot）、topic partition 0、raw zone 里的对象、读者看到的数据。

**Step 1｜首次启动**

Postgres：orders 3 行 · WAL 在 LSN 1000 · slot：无 · topic：空 · raw zone：空 · 读者看到：还没有数据

> Postgres runs with wal_level=logical. A Debezium connector with snapshot.mode=initial (the default) starts for the first time on the orders table.

Postgres 以 `wal_level=logical` 运行。一个 `snapshot.mode=initial`（默认值）的 Debezium connector 第一次在 orders 表上启动。

**Step 2｜创建 slot**

slot：debezium @ 1000 · 其余不变

> It creates a logical replication slot at LSN 1000. From now on Postgres keeps all WAL after the slot’s confirmed position, even while the connector is away.

connector 在 LSN 1000 建了一个 logical replication slot。从现在起，Postgres 会保留 slot 已确认位置之后的所有 WAL，即使 connector 不在线也一样。

**Step 3｜初始 snapshot**

topic：offset 0 `r #1`、1 `r #2`、2 `r #3` · 读者看到：#1 #2 #3

> The initial snapshot reads the table as of LSN 1000 and emits one read event (op: r) per row to the topic shop.public.orders (Debezium names topics topic.prefix.schema.table).

初始 snapshot 按 LSN 1000 时刻读整张表，每一行往 topic `shop.public.orders` 发一个 read event（`op: r`）。Debezium 的 topic 命名规则是 `topic.prefix.schema.table`。

**Step 4｜开始 streaming**

WAL 在 LSN 1003 · slot：debezium @ 1003 · topic 新增：3 `u #2`、4 `c #4`、5 `d #1`、6 `#1 tombstone` · 读者看到：#2 #3 #4

> Streaming starts at LSN 1000: an update, an insert and a delete become offsets 3 to 6 (a delete is followed by a tombstone by default). Snapshot and stream meet at one log position, so nothing is missed or read twice.

streaming 从 LSN 1000 开始：一次 update、一次 insert、一次 delete 变成 offset 3 到 6（默认情况下 delete 后面跟一个 tombstone）。snapshot 和 stream 在同一个 log 位置衔接，所以既不会漏，也不会读两次。

**Step 5｜S3 sink 落地**

raw zone：`orders+0+0000000000`（offset 0 到 6）

> An S3 sink connector writes the partition to topics/shop.public.orders/partition=0/shop.public.orders+0+0000000000.json. The name encodes topic, partition and start offset, so writing the same records again produces the same object: Confluent documents exactly-once output for deterministic partitioners.

S3 sink connector 把这个 partition 写到 `topics/shop.public.orders/partition=0/shop.public.orders+0+0000000000.json`。文件名里编码了 topic、partition 和起始 offset，所以同样的记录再写一遍会得到同一个对象。Confluent 的文档写明，用确定性的 partitioner 时输出是 exactly-once 的。

**Step 6｜connector 停了一个周末**

WAL 在 LSN 9800 · slot 仍停在 debezium @ 1003 · 读者看到：#2 #3 #4（从周五起就是旧数据）

> Friday 18:00 the Connect cluster is shut down for maintenance and stays down. Assume 1.5 GB of WAL an hour: by Monday 06:00, 60 hours later, the slot pins about 90 GB of WAL on the database volume. max_slot_wal_keep_size (Postgres 13 and later, unlimited by default) caps this; past the cap the slot is invalidated and you need a new snapshot.

周五 18:00，Connect 集群因维护关掉，之后一直没开。假设每小时 1.5 GB WAL：到周一 06:00，60 小时后，slot 在数据库磁盘上压着约 90 GB WAL。`max_slot_wal_keep_size`（Postgres 13 及以后，默认不限）可以设上限；超过上限 slot 会失效，就得重新做 snapshot。

**Step 7｜重启追赶**

slot：debezium @ 9800 · topic 新增：7 `u #3`、8 `u #3 (again)`… · raw zone 新增：`orders+0+0000000007`

> On restart the connector resumes from its stored offset and catches up. If it crashed after sending events but before its offset was committed, it sends some again: Debezium documents at-least-once delivery in failures. Raw files may hold a change twice; the load into tables dedupes by key and log position.

重启后 connector 从存下的 offset 继续，追上进度。如果它是在发出 event 之后、提交 offset 之前崩的，就会把一部分 event 再发一次：Debezium 文档写明故障时是 at-least-once 投递。raw 文件里同一个变更可能出现两次；load 进表时按 key 和 log 位置去重。

> Three design points come out of the walk-through. The snapshot and the stream meet at one log position, so a new table is copied once and then followed without gaps. The slot moves the risk from data loss to disk: a stopped connector costs WAL on the database server, about 90 GB over a 60-hour weekend at an assumed 1.5 GB an hour, and the database team needs an alert on retained WAL per slot. And delivery is at least once, so the raw zone may hold a change twice; that is fine as long as the load into tables applies changes by primary key and log position.

这个流程里有三个设计要点：

| English | 中文 |
|---|---|
| The snapshot and the stream meet at one log position, so a new table is copied once and then followed without gaps. | snapshot 和 stream 在同一个 log 位置衔接，所以新表只复制一次，之后无缝跟上。 |
| The slot moves the risk from data loss to disk: a stopped connector costs WAL on the database server, about 90 GB over a 60-hour weekend at an assumed 1.5 GB an hour, and the database team needs an alert on retained WAL per slot. | slot 把风险从丢数据变成了磁盘：connector 停着，WAL 就堆在数据库 server 上，按每小时 1.5 GB 算，60 小时的周末约 90 GB。数据库团队需要按 slot 对保留的 WAL 量设告警。 |
| Delivery is at least once, so the raw zone may hold a change twice; that is fine as long as the load into tables applies changes by primary key and log position. | 投递是 at-least-once，raw zone 里同一个变更可能有两份；只要 load 进表时按主键和 log 位置应用变更，就没问题。 |

> When a table must be copied again (a new table, a slot that was invalidated, a bug in a consumer), Debezium can run an incremental snapshot triggered by a signal: it reads the table in chunks of incremental.snapshot.chunk.size rows (1,024 by default) while streaming continues, instead of pausing the stream for a full copy. The streaming course’s change data capture lesson covers the event format, ordering by key and compaction in depth.

当一张表需要重新复制时（新加的表、slot 失效、consumer 有 bug），Debezium 可以通过 signal 触发 incremental snapshot：按 `incremental.snapshot.chunk.size` 行（默认 1,024）一块一块地读表，同时 streaming 继续进行，而不是暂停 stream 做全量复制。streaming 课程里 change data capture 那一课会深入讲 event 格式、按 key 排序和 compaction。

### 测验 2

> The data team pauses a Debezium Postgres connector for a 3-day migration. What should they tell the database team first?

数据团队要为一次迁移把 Debezium Postgres connector 暂停 3 天。他们应该先告诉数据库团队什么？

| | English | 中文 |
|---|---|---|
| A ✅ | The replication slot will keep all WAL written in those 3 days on the database disk, unless they drop the slot or cap it with max_slot_wal_keep_size | replication slot 会把这 3 天写的所有 WAL 留在数据库磁盘上，除非 drop 掉 slot 或者用 `max_slot_wal_keep_size` 设上限 |
| B | Kafka will run out of disk | Kafka 磁盘会满 |
| C | The tables will be locked until the connector is back | connector 回来之前表会被锁住 |
| D | Nothing: changes made during the pause are lost and a full reload will fix it | 不用说什么：暂停期间的变更会丢，之后全量重载就行 |

> Right. A slot guarantees the WAL a consumer still needs is kept. Size it (WAL per hour times hours) against free disk. Dropping or invalidating the slot avoids that, but the connector then needs a new snapshot; Debezium can run it as an incremental snapshot in chunks (1,024 rows by default) while streaming continues.

解析：slot 保证 consumer 还需要的 WAL 都被保留。用「每小时 WAL 量 × 小时数」去和剩余磁盘比一比。drop 掉 slot 或让它失效能避免这个问题，但之后 connector 需要重新做 snapshot；Debezium 可以把它做成 incremental snapshot，按块读（默认 1,024 行），同时 streaming 不停。

---

## Third-party APIs｜第三方 API

> An API pull has the same shape as a query, with three new constraints from the vendor. Pagination: Stripe’s list endpoints return at most 100 objects per call (limit is 1 to 100, default 10), newest first, and the next page is requested with starting_after set to the last ID you received. Rate limits: Stripe documents 100 requests per second per account in live mode, 25 per second for most individual endpoints, a concurrency limit, and 429 Too Many Requests when you exceed them; the limits are shared with the company’s own checkout traffic. History and changes: what you can filter on and how far back you can go is the vendor’s choice.

API 抽取和 query 是一个形状，只是 vendor 多加了三条约束：

| English | 中文 |
|---|---|
| Pagination: Stripe’s list endpoints return at most 100 objects per call (limit is 1 to 100, default 10), newest first, and the next page is requested with starting_after set to the last ID you received. | **分页**：Stripe 的 list endpoint 每次最多返回 100 个对象（`limit` 取 1 到 100，默认 10），最新的在前；下一页要把 `starting_after` 设成上一页最后一个 ID 来请求。 |
| Rate limits: Stripe documents 100 requests per second per account in live mode, 25 per second for most individual endpoints, a concurrency limit, and 429 Too Many Requests when you exceed them; the limits are shared with the company’s own checkout traffic. | **Rate limit**：Stripe 文档写的是 live 模式下每个账号每秒 100 个请求，大部分单个 endpoint 每秒 25 个，另外还有并发上限；超了返回 429 Too Many Requests。这些额度和公司自己的结账流量是共用的。 |
| History and changes: what you can filter on and how far back you can go is the vendor’s choice. | **历史和变更**：能按什么过滤、最多能往回拉多久，都由 vendor 决定。 |

> A cursor chain is sequential, because each request needs the last ID of the previous page. A backfill is therefore bound by latency long before it reaches the rate limit. Split the history into time slices with the created filter and page through the slices in parallel.

cursor 链是串行的，因为每个请求都要用上一页的最后一个 ID。所以 backfill 在碰到 rate limit 之前，早就被延迟卡住了。办法是用 `created` filter 把历史切成若干时间片，各个时间片并行翻页。

### 从有 rate limit 的 API 做 backfill（原文为交互图表）

Stripe 风格的 list endpoint；延迟是假设值。默认参数：要 backfill 12 M 个对象，page size（`limit`）100，单次 list 调用延迟 400 ms，4 个并行时间片，自己允许的请求速率 20/s。

不同并行时间片数对应的耗时（图中柱状图）：

| 并行时间片 | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| 耗时（小时） | 13 | 6.7 | 3.3 | 1.7 | 1.7 |

默认参数下的读数：

| 指标 | 值 |
|---|---|
| List 请求数 | 120,000 |
| 单条 cursor 链的速率 | 2.5 req/s |
| 实际达到的速率 | 10.0 req/s |
| 总耗时（wall-clock） | 3.3 h |

> requests = objects / page size; a chain waits for each page before asking for the next (it needs the last ID), so it runs at 1 / latency; slices filtered by created run in parallel up to the rate you allow. Stripe’s documented defaults: 100 requests per second per account in live mode, 25 per endpoint unless noted, a limit of 1 to 100 per page.

请求数 = 对象数 / page size；一条链要等上一页回来才能请求下一页（它需要最后一个 ID），所以速率是 1 / 延迟；按 `created` 过滤的时间片可以并行，直到达到你允许的速率。Stripe 文档里的默认值：live 模式每账号每秒 100 个请求，没有特别说明的 endpoint 每秒 25 个，每页 `limit` 取 1 到 100。

<details>
<summary>交互组件里的英文原文</summary>

- Title: Backfilling from a rate-limited API — Stripe-style list endpoint; latency is an assumption
- Sliders: Objects to backfill (12 M) · Page size (limit) (100) · Latency of one list call (400 ms) · Parallel time slices (4) · Request rate you allow yourself (20/s)
- Chart: hours, by parallel slices — 1: 13 · 2: 6.7 · 4: 3.3 · 8: 1.7 · 16: 1.7
- Readouts: List requests 120,000 · One cursor chain 2.5 req/s · Rate achieved 10.0 req/s · Wall-clock time 3.3 h

</details>

> Backfilling 12 million charges takes 120,000 requests. One chain at an assumed 400 ms per call runs at 2.5 requests per second and needs 13.3 hours; four slices take 3.3 hours; eight slices reach the 20 requests per second you allowed yourself and take 1.7 hours, and more slices change nothing. Leaving most of the account’s 100 requests per second to production is a choice you state in the interview. Stripe also caps read requests at an average of 500 per transaction over 30 days, which a one-off backfill rarely reaches but a job that re-reads everything daily can.

backfill 1,200 万笔 charge 需要 120,000 个请求：

- 一条链，假设每次调用 400 ms，速率 2.5 req/s，要 13.3 小时。
- 4 个时间片，3.3 小时。
- 8 个时间片达到你给自己定的 20 req/s，1.7 小时；再加时间片也没用了。

把账号 100 req/s 的大部分额度留给生产流量，是你在面试里要明确说出来的取舍。Stripe 还限制 30 天内读请求平均每笔交易不超过 500 次；一次性 backfill 很少碰到，但每天把所有数据重读一遍的 job 有可能碰到。

> Two habits make API pulls safe to rerun. Save a checkpoint (the last cursor) only after the page it came from has landed, so a crash repeats at most one page. And land each page under a key derived from the request (the cursor it was fetched with), so a repeated page overwrites the same object. For incremental runs, query from the last run’s high-water mark minus an overlap and dedupe on the object ID, and reconcile daily totals with the vendor’s own reports, because an API that silently returns partial data is common.

两个习惯让 API 抽取可以安全重跑：

1. 页面落地之后才保存 checkpoint（最后一个 cursor），这样崩溃最多重复一页。
2. 每一页用从请求推出来的 key 落地（也就是抓这一页用的 cursor），这样重复的页面会覆盖同一个对象。

增量 run 时，从上次 run 的 high-water mark 往回留一段重叠开始查，按对象 ID 去重；每天再拿总数和 vendor 自己的报表对账，因为 API 悄悄只返回部分数据的情况很常见。

### 练习：翻页拉 API，并且扛得住崩溃

> Write pull_all(api, state, sink) for a Stripe-style list endpoint: newest first, limit 1 to 100, starting_after set to the last ID of the previous page, has_more false on the last page. The starter ignores rate limits and starts from the top after a crash. Back off on RateLimited and retry the same page, keep a checkpoint in state, and land each page under a key that a rerun of the same request would overwrite.

为 Stripe 风格的 list endpoint 写 `pull_all(api, state, sink)`：最新的在前，`limit` 取 1 到 100，`starting_after` 设成上一页最后一个 ID，最后一页 `has_more` 为 false。starter 代码不管 rate limit，崩溃后从头开始。要求：遇到 `RateLimited` 时退避并重试同一页；在 `state` 里保存 checkpoint；每一页用一个「同样的请求重跑时会被覆盖」的 key 落地。

> The checks page through 2,350 objects, inject a 429 every 4 calls, kill the worker after 7 pages, and crash between landing a page and saving the checkpoint.

测试会翻 2,350 个对象，每 4 次调用注入一次 429，在第 7 页后杀掉 worker，还会在「页面已落地、checkpoint 还没存」之间制造一次崩溃。

> Hint: Loop until state["done"]. Read the cursor from state, call the API, and on RateLimited call api.sleep(e.retry_after) and continue. Write sink[f"after={cursor}"], then save the new cursor (or done) in state.

提示：循环直到 `state["done"]`。从 `state` 读 cursor，调 API；遇到 `RateLimited` 就 `api.sleep(e.retry_after)` 然后 `continue`。先写 `sink[f"after={cursor}"]`，再把新 cursor（或 done）存进 `state`。

参考答案：

```python
class RateLimited(Exception):
    def __init__(self, retry_after):
        self.retry_after = retry_after


def pull_all(api, state, sink):
    """Copy every object from a Stripe-style list endpoint into sink.

    api.list(limit=..., starting_after=...) returns {"data": [...], "has_more": bool},
      newest first; limit must be 1 to 100. It raises RateLimited(retry_after) on a 429:
      wait with api.sleep(seconds) and try again.
    state: a dict that survives crashes. Keep your checkpoint in it.
    sink:  a dict {key: list of objects}, the raw zone. Writing a key again replaces it.
    The job can crash at any line; then it is called again with the same state and sink."""
    while not state.get("done"):
        cursor = state.get("cursor")              # resume where the last run stopped
        try:
            resp = api.list(limit=100, starting_after=cursor)
        except RateLimited as e:
            api.sleep(e.retry_after)              # back off, then ask for the same page
            continue
        # Key the page by the request that produced it: a crash before the checkpoint
        # below makes the next run fetch and write the same key, replacing, not adding.
        sink[f"after={cursor or 'start'}"] = resp["data"]
        if resp["has_more"]:
            state["cursor"] = resp["data"][-1]["id"]
        else:
            state["done"] = True
```

---

## Client events｜客户端 event

> Apps and browsers batch events and send them to a collector. Segment’s iOS and Android libraries flush every 20 events or every 30 seconds by default, and a phone that is offline keeps its queue and sends it later. Three things follow. Events arrive late, sometimes days late. They arrive twice, because a batch whose acknowledgement was lost is sent again; every event carries a unique ID (Segment’s messageId) so the pipeline can drop repeats. And they carry the phone’s clock, which can be wrong by hours.

app 和浏览器把 event 攒成 batch 发给 collector。Segment 的 iOS 和 Android 库默认每 20 个 event 或每 30 秒 flush 一次；手机离线时会保留队列，之后再发。由此带来三件事：

| English | 中文 |
|---|---|
| Events arrive late, sometimes days late. | event 会迟到，有时晚好几天。 |
| They arrive twice, because a batch whose acknowledgement was lost is sent again; every event carries a unique ID (Segment’s messageId) so the pipeline can drop repeats. | event 会重复，因为 ack 丢了的 batch 会再发一次；每个 event 带一个唯一 ID（Segment 里叫 `messageId`），pipeline 靠它丢掉重复。 |
| And they carry the phone’s clock, which can be wrong by hours. | event 带的是手机时钟，可能差好几个小时。 |

> The clock can be corrected because each batch carries two times from the same wrong clock. Segment records originalTimestamp (phone clock at the event), sentAt (phone clock at upload) and receivedAt (server clock), and computes timestamp = receivedAt - (sentAt - originalTimestamp): sending and receiving happen within a few hundred milliseconds, so their difference is the phone’s clock error. Move the sliders.

时钟之所以能校正，是因为每个 batch 带着两个来自同一个错误时钟的时间。Segment 记录三个时间：

- `originalTimestamp`：event 发生时的手机时钟
- `sentAt`：上传时的手机时钟
- `receivedAt`：server 时钟

然后算 `timestamp = receivedAt - (sentAt - originalTimestamp)`。发送和接收只差几百毫秒，所以 `sentAt` 和 `receivedAt` 的差就是手机时钟的误差。

### 一次点击的四个时间戳（原文为交互组件）

真实时间：2026-10-11 22:40 UTC 的一次点击。默认参数：手机时钟误差 +120 min，上传前离线 30 h，离线期间时钟没有被网络校正。

| 字段 | 来源 | UTC | 日期 |
|---|---|---|---|
| `originalTimestamp` | 点击时的手机时钟 | 10-12 00:40 | 2026-10-12 |
| `sentAt` | 上传时的手机时钟 | 10-13 06:40 | 2026-10-13 |
| `receivedAt` | server 时钟 | 10-13 04:40 | 2026-10-13 |
| `timestamp` | `receivedAt - (sentAt - originalTimestamp)` | 10-11 22:40 | 2026-10-11 |

读数：按 `receivedAt` 算是 Oct 13；按校正后的时间算是 Oct 11；`timestamp` 里剩下的误差 0 min。

<details>
<summary>交互组件里的英文原文</summary>

- Title: Four timestamps of one tap — tap at 2026-10-11 22:40 UTC (true time)
- Controls: Phone clock error (+120 min) · Offline before upload (30 h) · Clock corrected while offline (no / yes, by the network)

| field | source | UTC | date |
|---|---|---|---|
| originalTimestamp | phone clock at the tap | 10-12 00:40 | 2026-10-12 |
| sentAt | phone clock at upload | 10-13 06:40 | 2026-10-13 |
| receivedAt | server clock | 10-13 04:40 | 2026-10-13 |
| timestamp | receivedAt - (sentAt - originalTimestamp) | 10-11 22:40 | 2026-10-11 |

- Readouts: Day by receivedAt Oct 13 · Day by corrected time Oct 11 · Error left in timestamp 0 min

</details>

> With a phone 2 hours fast, the 22:40 tap on Oct 11 carries an originalTimestamp on Oct 12, and after 30 hours offline it is received on Oct 13. Only the corrected timestamp puts it on Oct 11. The correction assumes the error did not change between the tap and the upload; if the network fixed the clock while the phone was offline, the error stays in the result, which is why analyses that need exact times use server-side events where they can.

手机快 2 小时，Oct 11 22:40 的点击带着 Oct 12 的 `originalTimestamp`；离线 30 小时后，Oct 13 才被收到。只有校正后的 `timestamp` 把它放回 Oct 11。这个校正假设误差在点击和上传之间没有变；如果手机离线期间网络把时钟校正了，误差就会留在结果里。所以需要精确时间的分析，能用 server-side event 就用 server-side event。

### 测验 3

> A mobile app's daily active users for yesterday rise by 3% when the job is rerun this afternoon. The SQL did not change. Why?

今天下午重跑 job 后，昨天的移动端 DAU 涨了 3%。SQL 没改。为什么？

| | English | 中文 |
|---|---|---|
| A ✅ | Offline phones uploaded events for yesterday after the first run, and the table is partitioned by event date | 离线的手机在第一次 run 之后才上传了昨天的 event，而表是按 event 日期分区的 |
| B | Duplicate events from retried uploads | 重试上传带来的重复 event |
| C | Clock skew moved events into yesterday | 时钟偏差把 event 挪进了昨天 |
| D | The warehouse cached the first result | warehouse 缓存了第一次的结果 |

> Right. Client events arrive late: a phone in airplane mode uploads hours or days later, with its original event time. Either rerun recent dates on a lookback window and say that numbers settle after N days, or partition by arrival and report by event time with a stated cut-off.

解析：客户端 event 会迟到：开着飞行模式的手机几小时甚至几天后才上传，带着原始的 event 时间。两种处理：要么在一个 lookback 窗口里重跑最近几天，并说明数字要 N 天后才稳定；要么按到达时间分区、按 event 时间出报表，并明确一个截止时间。

### 练习：清洗一天的客户端 event

> Write clean(batches), the first step after the raw zone for mobile events. The starter keeps every event and trusts the phone’s clock. Drop repeated messageIds, correct each event’s time with Segment’s formula receivedAt - (sentAt - originalTimestamp), keep originalTimestamp when a server-side library sends no sentAt, and derive event_date in UTC.

写 `clean(batches)`，这是移动端 event 出了 raw zone 之后的第一步。starter 代码保留所有 event、相信手机时钟。要求：

- 丢掉重复的 `messageId`；
- 用 Segment 的公式 `receivedAt - (sentAt - originalTimestamp)` 校正每个 event 的时间；
- server-side 库不发 `sentAt` 时，保留 `originalTimestamp`；
- 按 UTC 推出 `event_date`。

> The checks replay a batch uploaded twice, a phone 2 hours fast whose 23:30 tap must stay on its day, an upload 3 days late, a server-side event, and 40 phones with skewed clocks and retries.

测试会重放：一个被上传两次的 batch；一台快 2 小时的手机，它 23:30 的点击必须留在当天；一次晚了 3 天的上传；一个 server-side event；以及 40 台时钟有偏差、还会重试的手机。

> Hint: The clock error of a batch is sentAt - receivedAt (0 when sentAt is None); subtract it from each event’s originalTimestamp. Keep a set of the messageIds already emitted.

提示：一个 batch 的时钟误差是 `sentAt - receivedAt`（`sentAt` 为 None 时是 0），从每个 event 的 `originalTimestamp` 里减掉它。用一个 set 记下已经输出过的 `messageId`。

参考答案：

```python
from datetime import datetime, timezone

def clean(batches):
    """batches: what the collector received, in arrival order. Each batch is
    {"receivedAt": t, "sentAt": t, "events": [{"messageId", "originalTimestamp", "event"}]},
    times in epoch seconds; sentAt and originalTimestamp come from the phone's clock,
    receivedAt from the server's. sentAt is None for server-side libraries.

    Return a list of rows {"messageId", "event", "timestamp", "event_date"}: one row per
    messageId, timestamp corrected for the device clock, event_date = its UTC date (YYYY-MM-DD)."""
    rows, seen = [], set()
    for b in batches:
        # sentAt (phone clock) and receivedAt (server clock) are a few hundred ms apart,
        # so their difference is the phone's clock error. Segment's formula:
        # timestamp = receivedAt - (sentAt - originalTimestamp)
        skew = 0 if b["sentAt"] is None else b["sentAt"] - b["receivedAt"]
        for e in b["events"]:
            if e["messageId"] in seen:          # a retried upload: same messageId again
                continue
            seen.add(e["messageId"])
            ts = e["originalTimestamp"] - skew
            rows.append({"messageId": e["messageId"], "event": e["event"], "timestamp": ts,
                         "event_date": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")})
    return rows
```

---

## Idempotent landing in the raw zone｜幂等地落进 raw zone

> Every path above can deliver the same data twice: a scheduler retries a task, a connector re-sends after a crash, a phone re-uploads. The raw zone should not care. Name objects so that the same input produces the same key, then a rerun overwrites instead of adding: raw/orders/dt=2026-10-12/hour=09/part-0000.jsonl for an hourly extract, topic, partition and start offset for a Kafka sink, the request cursor for an API page. Random names (a UUID per write) are safe from collisions and are exactly what turns a retry into duplicates. S3 is strongly consistent for reads and listings after a write, so a reader that lists a prefix sees the object a writer just replaced.

上面每条路径都可能把同样的数据送来两次：scheduler 重试 task，connector 崩溃后重发，手机重新上传。raw zone 不应该在乎这些。给对象命名时，让同样的输入得到同样的 key，这样重跑就是覆盖而不是追加：

- hourly 抽取：`raw/orders/dt=2026-10-12/hour=09/part-0000.jsonl`
- Kafka sink：topic、partition 和起始 offset
- API 页面：请求用的 cursor

随机命名（每次写一个 UUID）确实不会撞名，但正是它把重试变成了重复数据。S3 写入之后的读和 list 都是强一致的，所以读者 list 一个 prefix 时，能看到写入方刚刚替换的那个对象。

> Where keys cannot be deterministic (events from millions of phones), keep the duplicates in raw and remove them in the first transformation, on the event’s own ID. Run the same hourly load twice with both naming schemes.

key 没法做成确定性的地方（几百万台手机发来的 event），就让重复留在 raw 里，在第一次转换时按 event 自己的 ID 去掉。下面用两种命名方式把同一个小时的 load 跑两次。

### 同一个小时落地两次（原文为可运行的 playground）

<details>
<summary>Playground 代码（object store 用一个 dict 模拟）</summary>

```python
# An object store is a dict {key: content}. A loader lands each extract under a key.
# Run the same hourly load twice (a retry) and compare two ways of naming the files.
import json, uuid

def extract(hour):
    # the rows a source returns for one hour; the same every time we ask
    return [{"id": i, "amount": 10 * i, "hour": hour} for i in range(1, 4)]

def land_random(store, source, hour, rows):
    key = f"raw/{source}/dt=2026-10-12/hour={hour:02d}/{uuid.uuid4().hex}.jsonl"
    store[key] = "\n".join(json.dumps(r) for r in rows)

def land_deterministic(store, source, hour, rows):
    # one key per (source, interval): a rerun writes the same object again
    key = f"raw/{source}/dt=2026-10-12/hour={hour:02d}/part-0000.jsonl"
    store[key] = "\n".join(json.dumps(r) for r in rows)

for land in (land_random, land_deterministic):
    store = {}
    land(store, "orders", 9, extract(9))
    land(store, "orders", 9, extract(9))      # the scheduler retried hour 9
    land(store, "orders", 10, extract(10))
    rows = [json.loads(line) for content in store.values() for line in content.split("\n")]
    print(f"{land.__name__}: {len(store)} objects, {len(rows)} rows, revenue {sum(r['amount'] for r in rows)}")
    for key in sorted(store):
        print("   ", key)

# Try: a source that returns one more row on the retry (a late commit). Which naming
# still gives the right answer, and what does the other one need downstream?
```

</details>

> Random names leave 3 objects, 9 rows and revenue 180 after the retry. Deterministic names leave 2 objects, 6 rows and 120, which is 60 per hour as it should be. The idempotency lesson later in this module applies the same idea to every table a pipeline writes.

重试之后：

| 命名方式 | 对象数 | 行数 | revenue |
|---|---|---|---|
| 随机命名（`land_random`） | 3 | 9 | 180 |
| 确定性命名（`land_deterministic`） | 2 | 6 | 120（每小时 60，本该如此） |

这个模块后面讲幂等的那一课，会把同样的思路用到 pipeline 写的每一张表上。

---

## How this comes up in interviews｜实际面试中是什么样

> Ingestion comes up in almost every data design prompt, usually as “how does the data get in?” after the high-level diagram. A complete answer names the mechanism per source and why (log-based CDC for operational databases you own, cursor pulls with overlap for APIs, an SDK and collector for clients), then the failure of each and its fix: slot lag and WAL retention, late commits and deletes for cursors, rate limits and crash recovery for APIs, duplicates, late uploads and clock skew for clients. Follow-ups to expect: “what if the connector is down for a day?”, “how do you backfill two years from the API?” (slices, rate, hours, and the checkpoint), “how do you know nothing was lost?” (counts or sums reconciled against the source per day), and “the source team will not enable logical replication” (query-based extraction with soft deletes, and the gaps you accept).

几乎每道数据设计题都会碰到 ingestion，通常是画完高层架构图后被问「数据怎么进来？」。一个完整的回答包括：

1. 每个数据源用什么机制、为什么：自己的业务数据库用 log-based CDC，API 用带重叠的 cursor 拉取，客户端用 SDK 加 collector。
2. 每种机制的故障和修法：
   - CDC：slot lag 和 WAL 保留；
   - cursor：晚提交和 delete；
   - API：rate limit 和崩溃恢复；
   - 客户端：重复、迟到上传和时钟偏差。

要准备的追问：

| 追问 | 要答到的点 |
|---|---|
| 「connector 挂了一天怎么办？」 | （原文未展开，对应 slot 保留 WAL、磁盘告警、`max_slot_wal_keep_size`） |
| 「怎么从 API backfill 两年的数据？」 | 时间切片、速率、要几个小时、checkpoint |
| 「你怎么知道什么都没丢？」 | 每天按 count 或 sum 和数据源对账 |
| 「数据源团队不肯开 logical replication」 | 基于 query 的抽取加 soft delete，并说明你接受了哪些缺口 |

译注：上表第一行「要答到的点」是译者根据正文补的，原文只列了问题。

### 面试题：把一个 marketplace 的数据导进 lake

> A marketplace runs 60 tables in one Postgres cluster, takes payments through Stripe and has 3 million daily users on its apps. Analysts want all three sources in the lake with data no older than one hour. Describe how each source is ingested, what lands in the raw zone, and what happens when each path fails.

一个 marketplace 在一个 Postgres 集群里有 60 张表，支付走 Stripe，app 日活 300 万。分析师希望三个数据源都进 lake，数据不超过一小时。说明每个数据源怎么接入、raw zone 里落的是什么、每条路径出故障时会怎样。

**参考答案（strong answer）**

| English | 中文 |
|---|---|
| Postgres: Debezium with pgoutput, one slot for the cluster, one topic per table. Initial snapshot, then streaming; an S3 sink lands files named by topic, partition and offset. Alert when the slot retains more than a few GB of WAL, and agree a max_slot_wal_keep_size with the database team. | **Postgres**：Debezium 用 `pgoutput`，整个集群一个 slot，每张表一个 topic。先做初始 snapshot，然后 streaming；S3 sink 落地的文件按 topic、partition 和 offset 命名。slot 保留的 WAL 超过几 GB 就告警，并和数据库团队商定一个 `max_slot_wal_keep_size`。 |
| Stripe: a job every 30 minutes pages /v1/charges, refunds and payouts with starting_after, filtered by created since the last run minus an overlap, at a rate well under the account’s 100 requests per second so checkout traffic is not throttled. Each page lands under a key derived from its request; the checkpoint is saved after the write. Daily totals are reconciled against Stripe’s balance reports. | **Stripe**：每 30 分钟一个 job，用 `starting_after` 翻 `/v1/charges`、refunds 和 payouts，按 `created` 过滤（从上次 run 往回留一段重叠），速率远低于账号的 100 req/s，避免把结账流量限流。每一页用从请求推出来的 key 落地；写完之后才存 checkpoint。每天的总数和 Stripe 的 balance 报表对账。 |
| App events: SDKs batch (Segment’s mobile defaults: 20 events or 30 seconds), the collector validates, writes to Kafka with acks=all, then returns 200. Raw files are partitioned by receive hour; the cleaned table is partitioned by corrected event date and rebuilt for the last 3 days each run to absorb late uploads. | **App event**：SDK 攒 batch（Segment 移动端默认 20 个 event 或 30 秒），collector 校验后用 `acks=all` 写进 Kafka，再返回 200。raw 文件按接收小时分区；清洗后的表按校正后的 event 日期分区，每次 run 重建最近 3 天，吸收迟到的上传。 |
| Freshness: CDC and events are minutes behind. An hourly Stripe pull leaves payments up to about 70 minutes old (60 minutes between runs plus the run), so it runs every 30 minutes to stay inside the hour. | **Freshness**：CDC 和 event 只落后几分钟。如果 Stripe 每小时拉一次，支付数据最旧会到约 70 分钟（两次 run 间隔 60 分钟加上 run 本身），所以改成每 30 分钟一次，才能留在一小时以内。 |

自查清单：

| English | 中文 |
|---|---|
| Postgres through log-based CDC (Debezium, a slot, topic per table), with a slot-lag alert | Postgres 走 log-based CDC（Debezium、一个 slot、每表一个 topic），有 slot lag 告警 |
| Stripe through list endpoints with a cursor checkpoint, backoff on 429, and a reconciliation against vendor totals | Stripe 走 list endpoint，有 cursor checkpoint、429 退避，并和 vendor 的总数对账 |
| App events through a collector that writes to Kafka before acking; dedupe on messageId | App event 经 collector 先写 Kafka 再 ack；按 `messageId` 去重 |
| Raw zone is append-only with deterministic object keys, so a rerun overwrites | raw zone 只追加、对象 key 是确定性的，所以重跑是覆盖 |
| Event time corrected for clock skew; late uploads handled with a lookback | event 时间按时钟偏差校正；迟到的上传用 lookback 处理 |
| Deletes: CDC carries them; query-based and API paths need soft deletes or an events feed | delete：CDC 自带；query 和 API 路径需要 soft delete 或 events feed |

---

## Common mistakes｜常见错误

| 错误 | 后果 | 怎么改 |
|---|---|---|
| cursor 用 `updated_at > max seen`，不留重叠 | 晚提交的 transaction 和相同时间戳的行被永久跳过 | 重读一个比最长 transaction 更长的 lookback，load 时去重；或者改用 log-based CDC |
| 用 extractor 的时钟当 cursor | 数据库时钟比 extractor 慢时，两次 poll 之间的行会被藏起来 | cursor 取自数据，不用 job 的时钟 |
| 指望 query 能看到 delete | 删掉的行永远留在 lake 里 | soft delete、定期 key 比对，或者 CDC |
| connector 停了，replication slot 还留着 | WAL 写满数据库磁盘 | 按 slot 对保留的 WAL 告警；用 `max_slot_wal_keep_size` 设上限；drop 不用的 slot |
| 页面落地之前就存了 API checkpoint | 一次崩溃就会跳过一页 | 先落地，再存 checkpoint；每页按请求生成 key，重复时覆盖 |
| 相信手机上的 `originalTimestamp` | event 落到错误的日期；按小时的图上出现来自未来的 event | 用 `receivedAt - (sentAt - originalTimestamp)` 校正，并按 event ID 去重 |
| raw zone 里用随机对象名 | 每次重试都多一份拷贝 | 按数据源和时间区间用确定性的 key，或者在第一次转换时去重 |

<details>
<summary>英文原表</summary>

| MISTAKE | WHAT GOES WRONG | FIX |
|---|---|---|
| Cursor on updated_at > max seen with no overlap | Late-committing transactions and timestamp ties are skipped for good | Re-read a lookback longer than the longest transaction and dedupe on load; or use log-based CDC |
| Using the extractor’s clock as the cursor | A database clock behind the extractor hides rows between polls | Take the cursor from the data, never from the job’s clock |
| Expecting a query to see deletes | Deleted rows stay in the lake forever | Soft deletes, a periodic key comparison, or CDC |
| Leaving a replication slot behind a stopped connector | WAL fills the database disk | Alert on retained WAL per slot; cap with max_slot_wal_keep_size; drop unused slots |
| Saving the API checkpoint before the page lands | A crash skips a page | Land first, then checkpoint; key each page by its request so a repeat overwrites |
| Trusting originalTimestamp from phones | Events land on the wrong day; hourly charts show events from the future | Correct with receivedAt - (sentAt - originalTimestamp) and dedupe on the event ID |
| Random object names in the raw zone | Every retry adds a copy | Deterministic keys per source and interval, or dedupe in the first transformation |

</details>

---

## Recap｜回顾

| English | 中文 |
|---|---|
| Sources come as databases (log or query), third-party APIs, clients and dropped files; each loses data in its own way. | 数据源分为数据库（读 log 或 query）、第三方 API、客户端和丢进来的文件；每一类丢数据的方式都不一样。 |
| Query-based extraction misses deletes, intermediate versions, late commits and timestamp ties. Take the cursor from the data and re-read a lookback window. | 基于 query 的抽取会漏掉 delete、中间版本、晚提交和相同时间戳。cursor 取自数据，并重读一个 lookback 窗口。 |
| Log-based CDC (Debezium on a Postgres slot or the MySQL binlog) sees every change in commit order. Its risks are WAL retention while the connector is down and at-least-once delivery. | Log-based CDC（Debezium 读 Postgres slot 或 MySQL binlog）按提交顺序看到每一次变更。风险是 connector 停着时的 WAL 保留，以及 at-least-once 投递。 |
| API pulls are bound by pagination, latency and rate limits. Slice by time to parallelise a backfill, back off on 429, checkpoint after landing. | API 抽取受分页、延迟和 rate limit 约束。按时间切片并行 backfill，429 时退避，落地后再存 checkpoint。 |
| Client events arrive late, twice and with wrong clocks. Dedupe on the event ID and correct time with receivedAt - (sentAt - originalTimestamp). | 客户端 event 会迟到、重复、时钟不准。按 event ID 去重，用 `receivedAt - (sentAt - originalTimestamp)` 校正时间。 |
| The raw zone is append-only with deterministic keys, so any path can be rerun. | raw zone 只追加、key 是确定性的，所以任何一条路径都能重跑。 |

> Next up: storage layout, where the raw zone meets cleaned and curated zones, file formats, partitioning and table formats.

下一课：存储布局，讲 raw zone 和 cleaned、curated zone 怎么衔接，以及文件格式、partitioning 和 table format。
