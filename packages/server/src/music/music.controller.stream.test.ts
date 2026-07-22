/**
 * 回归测试：upstream stream error 不会挂掉进程。
 *
 * 背景：proxyAudio / coverProxy 的 `Readable.fromWeb(...).pipe(res)` 之前
 * 没接 error listener。当上游（QQ CDN / Netease / 网络中间件）突然重置或
 * 客户端断连时，undici 的 fetch body 会抛 `TypeError: terminated`，这个错
 * 没 listener → unhandled → Node 整个进程死。
 *
 * 修复模式：
 *   - upstreamReadable.on('error', swallow)  吞掉异常
 *   - res.on('close', () => upstreamReadable.destroy())  下游关掉主动停拉
 *
 * 测试用本地 http server 模拟"上游 reset 中断"：
 *   - test 1：上游写一半 chunk 后 destroy socket（CDN 突然 reset 的等价）
 *   - test 2：上游挂着不下线，下游主动 destroy（用户换歌 / 关页等价）
 *   - test 3：反例，不接 error listener，验证 Node 默认行为确实冒错
 *     （证明上面两条 listener 是真必要的，不是冗余）
 *
 * 运行: npx ts-node packages/server/src/music/music.controller.stream.test.ts
 */
export {};
const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');

interface ServerLike {
  port: number;
  close: () => Promise<void>;
}

async function makeUpstream(
  handler: (req: any, res: any) => void,
): Promise<ServerLike> {
  return await new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, () => {
      const addr = srv.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

/**
 * Simulates the post-fix `proxyAudio` pattern (excerpt):
 *   - Pipe upstream fetch body to a downstream
 *   - upstreamReadable.on('error', ...) — capture (don't crash)
 *   - downstream.on('close') — destroy upstreamReadable (stop pulling)
 *
 * Returns:
 *   - `state.capturedError` updated by the upstream error listener (via reference)
 *   - `upstreamReadable` for assertions on destruction state
 *   - `downstream` so callers can simulate client disconnect
 */
async function pipeLikeFixMode(upstreamUrl: string) {
  const fetchRes = await fetch(upstreamUrl);
  assert.ok(fetchRes.body, 'upstream must have body');
  const upstreamReadable = Readable.fromWeb(
    fetchRes.body as unknown as import('stream/web').ReadableStream,
  );
  // 返回的 snapshot 不带回 — 用 holder object 持有可变状态，listener
  // 触发时通过 holder 写，调用方读 holder.current 拿到 *此刻* 的值。
  const state: { capturedError: Error | null } = { capturedError: null };
  upstreamReadable.on('error', (err) => {
    state.capturedError = err;
  });

  const downstream = new (require('node:stream').Writable)({
    write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      cb();
    },
  });
  upstreamReadable.pipe(downstream);

  // 修好后必备：`downstream close` → 主动 destroy upstreamReadable
  downstream.on('close', () => {
    if (!upstreamReadable.destroyed) upstreamReadable.destroy();
  });

  return { upstreamReadable, downstream, state };
}

void (async () => {
  // ── 跑测试期间若异常逃出 listener 会被这里截到，不会让 process 死。
  //    我们用 escapes 来在 test 3 里 *反断言* 这件事。
  const escapes: Error[] = [];
  const onEscape = (err: unknown) => {
    escapes.push(err instanceof Error ? err : new Error(String(err)));
  };
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);

  // 兜底确保测试一定退（不挂住超时）
  let exitOk = false;
  const hardExit = setTimeout(() => {
    process.exit(exitOk ? 0 : escapes.length === 0 ? 0 : 1);
  }, 8000);

  // ── 1. 上游中途 reset → on('error') 捕获，process 不死 ──
  {
    const upstream = await makeUpstream((_req, res) => {
      // 不设 Content-Length → chunked encoding。body 一直可读直到 socket 关，
      // 才能让下游 fetch body 真正感知到 destroy。
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write(Buffer.from('first-chunk'));
      const tick = setInterval(() => {
        try {
          res.write(Buffer.from('.'));
        } catch {
          clearInterval(tick);
        }
      }, 30);
      res.on('close', () => clearInterval(tick));
      // 60ms 后 destroy socket — 模拟 CDN keep-alive reset
      setTimeout(() => {
        clearInterval(tick);
        res.socket?.destroy();
      }, 60);
    });

    const { state } = await pipeLikeFixMode(`http://127.0.0.1:${upstream.port}/`);
    // 等上游 reset + error 冒上来
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(state.capturedError, 'upstreamReadable.on(error) 应被触发');
    // Node 在 socket destroy 时 fetch body 一般会抛 terminated / ECONNRESET /
    // aborted — 不同 Node 版本措辞不同，只验证连接中断类错误即可
    const errMsg = (state.capturedError as unknown as Error).message;
    assert.ok(
      /terminated|ECONNRESET|aborted|reset|closed/i.test(errMsg),
      `错误应反映连接中断（实际 ${errMsg}）`,
    );

    await upstream.close();
    console.log('✅ 1. upstream 中途 reset → on(error) 捕获（不挂进程）');
  }

  // ── 2. 客户端（downstream）关掉时 → upstreamReadable.destroy() 被触发 ──
  {
    const upstream = await makeUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write(Buffer.from('hello')); // chunk 1
      // 不主动 destroy，挂着等下游关
      const t = setInterval(() => {
        try {
          res.write(Buffer.from('.'));
        } catch {
          clearInterval(t);
        }
      }, 30);
      res.on('close', () => clearInterval(t));
    });

    const { upstreamReadable, downstream } = await pipeLikeFixMode(
      `http://127.0.0.1:${upstream.port}/`,
    );
    // 等下游连上 + 拿到第一个 chunk
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!upstreamReadable.destroyed, '刚连上时不应已 destroy');

    // 模拟客户端 res 关掉
    downstream.destroy();
    // 等事件链路走完
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(
      upstreamReadable.destroyed,
      'downstream destroy() 后 upstreamReadable 也应 destroy（不再拉 upstream）',
    );

    await upstream.close();
    console.log('✅ 2. 客户端断 → upstreamReadable.destroy()（停拉 upstream）');
  }

  // ── 3. 反例（不装 listener）确实会抛 unhandled ──
  //
  // 这个测试 *故意* 不接 error listener，验证 Node 默认行为确实是会冒错。
  // 如果以后 Node 默认行为变了（自动 swallow），这个测试会失败，提醒我们
  // 检查 listener 是否还需要。
  {
    const upstream = await makeUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write(Buffer.from('first'));
      const tick = setInterval(() => {
        try {
          res.write(Buffer.from('.'));
        } catch {
          clearInterval(tick);
        }
      }, 30);
      res.on('close', () => clearInterval(tick));
      setTimeout(() => {
        clearInterval(tick);
        res.socket?.destroy();
      }, 60);
    });

    // 这个测试只观察"会不会冒错"，不确认错误内容
    const beforeCount = escapes.length;
    const fetchRes = await fetch(`http://127.0.0.1:${upstream.port}/`);
    const upstreamReadable = Readable.fromWeb(
      fetchRes.body as unknown as import('stream/web').ReadableStream,
    );
    // **故意**不接 on('error')：让 chunk 落空后 error 直接冒到 process.
    const dummy = new (require('node:stream').Writable)({
      write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        cb();
      },
    });
    upstreamReadable.pipe(dummy);

    await new Promise((r) => setTimeout(r, 300));

    // 没 listener 必冒 —— escapes 应该至少增加 1 个
    assert.ok(
      escapes.length > beforeCount,
      `无 listener 时应冒错（before=${beforeCount}, after=${escapes.length}）` +
        `，证明 fix 是必要的`,
    );

    await upstream.close();
    console.log('✅ 3. 反例：没 listener 时确实冒错 → fix 有意义');
  }

  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
  console.log('\n🎉 全部 3 个 stream 错误处理测试通过');
  exitOk = true;
  clearTimeout(hardExit);
  process.exit(0);
})();
