
const head = require('./cross-verify-head.cjs')

// 造一组真实样例：模拟一个 profile 的文件
const sampleFiles = [
  { path: 'package.json', json: { name: 'my-profile', dependencies: { 'plugin-a': '^1.0.0', 'plugin-b': '^2.0.0' }, dsh: { profile: { bundles: ['plugin-a'] } } } },
  { path: 'config.toml', lines: ['[server]', 'port = 8080'] },
  { path: 'sub/deep.txt', lines: ['line1', 'line2'] },
]

// 场景里包含 link: 本机路径依赖（#205 场景），看两边各自表现
const sampleFilesWithLocalDep = [
  { path: 'package.json', json: { name: 'my-profile', dependencies: { 'plugin-a': '^1.0.0', 'local-dev': 'link:/Users/me/dev/x' }, dsh: { profile: { bundles: ['plugin-a', 'local-dev'] } } } },
  { path: 'config.toml', lines: ['port=1'] },
]

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')) }
}

console.log('\n========== 场景1：工作区导出 → dsh-market 导入 ==========')
{
  // 工作区 doBackup 流程：collect → stripMachineLocalDeps → buildEnvelope → serialize → 上传
  // 模拟 stripMachineLocalDeps（工作区在上传前会剥离 link:/file: 绝对路径）
  function ws_strip(manifest) {
    const unportable = []
    for (const [name, raw] of Object.entries(manifest.dependencies || {})) {
      if (typeof raw !== 'string') continue
      const m = /^(?:link|file):(.+)$/i.exec(raw)
      if (m) { let p = m[1]; try { p = decodeURIComponent(p) } catch {}
        if (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) unportable.push({ name, spec: raw }) }
    }
    if (unportable.length === 0) return { json: manifest, strippedDeps: [], strippedBundles: [] }
    const drop = new Set(unportable.map(d => d.name))
    const deps = {}
    for (const [n, s] of Object.entries(manifest.dependencies)) if (!drop.has(n)) deps[n] = s
    const dsh = manifest.dsh || {}
    const prof = dsh.profile || {}
    const bundles = Array.isArray(prof.bundles) ? prof.bundles : []
    return { json: { ...manifest, dependencies: deps, dsh: { ...dsh, profile: { ...prof, bundles: bundles.filter(n => typeof n !== 'string' || !drop.has(n)) } } }, strippedDeps: unportable, strippedBundles: bundles.filter(n => drop.has(n)) }
  }

  // 工作区 collectProfileBackup 内部对 package.json 做了 strip
  const stripped = ws_strip(sampleFilesWithLocalDep[0].json)
  const wsFiles = [
    { path: 'package.json', json: stripped.json },
    { path: 'config.toml', lines: ['port=1'] },
  ]
  const wsBackup = head.ws_buildBackupEnvelope(wsFiles, 'desktop')
  const wsContent = head.ws_serializeBackup(wsBackup)  // 这就是上传到 Gist 的文件内容
  const wsBytes = Buffer.byteLength(wsContent)
  check('工作区生成的备份 < 1MB (Gist 限制)', wsBytes < head.WS_GIST_MAX_BYTES, wsBytes + ' bytes')

  // 模拟 Gist 服务器返回的 JSON（dsh-market readGist 收到的就是这个结构）
  const gistPayloadFromWS = { files: { [head.WS_GIST_FILENAME]: { content: wsContent } } }

  // dsh-market readGist 流程：取 content → JSON.parse → validatedBackup
  const dmContent = head.dm_findBackupContent(gistPayloadFromWS.files)
  check('dsh-market 能从工作区写的 Gist 里取到 content', dmContent !== null)

  let dmParsed
  try {
    dmParsed = JSON.parse(dmContent)
    check('dsh-market JSON.parse 工作区 content 成功', true)
  } catch (e) { check('dsh-market JSON.parse 工作区 content 成功', false, e.message) }

  let dmValidated
  try {
    dmValidated = head.dm_validatedBackup(dmParsed)
    check('dsh-market validatedBackup 工作区备份 → 通过', true)
  } catch (e) { check('dsh-market validatedBackup 工作区备份 → 通过', false, e.message) }

  // 验证剥离生效：恢复端不该再看到 link:/Users/...
  const restoredDeps = dmValidated.files.find(f => f.path === 'package.json').json.dependencies
  check('工作区剥离后，dsh-market 恢复端看不到 link: 依赖', !('local-dev' in restoredDeps), JSON.stringify(restoredDeps))
}

console.log('\n========== 场景2：dsh-market 导出 → 工作区导入 ==========')
{
  // dsh-market createProfileBackup（完整导出，不剥离 link: —— 它只报告，不剥离）
  const dmBackup = head.dm_createProfileBackup('desktop', sampleFilesWithLocalDep)
  const dmContent = JSON.stringify(dmBackup, null, 2)  // dsh-market routes.ts: JSON.stringify(backup, null, 2)
  const dmBytes = Buffer.byteLength(dmContent)
  check('dsh-market 生成的备份 < 1MB (Gist 限制)', dmBytes < head.DM_GIST_MAX_BYTES, dmBytes + ' bytes')

  // Gist 服务器返回
  const gistPayloadFromDM = { files: { [head.DM_GIST_FILENAME]: { content: dmContent } } }

  // 工作区 readGistBackupContent：取 content（含 fallback 探测）
  const wsContent = head.ws_findBackupContent(gistPayloadFromDM.files)
  check('工作区能从 dsh-market 写的 Gist 里取到 content', wsContent !== null)

  let wsParsed
  try {
    wsParsed = JSON.parse(wsContent)
    check('工作区 JSON.parse dsh-market content 成功', true)
  } catch (e) { check('工作区 JSON.parse dsh-market content 成功', false, e.message) }

  // 工作区 validateBackupStrict
  const vErr = head.ws_validateBackupStrict(wsParsed)
  check('工作区 validateBackupStrict dsh-market 备份 → 通过', vErr === null, vErr)

  // 工作区恢复端会报告（不剥离）link: 依赖 —— 验证它能看到并报告
  const restoredDeps = wsParsed.files.find(f => f.path === 'package.json').json.dependencies
  check('工作区恢复端能看到 dsh-market 带来的 link: 依赖（会报告，不阻断）', 'local-dev' in restoredDeps, JSON.stringify(restoredDeps))
}

console.log('\n========== 场景3：正常备份（无本机路径依赖）双向 ==========')
{
  const dmBackup = head.dm_createProfileBackup('desktop', sampleFiles)
  const wsBackup = head.ws_buildBackupEnvelope(sampleFiles, 'desktop')

  // dsh-market → 工作区
  const v1 = head.ws_validateBackupStrict(dmBackup)
  check('dsh-market正常备份 → 工作区校验通过', v1 === null, v1)

  // 工作区 → dsh-market
  let ok2 = true, err2
  try { head.dm_validatedBackup(wsBackup) } catch (e) { ok2 = false; err2 = e.message }
  check('工作区正常备份 → dsh-market校验通过', ok2, err2)
}

console.log('\n========== 场景4：边界——文件名不同时工作区的 fallback 探测 ==========')
{
  // 模拟一个老版本/别的工具写的 Gist，文件名不是 dsh-profile-backup.json
  const oldBackup = head.dm_createProfileBackup('desktop', sampleFiles)
  const oldContent = JSON.stringify(oldBackup)
  const gistWithOtherName = { files: { 'dsh-config-backup.json': { content: oldContent } } }

  // dsh-market readGist 只认 GIST_FILENAME → 找不到
  const dmFound = head.dm_findBackupContent(gistWithOtherName.files)
  check('dsh-market 读不到非标准文件名的 Gist（只认 dsh-profile-backup.json）', dmFound === null)

  // 工作区有 fallback：先试 dsh-config-backup.json
  const wsFound = head.ws_findBackupContent(gistWithOtherName.files)
  check('工作区 fallback 能读到 dsh-config-backup.json 文件名', wsFound !== null)
}

console.log('\n========== 总结 ==========')
console.log('通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail > 0 ? 1 : 0)
