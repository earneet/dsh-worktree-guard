# E2E CLI 实测脚本（修正版）：所有 wt.mjs 调用均以目标仓库为 cwd
$ErrorActionPreference = 'Stop'
$repo = Join-Path $env:TEMP ("wtg-e2e-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $repo | Out-Null
$wtCli = Join-Path $PSScriptRoot "..\wt.mjs" | Resolve-Path
$fail = 0
function Check($name, $cond) {
  if ($cond) { Write-Output "PASS  $name" } else { Write-Output "FAIL  $name"; $script:fail++ }
}
function RunIn($dir, $argList) {
  Push-Location $dir
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & node $wtCli @argList 2>&1 | Out-String; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev; Pop-Location }
  return @{ out = $out; code = $code }
}

try {
  git -C $repo init -b main 2>&1 | Out-Null
  git -C $repo config user.email t@t
  git -C $repo config user.name t
  Set-Content -Path (Join-Path $repo a.txt) -Value "hello"
  git -C $repo add .
  git -C $repo commit -q -m init

  # C1 help
  $r = RunIn $repo @('help')
  Check "C1 help 输出用法" ($r.out -match 'wt create')

  # C2 create（cwd=repo）
  $r = RunIn $repo @('create','fix-login','--brief','修复登录')
  $created = ($r.out | ConvertFrom-Json)
  $wt = $created.worktree
  Check "C2 worktree 建在 repo/.worktrees 下" ($wt -like (Join-Path $repo '*') -and (Test-Path $wt))
  Check "C2b 分支名 worktree-fix-login" ($created.branch -eq 'worktree-fix-login')
  Check "C2c task-brief 已写入" (Test-Path (Join-Path $wt '.dsh\task-brief.md'))

  # C3 status（主根，未绑定）
  $r = RunIn $repo @('status')
  $st = ($r.out | ConvertFrom-Json)
  Check "C3 status unbound + 副本列出" ($st.mode -eq 'unbound' -and $st.copies.Count -eq 1)

  # C4 enter（以副本为 cwd 的会话模型）
  $r = RunIn $wt @('enter','.','--session','s1')
  Check "C4 enter 绑定 s1" (($r.out | ConvertFrom-Json).worktree -ne $null)

  # C5 status --session：副本内 -> rooted；主根 -> repo-rooted
  $r = RunIn $wt @('status','--session','s1')
  Check "C5a 副本内 status = rooted" (($r.out | ConvertFrom-Json).mode -eq 'rooted')
  $r = RunIn $repo @('status','--session','s1')
  Check "C5b 主根 status = repo-rooted" (($r.out | ConvertFrom-Json).mode -eq 'repo-rooted')

  # C6 exit
  $r = RunIn $wt @('exit','--session','s1')
  Check "C6 exit 解绑" (($r.out | ConvertFrom-Json).exited -eq $true)
  $r = RunIn $wt @('status','--session','s1')
  Check "C6b 解绑后 unbound" (($r.out | ConvertFrom-Json).mode -eq 'unbound')

  # C7 remove 无确认 -> needConfirm, exit 0
  $r = RunIn $repo @('remove',$wt)
  Check "C7 remove 未确认 needConfirm" (($r.out | ConvertFrom-Json).needConfirm -eq $true -and $r.code -eq 0)

  # C8 【round-7 修复验证】新建副本（仅 .dsh 未跟踪）remove 无需 force
  $r = RunIn $repo @('remove',$wt,'--confirm-remove')
  Check "C8 新建副本 remove 直接成功（round-7 修复）" (($r.out | ConvertFrom-Json).removed -eq $true -and -not (Test-Path $wt))
  Check "C8b 未加 --delete-branch 分支保留" ($null -ne (git -C $repo branch --list worktree-fix-login))

  # C8c 用户未提交工作 -> remove 拒绝
  $r = RunIn $repo @('create','wip')
  $wtWip = ($r.out | ConvertFrom-Json).worktree
  Set-Content -Path (Join-Path $wtWip user.txt) -Value "x"
  $r = RunIn $repo @('remove',$wtWip,'--confirm-remove')
  Check "C8c 用户未提交工作 remove 拒绝" ($r.out -match '未提交变更')
  $r = RunIn $repo @('remove',$wtWip,'--confirm-remove','--force')
  Check "C8d --force 可清理" (($r.out | ConvertFrom-Json).removed -eq $true)

  # C9 merged-only 分支删除证明流
  $r = RunIn $repo @('create','second')
  $wt2 = ($r.out | ConvertFrom-Json).worktree
  Set-Content -Path (Join-Path $wt2 work.txt) -Value "x"
  git -C $wt2 add . 2>&1 | Out-Null
  git -C $wt2 commit -q -m work 2>&1 | Out-Null
  $r = RunIn $repo @('remove',(Join-Path $repo '.worktrees\worktree-second'),'--confirm-remove','--delete-branch')
  Check "C9a 未合并分支 remove+delete 拒绝" ($r.out -match '未合并')
  git -C $repo merge -q --no-ff worktree-second -m "merge second" 2>&1 | Out-Null
  $r = RunIn $repo @('remove',$wt2,'--confirm-remove','--delete-branch')
  Check "C9b 合并后 remove+delete 成功且分支删除" (($r.out | ConvertFrom-Json).removed -eq $true -and $null -eq (git -C $repo branch --list worktree-second))

  # C10 prune：死绑定（worktree 目录被外部删除）
  $r = RunIn $repo @('create','third')
  $wt3 = ($r.out | ConvertFrom-Json).worktree
  RunIn $wt3 @('enter','.','--session','s2') | Out-Null
  git -C $repo worktree remove --force $wt3 2>&1 | Out-Null
  $r = RunIn $repo @('prune','--dry-run')
  Check "C10a prune dry-run 报死绑定" ((@(($r.out | ConvertFrom-Json).dropped)).Count -ge 1)
  $r = RunIn $repo @('prune')
  $r2 = RunIn $repo @('prune','--dry-run')
  Check "C10b prune 实删后再查为空" ((@(($r2.out | ConvertFrom-Json).dropped)).Count -eq 0)

  # C11 authorize-main 非 TTY 拒绝（模型 shell 模拟）
  $r = RunIn $repo @('authorize-main','测试')
  Check "C11 authorize-main 非 TTY 拒绝 (exit 1)" ($r.code -eq 1 -and $r.out -match '人工通道')

  # C12 revoke-main
  $r = RunIn $repo @('revoke-main')
  Check "C12 revoke-main 成功" ($r.code -eq 0 -and $r.out -match '已收回')

  # C13 未知命令
  $r = RunIn $repo @('frobnicate')
  Check "C13 未知命令 exit 2" ($r.code -eq 2)

  # C14 状态区落在 .git/worktree-guard
  Check "C14 状态区存在且含审计" (Test-Path (Join-Path $repo '.git\worktree-guard\audit.jsonl'))
}
finally {
  git -C $repo worktree prune 2>&1 | Out-Null
  Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
}
Write-Output ("SUMMARY fail=" + $fail)
exit $fail
