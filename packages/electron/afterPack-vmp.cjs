/**
 * electron-builder afterPack 钩子：给打包出的 .app 做 Widevine VMP 签名。
 *
 * 为什么需要：
 *   dev 模式直接跑 castLabs 的 electron 二进制，它自带 VMP 签名，Spotify WPS
 *   开箱能播整曲。但 electron-builder 会重新组包 + macOS codesign，把 castLabs
 *   原始 VMP 签名弄失效 → 打包产物里的 Spotify 全曲会挂（退回 30s）。
 *   必须用 castLabs EVS 重新 VMP 签名，且**必须在 codesign 之前**（afterPack
 *   早于 electron-builder 的 afterSign/codesign 阶段，时序正好）。
 *
 * 前置（一次性，本机手动，见 specs/spotify/spec.md v2 「打包 / VMP」）：
 *   python3 -m pip install --upgrade castlabs-evs
 *   python3 -m castlabs_evs.account signup        # 注册 EVS 账号（免费）
 *   （凭据缓存在本机，之后 sign-pkg 非交互）
 *
 * 逃生阀：设 SKIP_VMP=1 跳过签名（只想验打包管线本身、不验 Widevine 时用）。
 *   跳过后产物的 Spotify 全曲不可用（退回 30s），其它源不受影响。
 */
const { execFileSync } = require('node:child_process');

exports.default = async function afterPackVmp(context) {
  // 只有 macOS 需要在此处 VMP 签名；其它平台 castLabs 时序不同，本项目也只打 mac。
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  if (process.env.SKIP_VMP === '1') {
    console.warn(
      '[vmp] SKIP_VMP=1 → 跳过 Widevine VMP 签名。' +
        '打包产物的 Spotify 全曲将不可用（退回 30s 预览），其它源正常。',
    );
    return;
  }

  // castlabs_evs.vmp sign-pkg 收的是「包含 .app 的目录」，不是 .app 本身。
  const pkgDir = context.appOutDir;
  console.log(`[vmp] castLabs EVS 签名中：${pkgDir}`);

  try {
    execFileSync(
      'python3',
      ['-m', 'castlabs_evs.vmp', 'sign-pkg', pkgDir],
      { stdio: 'inherit' },
    );
    console.log('[vmp] Widevine VMP 签名完成');
  } catch (err) {
    throw new Error(
      '[vmp] Widevine VMP 签名失败。请确认已完成一次性前置：\n' +
        '  python3 -m pip install --upgrade castlabs-evs\n' +
        '  python3 -m castlabs_evs.account signup\n' +
        '若只想验打包管线（不验 Widevine），用 SKIP_VMP=1 npm run pack 跳过。\n' +
        `原始错误：${err && err.message ? err.message : err}`,
    );
  }
};