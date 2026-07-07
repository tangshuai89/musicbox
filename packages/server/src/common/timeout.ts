/**
 * 单次网络调用的超时工具——给 Promise 套一层硬超时。
 *
 * 注意：**不会**取消底层 promise（fetch 没办法从外部真正打断）。超时就
 * resolve 一个 fallback，让 Promise.all 走完其他分支。被丢弃的 promise
 * 仍然在后台跑，结束时 GC 自然回收。
 *
 * ⚠️ 不要把大对象塞进 fn 的返回值——会浪费内存到超时为止。
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
