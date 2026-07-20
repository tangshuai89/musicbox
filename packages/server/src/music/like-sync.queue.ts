import { Injectable, Logger, HttpException } from '@nestjs/common';
import { MusicProvider } from '../common/provider';
import { Session } from '../common/session';

/**
 * 一个「把某统一歌曲的红心同步到若干平台」的任务。
 *
 * ⚠️ targets 必须已经按业务规则去重成**每个平台最多一首**——统一搜索会把
 * 同名的一堆变体（20+ 个音源）塞进同一个 unified item 的 sources，直接全同步
 * 会把一堆变体全收藏。入队方（music.service）负责按平台取代表 trackId，
 * 队列内部再兜底去重一次。
 */
export interface LikeSyncTask {
  /** 捕获入队那一刻的 session 引用（含各平台 cookie/token）。best-effort：
   *  即使后续重新登录，用这个快照同步也能接受。 */
  session: Session;
  /** 统一 track 的 mergedId——同一 mergedId 的任务会被合并去重。 */
  mergedId: string;
  /** true=收藏同步；false=取消收藏同步。 */
  liked: boolean;
  /** 每平台一首的目标列表。 */
  targets: Array<{ platform: MusicProvider; trackId: string }>;
  /**
   * 可选：跨平台匹配元数据（仅 liked=true 有意义）。设置后，队列会在同步前
   * 先调 discoverResolver——去「已登录但还没有这首歌 source」的 likeable 平台
   * 搜同名同时长的等价曲目，找到就补进 targets 并由 resolver 落地 fanOut。
   * `have` 是已经有 source / 已处理的平台，匹配时跳过（不重复搜索）。
   */
  discover?: {
    title: string;
    artist: string;
    duration: number;
    have: MusicProvider[];
  };
}

/**
 * 真正执行「同步一个 (platform, trackId) 的红心到远端」的回调。
 * 成功 resolve；失败 throw（队列据此重试）。由 music.service 注册。
 */
export type LikeSyncProcessor = (
  session: Session,
  platform: MusicProvider,
  trackId: string,
  liked: boolean,
) => Promise<void>;

/**
 * 跨平台匹配回调：给定一个带 discover 元数据的 like 任务，去其余已登录平台
 * 搜同名同时长的等价曲目，落地本地 liked + fanOut，并返回新补上的
 * (platform, trackId) 目标供队列同步远端。找不到返回空数组。由 music.service 注册。
 */
export type LikeDiscoverResolver = (
  task: LikeSyncTask,
) => Promise<Array<{ platform: MusicProvider; trackId: string }>>;

/**
 * 进程内红心同步队列（MQ 思路的轻量实现）。
 *
 * 为什么不用真 MQ：这是纯本地 Electron 播放器，没有服务端、没有 broker
 * （见 CLAUDE.md「也没有服务器」）。这里用一个带**合并去重 + 串行消费 +
 * 失败退避重试**的进程内队列达到同样目的：切歌时检测到「某平台已红心」→
 * 入队 → 后台异步把红心补到其余平台，不阻塞播放。
 *
 * 关键性质：
 *  1. **合并去重**：相同 (session, mergedId) 的任务合并——避免同一首歌在
 *     连续切歌/重复点心时被重复同步。
 *  2. **每平台一首**：dedupeByPlatform 兜底，即使调用方漏了也不会把 20 个
 *     变体全同步。
 *  3. **串行消费**：后台单飞 drain，避免并发把平台 API 打爆。
 *  4. **失败重试**：每个 target 独立退避重试；最终失败只记日志（best-effort，
 *     下次切到这首歌 detect 会重新入队自愈）。
 *
 * 不持久化：进程重启后未消费的任务丢失是可接受的——detect 在下次播放该曲
 * 时会重新入队。
 */
@Injectable()
export class LikeSyncQueue {
  private readonly logger = new Logger(LikeSyncQueue.name);
  /** key(`${sessionId}:${mergedId}`) → 待消费任务（同 key 合并）。 */
  private readonly pending = new Map<string, LikeSyncTask>();
  /** 正在消费中的任务（已从 pending 移除但还没写完）——pendingTargets 要把它
   *  也算作在途，否则对账会把正在写的乐观本地态误判为失配。 */
  private active: LikeSyncTask | null = null;
  private draining = false;
  private processor?: LikeSyncProcessor;
  private discoverResolver?: LikeDiscoverResolver;

  /**
   * 单个 target 的最大尝试次数。覆盖 1 次失败 + 6 次退避重试 ≈ 64s 窗口
   * （1s + 2s + 4s + 8s + 16s + 32s）—— 网易云"操作频繁"阈值经验值几分钟，
   * 这个长度让多数短窗口抖动等得到恢复，又不会让用户在切歌时无限等待。
   */
  private static readonly MAX_ATTEMPTS = 7;
  /**
   * 指数退避基准（ms）。第 n 次失败后实际等待 = BASE * 2^(n-1) + jitter[0..BASE)。
   * - BASE = 1000 → 序列：~1s, ~2s, ~4s, ~8s, ~16s, ~32s（n=1..6）。
   * - jitter：[0, BASE) 的随机抖动，避免多个失败 target 在同一瞬间一起重试
   *   把平台 API 打爆（thundering herd）。
   */
  private static readonly BACKOFF_BASE_MS = 1000;

  registerProcessor(fn: LikeSyncProcessor): void {
    this.processor = fn;
  }

  registerDiscoverResolver(fn: LikeDiscoverResolver): void {
    this.discoverResolver = fn;
  }

  /**
   * 某 session 当前在途（待消费 + 消费中）的同步目标。供对账用：远端
   * 刷新时，在途的乐观写还没落到远端，不能被当作失配抹掉。
   */
  pendingTargets(
    sessionId: string,
  ): Array<{ platform: MusicProvider; trackId: string; liked: boolean }> {
    const out: Array<{
      platform: MusicProvider;
      trackId: string;
      liked: boolean;
    }> = [];
    const collect = (task: LikeSyncTask) => {
      if (task.session.id !== sessionId) return;
      for (const t of task.targets) {
        out.push({ platform: t.platform, trackId: t.trackId, liked: task.liked });
      }
    };
    if (this.active) collect(this.active);
    for (const task of this.pending.values()) collect(task);
    return out;
  }

  private key(task: LikeSyncTask): string {
    return `${task.session.id}:${task.mergedId}`;
  }

  private dedupeByPlatform(
    targets: Array<{ platform: MusicProvider; trackId: string }>,
  ): Array<{ platform: MusicProvider; trackId: string }> {
    const m = new Map<MusicProvider, string>();
    for (const t of targets) {
      if (t?.trackId && !m.has(t.platform)) m.set(t.platform, t.trackId);
    }
    return [...m.entries()].map(([platform, trackId]) => ({
      platform,
      trackId,
    }));
  }

  /**
   * 入队一个同步任务。空 targets 直接忽略。
   * 合并规则：
   *  - 同 key 且方向一致（都 liked 或都 unlike）→ 平台并集，保留已有 trackId。
   *  - 同 key 但方向翻转（收藏 ↔ 取消）→ 新意图整体覆盖旧任务。
   */
  enqueue(task: LikeSyncTask): void {
    const targets = this.dedupeByPlatform(task.targets);
    // 允许「只有 discover、targets 暂空」的任务入队——detect 到某平台已红心、
    // 但要写的其余平台都还没有 source 时，targets 为空，跨平台匹配却仍要跑。
    if (!targets.length && !task.discover) return;

    const key = this.key(task);
    const existing = this.pending.get(key);
    if (existing && existing.liked === task.liked) {
      const byPlatform = new Map(
        existing.targets.map((t) => [t.platform, t] as const),
      );
      for (const t of targets) {
        if (!byPlatform.has(t.platform)) byPlatform.set(t.platform, t);
      }
      existing.targets = [...byPlatform.values()];
      existing.session = task.session; // 用最新 session（cookie 可能已刷新）
      // 任一次入队带了跨平台匹配元数据就保留（避免被后来的无 meta 入队覆盖丢掉）。
      existing.discover = existing.discover ?? task.discover;
    } else {
      this.pending.set(key, { ...task, targets });
    }
    void this.drain();
  }

  /** 后台单飞消费循环。已在消费则直接返回（入队方只管塞，不管跑）。 */
  private async drain(): Promise<void> {
    if (this.draining || !this.processor) return;
    this.draining = true;
    try {
      for (;;) {
        const key = this.pending.keys().next().value as string | undefined;
        if (key === undefined) break;
        const task = this.pending.get(key)!;
        this.pending.delete(key);
        this.active = task;
        try {
          await this.runTask(task);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTask(task: LikeSyncTask): Promise<void> {
    // 跨平台匹配（仅 liked=true）：先补齐「其余已登录平台」的等价曲目。resolver
    // 负责搜索 + 落地本地 liked/fanOut，返回新目标；这里合并进 targets 再同步远端。
    // 直接改 task.targets（task === this.active）→ pendingTargets 立即把新目标算作
    // 在途，避免对账把刚点亮的本地态误判为失配。
    if (task.liked && task.discover && this.discoverResolver) {
      try {
        const extra = await this.discoverResolver(task);
        if (extra?.length) {
          task.targets = this.dedupeByPlatform([...task.targets, ...extra]);
        }
      } catch (err) {
        this.logger.warn(
          `like-sync discover for ${task.mergedId} failed: ${(err as Error).message}`,
        );
      }
    }
    for (const t of task.targets) {
      await this.runTarget(task, t.platform, t.trackId);
    }
  }

  /** 单个 target 的指数退避重试。
   *  - HttpException（provider 抛 BadRequestException 等）= 致命错误
   *    （cookie 过期 / 未登录 / 配置缺失）→ 立即放弃，不重试浪费 64s。
   *  - 其他（网络抖动 / 平台 code=405 / -460 风控）= 可重试 → 指数退避 + 抖动。
   *  - 用户中途翻转方向（unlike → like 或反之）= 当前意图已废，立即退出
   *    让位给新任务；pending 里有同 key 但 liked 反过来的任务，就是翻转信号。
   *  最终失败只告警——best-effort。 */
  private async runTarget(
    task: LikeSyncTask,
    platform: MusicProvider,
    trackId: string,
  ): Promise<void> {
    const verb = task.liked ? 'like' : 'unlike';
    for (let attempt = 0; attempt < LikeSyncQueue.MAX_ATTEMPTS; attempt++) {
      // 翻转检查：先于 throw-catch 一次，免得 sleep 完再发现意图已废。
      if (this.hasDirectionReversed(task)) {
        this.logger.log(
          `like-sync ${verb} ${platform}/${trackId} ` +
            `superseded by direction reversal — aborting retries`,
        );
        return;
      }
      try {
        await this.processor!(task.session, platform, trackId, task.liked);
        return;
      } catch (err) {
        const fatal = LikeSyncQueue.isFatalError(err);
        const last = attempt === LikeSyncQueue.MAX_ATTEMPTS - 1;
        this.logger.warn(
          `like-sync ${verb} ${platform}/${trackId} ` +
            `attempt ${attempt + 1}/${LikeSyncQueue.MAX_ATTEMPTS} failed: ` +
            `${(err as Error).message}${fatal ? ' (fatal)' : ''}` +
            `${last && !fatal ? ' (giving up)' : ''}`,
        );
        if (fatal || last) return;
        await this.sleep(LikeSyncQueue.backoffMs(attempt));
      }
    }
  }

  /** 队列里同 key 的 pending 任务方向是否翻转？
   *  狂点场景：unlike 进 drain（耗 64s 重试）→ 1s 后用户再点 like → pending
   *  里出现 liked=true 同 key 任务。当前 unlike 任务应主动让位，避免「先 unlike
   *  再 like 把远端最终顶在 like 但本地乐观态也被覆盖两次」的鬼魅循环。
   *  active 任务自己不算（liked === task.liked，永远不等）。 */
  private hasDirectionReversed(task: LikeSyncTask): boolean {
    const k = this.key(task);
    for (const [pendingKey, pendingTask] of this.pending) {
      if (pendingKey !== k) continue;
      if (pendingTask.liked !== task.liked) return true;
    }
    return false;
  }

  /** 失败后等待时长 = BASE * 2^attempt + [0, BASE) 随机抖动。attempt 从 0 计
   *  算 → 1s+jitter, 2s+jitter, 4s+jitter... 抖动避免多个失败 target 在同一
   *  瞬间扎堆重试打爆平台 API（thundering herd）。 */
  private static backoffMs(attempt: number): number {
    const base = LikeSyncQueue.BACKOFF_BASE_MS * 2 ** attempt;
    return base + Math.floor(Math.random() * LikeSyncQueue.BACKOFF_BASE_MS);
  }

  /** 是否致命错误（不该重试）。
   *  provider 现在统一用 NestJS `HttpException` 表达「不可恢复」状态：
   *  BadRequestException(400) for "not_logged_in" / cookie 过期 / 缺少 key 等。
   *  重试这些只会多花 64s 等同一个死掉的会话。 */
  private static isFatalError(err: unknown): boolean {
    return err instanceof HttpException;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
