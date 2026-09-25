#!/usr/bin/env node
/**
 * 本机一键发布脚本：门禁 + 版本递增 + 打包 + 提交/注解 tag/推送。
 *
 * npm publish 与 GitHub Release 由 GitHub Actions 执行
 * （.github/workflows/publish.yml，`v*` tag 推送触发），所以推送 tag 后本脚本
 * 不再重复发包；要纯本机发布请用 --publish-locally（并配合 --skip-git，
 * 避免与 CI 抢同一版本）。
 *
 * 用法（在仓库根目录执行）：
 *   node scripts/release.mjs                 # 默认 patch 递增（0.3.5 -> 0.3.6）并完整发布
 *   node scripts/release.mjs minor           # minor 递增（0.3.5 -> 0.4.0）
 *   node scripts/release.mjs major           # major 递增（0.3.5 -> 1.0.0）
 *   node scripts/release.mjs 0.4.0           # 直接指定目标版本
 *   npm run release -- minor                 # 同上，通过 npm script 调用
 *
 * 开关：
 *   --dry-run           只做门禁（lint + 单测 + 覆盖率）与 npm pack 清单预览，不修改任何文件
 *   --publish-locally   本机执行 npm publish（默认交给 CI；建议同时 --skip-git）
 *   --skip-publish      历史开关，保留兼容：行为与默认一致（由 CI 发布）
 *   --skip-git          跳过 git 提交/tag/推送（版本号与 tag 自行处理）
 *   --gh-release        本机创建 GitHub Release（tag 已推送时由 CI 负责，会自动跳过）
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const SEMVER = /^\d+\.\d+\.\d+$/
const VALID_BUMPS = ['patch', 'minor', 'major']

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const bump = positional[0] ?? 'patch'
const dryRun = flags.has('--dry-run')
const publishLocally = flags.has('--publish-locally')
const skipPublish = flags.has('--skip-publish')
const skipGit = flags.has('--skip-git')
const ghRelease = flags.has('--gh-release')
/** tag 推送后由 GitHub Actions 负责 npm publish 与 GitHub Release。 */
const ciPublishes = !skipGit

if (!VALID_BUMPS.includes(bump) && !SEMVER.test(bump)) {
  console.error(`[release] 无效版本参数: ${bump}（应为 patch | minor | major | x.y.z）`)
  process.exit(1)
}
if (dryRun && (skipPublish || skipGit)) {
  console.warn('[release] 提示：--dry-run 与 --skip-* 同时使用，按预览模式执行（不修改任何文件）。')
}
if (skipPublish) {
  console.log('[release] 提示：--skip-publish 已是默认行为（发布由 GitHub Actions 承担）。')
}
if (publishLocally && ciPublishes) {
  console.warn(
    '[release] 警告：--publish-locally 与 tag 推送同时使用会与 CI 争抢同一版本，' +
    '建议配合 --skip-git 或直接依赖 CI 发布。',
  )
}

/** 计算目标版本（不写盘，dry-run 与门禁阶段共用） */
function nextVersion(current, target) {
  if (SEMVER.test(target)) return target
  const [major, minor, patch] = current.split('.').map(Number)
  if (target === 'major') return `${major + 1}.0.0`
  if (target === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function run(cmd, opts = {}) {
  console.log(`\n>> ${cmd}`)
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts })
  } catch {
    console.error(`\n[release] 命令失败，发布已中止：${cmd}`)
    process.exit(1)
  }
}

const newVer = nextVersion(PKG.version, bump)
const tarball = join('docs/packages', `${PKG.name}-${newVer}.tgz`)
console.log(`[release] ${PKG.name} ${PKG.version} -> v${newVer}  (${dryRun ? '预览模式，不修改任何文件' : '正式发布'})\n`)

// ---------- 1. 门禁：lint + 单测(构建) + 覆盖率 ----------
run('npm run lint')
run('npm test')
run('node --experimental-test-coverage --test "test/*.test.mjs"')

// ---------- 2. 打包清单预览 / 产出 tarball ----------
if (dryRun) {
  run('npm pack --dry-run')
  console.log(`\n[release] 预览完成。正式发布将依次执行：`)
  console.log(`  1. npm version ${bump} --no-git-tag-version（${PKG.version} -> ${newVer}）`)
  console.log(`  2. npm pack --pack-destination docs/packages -> ${tarball}`)
  if (!skipGit) console.log(`  3. git commit + 注解 tag v${newVer} + push origin HEAD / v${newVer}`)
  if (publishLocally) console.log('  4. npm publish --access public（本机发布）')
  if (!skipGit) console.log('  4. GitHub Actions：npm publish + GitHub Release（v* tag 推送触发）')
  if (ghRelease && skipGit) console.log(`  5. gh release create v${newVer} --generate-notes`)
  process.exit(0)
}

// ---------- 3. Git 工作区洁净检查（避免把无关改动卷进发布提交） ----------
if (!skipGit) {
  const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty) {
    console.error('[release] 工作区存在未提交改动，请先提交或 stash（发布提交只应包含版本号与 tarball/CHANGELOG）：')
    console.error(dirty)
    process.exit(1)
  }
}

// ---------- 4. 变更日志提醒 ----------
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`## [${newVer}]`)) {
  console.warn(`\n[release] 提醒：CHANGELOG.md 中未找到 "## [${newVer}]" 条目，建议先补充（不阻断发布）。`)
}

// ---------- 5. 版本递增 + 打包 ----------
run(`npm version ${newVer} --no-git-tag-version`)
run('npm pack --pack-destination docs/packages')

// ---------- 6. git 提交 + 注解 tag + 推送 ----------
if (!skipGit) {
  run('git add -A')
  run(`git commit -m "release v${newVer}: ${PKG.name} ${newVer}"`)
  run(`git tag -a v${newVer} -m "${PKG.name} v${newVer}"`)
  run('git push origin HEAD')
  run(`git push origin v${newVer}`)
}

// ---------- 7. npm 发布 ----------
if (publishLocally) {
  run('npm publish --access public')
} else {
  console.log('\n[release] 已跳过本机 npm publish：tag 推送后由 GitHub Actions 发布（.github/workflows/publish.yml）。')
  console.log('  本机手动发布：npm publish --access public')
  console.log('  脚本内本机发布：node scripts/release.mjs <version> --publish-locally --skip-git')
}

// ---------- 8. 可选：GitHub Release ----------
if (ghRelease) {
  if (ciPublishes) {
    console.log('\n[release] GitHub Release 由 GitHub Actions 创建（tag 已推送），跳过 gh release create。')
  } else {
    let hasGh = true
    try {
      execSync('gh --version', { cwd: ROOT, stdio: 'ignore' })
    } catch {
      hasGh = false
    }
    if (hasGh) {
      run(`gh release create v${newVer} ${tarball} --generate-notes --title "${PKG.name} v${newVer}"`)
    } else {
      console.warn('[release] 未检测到 gh CLI，跳过 GitHub Release。')
    }
  }
} else {
  console.log('\n[release] 如需本机创建 GitHub Release（tag 未推送时），可执行：')
  console.log(`  gh release create v${newVer} ${tarball} --generate-notes`)
}

const outcome = publishLocally
  ? '发布完成'
  : ciPublishes
    ? '提交与 tag 推送完成；npm publish 与 GitHub Release 由 CI 执行'
    : '版本递增与打包完成（未推送 tag）'
console.log(`\n[release] ✅ ${PKG.name} v${newVer} ${outcome}。`)
