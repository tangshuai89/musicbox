import { Injectable, Logger } from '@nestjs/common';
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

  private static readonly MAX_ATTEMPTS = 3;
  /** 第 n 次失败后的退避（ms）。长度应 = MAX_ATTEMPTS - 1。 */
  private static readonly BACKOFF_MS = [500, 1500];

  registerProcessor(fn: LikeSyncProcessor): void {
    this.processor = fn;
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
    if (!targets.length) return;

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
    for (const t of task.targets) {
      await this.runTarget(task, t.platform, t.trackId);
    }
  }

  /** 单个 target 的退避重试。最终失败只告警——best-effort。 */
  private async runTarget(
    task: LikeSyncTask,
    platform: MusicProvider,
    trackId: string,
  ): Promise<void> {
    const verb = task.liked ? 'like' : 'unlike';
    for (let attempt = 0; attempt < LikeSyncQueue.MAX_ATTEMPTS; attempt++) {
      try {
        await this.processor!(task.session, platform, trackId, task.liked);
        return;
      } catch (err) {
        const last = attempt === LikeSyncQueue.MAX_ATTEMPTS - 1;
        this.logger.warn(
          `like-sync ${verb} ${platform}/${trackId} ` +
            `attempt ${attempt + 1}/${LikeSyncQueue.MAX_ATTEMPTS} failed: ` +
            `${(err as Error).message}${last ? ' (giving up)' : ''}`,
        );
        if (last) return;
        await this.sleep(LikeSyncQueue.BACKOFF_MS[attempt]);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
