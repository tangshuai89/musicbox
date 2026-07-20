/**
 * LikeSyncQueue 的指数退避 + 狂点方向翻转行为单测。
 *
 * 关注 4 个性质：
 *  1. **致命错误短路**：processor 抛 NestJS HttpException（cookie 过期 / 未登录
 *     这类不可恢复状态）→ 立即放弃，不再 sleep，不再 retry。
 *  2. **指数退避序列**：普通错误按 base * 2^n 增长，总等待时间随 attempt 翻倍。
 *  3. **jitter 抖动**：每次 sleep 含 [0, base) 的随机量，多次调用不全相等（避免
 *     多个失败 target 在同一瞬间扎堆重试）。
 *  4. **方向翻转让位（狂点场景）**：unlike 进 drain 重试中 → 用户再点 like
 *     → pending 同 key 任务 liked 翻转 → 当前 unlike 立即放弃，不浪费 64s
 *     执着一个已经过时的意图。
 *
 * 不依赖真实 provider；用 stub processor 模拟行为。
 *
 * 运行: npx ts-node src/music/like-sync.queue.test.ts
 */
export {};
const assert = require('node:assert');

/* eslint-disable @typescript-eslint/no-var-requires */
const { LikeSyncQueue } = require('./like-sync.queue');
const { BadRequestException } = require('@nestjs/common');

/** 工具：跑一次 enqueue，poll 到队列彻底空闲后返 attempt 次数 / 总 sleep 时间。
 *  队列单飞 drain，attempt 之间会 sleep（指数退避最坏 ~64s）。这里设个 ~90s
 *  预算，安全覆盖完 MAX_ATTEMPTS=7 次。 */
async function runWith(processor: () => Promise<void>) {
  const q = new LikeSyncQueue();
  let attempts = 0;
  const wrappedProcessor = async (
    _s: any,
    _p: any,
    _t: any,
    _l: any,
  ) => {
    attempts++;
    await processor();
  };
  q.registerProcessor(wrappedProcessor);
  const sleepCalls: number[] = [];
  // 用 monkey-patch 抓 sleep 调用
  const originalSleep = (q as any).sleep.bind(q);
  (q as any).sleep = (ms: number) => {
    sleepCalls.push(ms);
    return originalSleep(ms);
  };
  await q.enqueue({
    session: { id: 's', providers: {} },
    mergedId: 'm',
    liked: true,
    targets: [{ platform: 'netease', trackId: 't' }],
  });
  // 等 drain 完成：draining 翻 false 才算结束（active=null + 循环退出 + finally）。
  // 预算 90s 覆盖最坏序列（6 次 sleep 累计 ~64s + jitter）。
  const start = Date.now();
  while ((q as any).draining && Date.now() - start < 90000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { attempts, sleeps: sleepCalls };
}

async function main() {
  // ── 1. 致命错误 → 立即放弃（不再 sleep、不再重试） ───────────────
  {
    const { attempts, sleeps } = await runWith(async () => {
      throw new BadRequestException('not_logged_in');
    });
    assert.strictEqual(attempts, 1, '致命错误应只尝试 1 次');
    assert.strictEqual(sleeps.length, 0, '致命错误不应 sleep');
    console.log('✅ 1. 致命错误 (BadRequestException) → 立即放弃');
  }

  // ── 2. 普通错误 → 指数退避，序列近似 base * 2^n ─────────────────
  {
    const { attempts, sleeps } = await runWith(async () => {
      throw new Error('transient');
    });
    assert.strictEqual(attempts, 7, '应有 7 次尝试');
    assert.strictEqual(sleeps.length, 6, '应 sleep 6 次（最后一次不 sleep）');
    // 期望值：~1000, ~2000, ~4000, ~8000, ~16000, ~32000；jitter 加 [0, 1000)。
    // 检查每段都在 [base*2^n, base*2^n + base) 区间内：
    for (let i = 0; i < sleeps.length; i++) {
      const lo = 1000 * 2 ** i;
      const hi = lo + 1000;
      assert.ok(
        sleeps[i] >= lo && sleeps[i] < hi,
        `sleep[${i}] = ${sleeps[i]} 不在 [${lo}, ${hi}) 区间内`,
      );
    }
    console.log('✅ 2. 指数退避序列正确（jitter 在 [0, base) 内）');
  }

  // ── 3. jitter 不是常数 → 多次调用不全相等 ───────────────────────
  {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const ms = (LikeSyncQueue as any).backoffMs(2); // 第 3 次退避
      samples.push(ms);
    }
    const distinct = new Set(samples).size;
    assert.ok(
      distinct >= 5,
      `20 次 backoffMs(2) 至少应有 5 个不同值（实际 ${distinct}），jitter 必须存在`,
    );
    console.log(
      `✅ 3. jitter 存在（20 次 sample → ${distinct} 个不同值，落在 [4000, 5000) ms）`,
    );
  }

  // ── 4. 方向翻转让位（狂点场景） ────────────────────────────────
  // unlike 进 drain、processor 一直失败 → 中途用户又点 like → 当前 unlike
  // 任务应被弃，不应再消耗剩余 ~30s 的退避 sleep。表现：attempt 远小于 7。
  {
    const q = new LikeSyncQueue();
    const attemptsByDir = new Map<boolean, number>(); // liked → attempts
    q.registerProcessor(async (_s: any, _p: any, _t: any, liked: boolean) => {
      attemptsByDir.set(liked, (attemptsByDir.get(liked) ?? 0) + 1);
      throw new Error('transient');
    });
    const sleepCalls: number[] = [];
    const originalSleep = (q as any).sleep.bind(q);
    (q as any).sleep = (ms: number) => {
      sleepCalls.push(ms);
      return originalSleep(ms);
    };
    // 先入队 unlike（让 drain 立即拾起）。
    await q.enqueue({
      session: { id: 's', providers: {} },
      mergedId: 'm',
      liked: false,
      targets: [{ platform: 'netease', trackId: '385781' }],
    });
    // 200ms 后入队 like（方向翻转）——远小于 unlike 第 1 次失败后的退避
    // sleep（≥1000ms），保证 like 在 unlike 还在 sleep 时就落进 pending，
    // 下次 attempt 循环开头 hasDirectionReversed 必命中。不能等太久（如 1200ms），
    // 否则 jitter 让 sleep 落在 1000~1100ms 时 unlike 已进入下一次 attempt，
    // 计数就多 1，测试变 flaky（本身逻辑没错，是时序竞态）。
    await new Promise((r) => setTimeout(r, 200));
    await q.enqueue({
      session: { id: 's', providers: {} },
      mergedId: 'm',
      liked: true,
      targets: [{ platform: 'netease', trackId: '385781' }],
    });
    // 等 drain 收敛（不像 task 2 那样会跑完 64s 退避 → 几秒内就该结束）。
    const start = Date.now();
    while ((q as any).draining && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const unlikeAttempts = attemptsByDir.get(false) ?? 0;
    const likeAttempts = attemptsByDir.get(true) ?? 0;
    // 关键断言 1：unlike 提前让位——远没跑满 7 次（不死磕过时意图）。
    // 用 ≤ 2 而非 === 1：容忍 enqueue 恰好卡在 attempt 边界的 ±1 时序抖动，
    // 真正要验的是"没有死磕到底"，不是精确次数。
    assert.ok(
      unlikeAttempts <= 2,
      `unlike 应在方向翻转后尽快让位、不跑满 7 次（实际 ${unlikeAttempts} 次）`,
    );
    // 关键断言 2：翻转信号确实送达——如果 hasDirectionReversed 不工作，unlike
    // 会一直跑到 7 次，like 永远轮不到。so like 至少跑了 1 次 = 让位生效。
    assert.ok(
      likeAttempts >= 1,
      `翻转后 like 应被处理（实际 ${likeAttempts} 次）`,
    );
    console.log(
      `✅ 4. 方向翻转让位（unlike=${unlikeAttempts} attempts 后让位，like=${likeAttempts} 次承接）`,
    );
  }

  console.log('\n🎉 like-sync.queue 全部 4 项通过');
}

main().catch((err) => {
  console.error('❌ like-sync.queue 失败:', err);
  process.exit(1);
});