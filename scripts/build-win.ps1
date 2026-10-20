<#
.SYNOPSIS
    QC BookLog Windows 一键构建 + 打包 + 自检

.DESCRIPTION
    在 Windows 机器上按顺序完成：
      0. 环境检查（Node 18、npm、Python、VS C++ 工具链、server 依赖）
      1. npm run build         前端构建（vue-tsc + vite）
      2. npm run electron:rebuild   原生模块切到 Electron ABI
      3. 打包直接成功则结束；失败则强制补装 Electron headers 重试一次
      4. npm run check:win     ABI / 产物自检
      5. electron-builder --win 产出 NSIS 安装包
      6. 校验安装包与 win-unpacked 结构，打印体积与后续验证清单

    纯 ASCII 输出，避免 Windows PowerShell 5.1 中文乱码。日志同时写入 build-win.log。

.PARAMETER InstallDeps
    先执行 npm install 与 server/npm install。

.PARAMETER SkipBuild
    跳过前端构建（dist/ 已是最新时用）。

.PARAMETER OpenOutput
    结束后打开 release 目录。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1 -InstallDeps -OpenOutput
#>

[CmdletBinding()]
param(
    [switch]$InstallDeps,
    [switch]$SkipBuild,
    [switch]$OpenOutput
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogFile = Join-Path $Root 'build-win.log'
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

$script:StepNo = 0
$script:Warnings = @()

function Write-Log {
    param([string]$Message, [string]$Color = 'Gray')
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $Message -ForegroundColor $Color
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Write-Step {
    param([string]$Title)
    $script:StepNo++
    Write-Log ""
    Write-Log ("=" * 64) 'DarkGray'
    Write-Log ("[{0}] {1}" -f $script:StepNo, $Title) 'Cyan'
    Write-Log ("=" * 64) 'DarkGray'
}

function Write-Ok    { param([string]$m) Write-Log "  OK   $m" 'Green' }
function Write-Warn  {
    param([string]$m)
    Write-Log "  WARN $m" 'Yellow'
    $script:Warnings += $m
}
function Write-Fail  { param([string]$m) Write-Log "  FAIL $m" 'Red' }

function Invoke-Step {
    param([string]$Name, [string[]]$Command)
    Write-Log "> $Name" 'White'
    & $Command[0] $Command[1..($Command.Length - 1)]
    if ($LASTEXITCODE -ne 0) {
        throw "命令失败（exit $LASTEXITCODE）：$Command"
    }
}

function Get-InstalledVersion {
    param([string]$PackageJsonPath)
    if (-not (Test-Path $PackageJsonPath)) { return $null }
    try {
        return (Get-Content $PackageJsonPath -Raw | ConvertFrom-Json).version
    } catch {
        return $null
    }
}

function Test-VsToolchain {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $installPath = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationPath 2>$null
        if ($installPath) { return $installPath }
    }
    return $null
}

function Wait-KeyPress {
    Write-Log ""
    Write-Host '按回车键退出...' -ForegroundColor DarkGray
    [void](Read-Host)
}

# ---------------------------------------------------------------- 0. 环境检查
Write-Step '环境检查'

$nodeVersion = (node --version) 2>$null
if (-not $nodeVersion) {
    Write-Fail '未检测到 Node.js，请安装 18.19.x 后重试'
    Wait-KeyPress; exit 1
}
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Fail "Node $nodeVersion 过低，需要 18.19.x 或更高"
    Wait-KeyPress; exit 1
}
if ($nodeMajor -gt 20) {
    Write-Warn "Node $nodeVersion 未验证过（本项目在 18.19.x 上验证）；若原生模块编译异常请改用 18.19.x"
} else {
    Write-Ok "Node $nodeVersion"
}
Write-Ok "npm $((npm --version) 2>$null)"

$pythonOk = $false
foreach ($py in @('python', 'python3', 'py')) {
    $v = (& $py --version 2>$null) -join ''
    if ($LASTEXITCODE -eq 0 -and $v -match '^Python 3') {
        Write-Ok "$v（node-gyp 使用）"
        $pythonOk = $true
        break
    }
}
if (-not $pythonOk) {
    Write-Warn '未检测到 Python 3；node-gyp 编译将失败，请安装 Python 3 并勾选 Add to PATH'
}

$vsPath = Test-VsToolchain
if ($vsPath) {
    Write-Ok "VS C++ 生成工具：$vsPath"
} else {
    Write-Warn '未检测到 Visual Studio C++ 生成工具；原生模块无法编译。请安装 "Desktop development with C++"'
}

if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Ok "git $((git --version) -replace 'git version ', '')"
} else {
    Write-Warn '未安装 git：仅同步功能不可用，其余功能正常（P0.3 场景，可顺带验证）'
}

$electronVersion = Get-InstalledVersion (Join-Path $Root 'node_modules\electron\package.json')
$builderVersion  = Get-InstalledVersion (Join-Path $Root 'node_modules\electron-builder\package.json')
$serverDeps      = Test-Path (Join-Path $Root 'server\node_modules')

if ($InstallDeps -or -not $electronVersion -or -not $builderVersion -or -not $serverDeps) {
    if (-not $InstallDeps) { Write-Warn '依赖不完整，自动补装' }
    Write-Step '安装依赖'
    Invoke-Step 'npm install（根目录）' @('npm', 'install')
    Write-Log '> npm install（server）' 'White'
    Push-Location (Join-Path $Root 'server')
    try { & npm install } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw '命令失败：server npm install' }
    $electronVersion = Get-InstalledVersion (Join-Path $Root 'node_modules\electron\package.json')
    $builderVersion  = Get-InstalledVersion (Join-Path $Root 'node_modules\electron-builder\package.json')
} else {
    Write-Ok "electron $electronVersion / electron-builder $builderVersion 已安装"
    Write-Ok 'server/node_modules 已存在'
}

if (-not $electronVersion) { Write-Fail 'electron 未安装'; Wait-KeyPress; exit 1 }
if (-not $builderVersion)  { Write-Fail 'electron-builder 未安装'; Wait-KeyPress; exit 1 }

# ---------------------------------------------------------------- 1. OCR 资源
Write-Step 'OCR 静态资源（tessdata / tesseract-core / tesseract-dist）'

try {
    Invoke-Step 'npm run prepare:ocr' @('npm', 'run', 'prepare:ocr')
} catch {
    Write-Warn 'OCR 资源准备失败：构建可继续，但书摘 OCR 可能不可用'
}
if (Test-Path (Join-Path $Root 'public\tessdata')) {
    $langCount = (Get-ChildItem (Join-Path $Root 'public\tessdata') -Filter '*.traineddata.gz' -File -ErrorAction SilentlyContinue).Count
    if ($langCount -gt 0) {
        Write-Ok "语言包 $langCount 个"
    } else {
        Write-Warn 'public/tessdata 无语言包，OCR 识别会失败'
    }
} else {
    Write-Warn '缺少 public/tessdata 目录'
}

# ---------------------------------------------------------------- 2. 前端构建
if ($SkipBuild) {
    Write-Step '前端构建（已跳过）'
    if (-not (Test-Path (Join-Path $Root 'dist\index.html'))) {
        Write-Fail '指定了 -SkipBuild 但 dist/index.html 不存在'
        Wait-KeyPress; exit 1
    }
    Write-Ok '复用已有 dist/'
} else {
    Write-Step '前端构建（vue-tsc + vite）'
    try {
        Invoke-Step 'npm run build' @('npm', 'run', 'build')
    } catch {
        Write-Fail '前端构建失败：类型错误或打包错误，请按上面输出修复'
        Wait-KeyPress; exit 1
    }
    if (-not (Test-Path (Join-Path $Root 'dist\index.html'))) {
        Write-Fail '构建结束但 dist/index.html 不存在'
        Wait-KeyPress; exit 1
    }
    Write-Ok 'dist/ 构建完成'
}

# ---------------------------------------------------------------- 2. ABI 重建
Write-Step '原生模块切换到 Electron ABI'

$cacheRoot = Join-Path $env:LOCALAPPDATA 'electron\Cache'
Write-Log "  Electron 缓存目录：$cacheRoot" 'DarkGray'
Write-Log '  这一步会重新编译 better-sqlite3 / sqlite3，首次可能需要几分钟（下载 Electron headers）...' 'DarkGray'

$abiOk = $true
try {
    Invoke-Step 'npm run electron:rebuild' @('npm', 'run', 'electron:rebuild')
} catch {
    $abiOk = $false
    Write-Warn 'ABI 重建首次失败'
}

if (-not $abiOk) {
    Write-Step 'ABI 重建重试（预热 Electron headers）'
    Write-Log "  常见原因：Electron headers 下载失败或残留缓存。清理后重试一次。" 'DarkGray'
    if (Test-Path $cacheRoot) {
        Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "$electronVersion*" } |
            ForEach-Object {
                Write-Log "  清理 $($_.FullName)" 'DarkGray'
                Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
    }
    try {
        Invoke-Step 'npm run electron:rebuild（重试）' @('npm', 'run', 'electron:rebuild')
    } catch {
        Write-Fail 'ABI 重建失败。请检查：'
        Write-Fail '  1) Python 3 与 VS C++ 生成工具是否安装'
        Write-Fail '  2) 是否有代理/网络拦截 github.com 与 nodejs.org'
        Write-Fail '  3) 手动执行：npx electron-rebuild -f -o better-sqlite3,sqlite3 -m server'
        Wait-KeyPress; exit 1
    }
}
Write-Ok '原生模块已编译为 Electron ABI'

# ---------------------------------------------------------------- 3. 自检
Write-Step '打包前自检（npm run check:win）'
$selfCheckOk = $true
try {
    Invoke-Step 'npm run check:win' @('npm', 'run', 'check:win')
} catch {
    $selfCheckOk = $false
}

if (-not $selfCheckOk) {
    Write-Fail '自检未通过，已中止打包。请按上面 ❌ 项修复后重跑本脚本。'
    Write-Fail '如果 ABI 仍不匹配，手动执行：npm run electron:rebuild'
    Wait-KeyPress; exit 1
}
Write-Ok '自检全部通过'

# ---------------------------------------------------------------- 4. 打包
Write-Step 'electron-builder 打包（Windows x64 / NSIS）'
Write-Log '  首次打包需要下载 winCodeSign / nsis 等工具，耗时较长...' 'DarkGray'
try {
    Invoke-Step 'electron-builder --win' @('npx', 'electron-builder', '--win')
} catch {
    Write-Fail '打包失败。常见原因：'
    Write-Fail '  1) 网络无法访问 github.com（electron-builder 下载工具链）'
    Write-Fail '  2) 杀软锁定 release/win-unpacked 中的 exe，先关闭占用再重试'
    Write-Fail '  3) 手动重试：npx electron-builder --win'
    Wait-KeyPress; exit 1
}

# ---------------------------------------------------------------- 5. 产物校验
Write-Step '产物校验'

$releaseDir  = Join-Path $Root 'release'
$unpackedDir = Join-Path $releaseDir 'win-unpacked'
$installers  = @()
if (Test-Path $releaseDir) {
    $installers = Get-ChildItem $releaseDir -Filter '*.exe' -File |
        Where-Object { $_.Name -notlike '*unpacked*' }
}

if ($installers.Count -eq 0) {
    Write-Fail "release/ 下未找到安装包（*.exe）"
    Wait-KeyPress; exit 1
}

foreach ($f in $installers) {
    Write-Ok ("安装包：{0}（{1:N1} MB）" -f $f.Name, ($f.Length / 1MB))
}

$expected = @(
    'QC Book Log.exe',
    'resources\app.asar',
    'resources\dist\index.html',
    'resources\server\app.js',
    'resources\server\package.json',
    'resources\server\node_modules\better-sqlite3',
    'resources\server\node_modules\sqlite3'
)
if (Test-Path $unpackedDir) {
    foreach ($rel in $expected) {
        $p = Join-Path $unpackedDir $rel
        if (Test-Path $p) {
            Write-Ok "存在 $rel"
        } else {
            Write-Warn "缺少 $rel（请检查 electron-builder 配置）"
        }
    }

    $asar = Join-Path $unpackedDir 'resources\app.asar'
    if (Test-Path $asar) {
        $asarSize = (Get-Item $asar).Length
        if ($asarSize -gt 5MB) {
            Write-Warn ("app.asar {0:N1} MB 偏大，确认 files 含 !node_modules/**" -f ($asarSize / 1MB))
        } else {
            Write-Ok ("app.asar {0:N0} KB" -f ($asarSize / 1KB))
        }
    }

    $envLeak = Get-ChildItem (Join-Path $unpackedDir 'resources\server') -Filter '.env' -File -Recurse -ErrorAction SilentlyContinue
    if ($envLeak) {
        Write-Warn ".env 被打进包内：$($envLeak.FullName)"
    } else {
        Write-Ok '未发现 .env 泄露'
    }
} else {
    Write-Warn '未找到 release/win-unpacked，跳过结构校验'
}

# ---------------------------------------------------------------- 汇总
Write-Step '完成'

if ($script:Warnings.Count -gt 0) {
    Write-Log "警告 $($script:Warnings.Count) 条：" 'Yellow'
    foreach ($w in $script:Warnings) { Write-Log "  - $w" 'Yellow' }
}

Write-Log ''
Write-Log '下一步请按 WINDOWS_BUILD.md 第五节实机验证：' 'White'
Write-Log '  1. 双击 release 下的安装包安装，启动后确认主界面正常、日志无 NODE_MODULE_VERSION 报错'
Write-Log '  2. 新增一条书摘 -> 关闭 -> 卸载 -> 重装 -> 确认书摘仍在（数据在 %APPDATA%\QC-booklog\data）'
Write-Log '  3. 菜单 设置 -> 允许手机访问，首次会弹 Windows 防火墙，点允许'
Write-Log '  4. 手机同 Wi-Fi 打开 http://PC局域网IP:端口?t=口令，验证可浏览、/api/config 返回 404'
Write-Log '  5. 重启应用，确认口令不变（来自 settings.json）'
Write-Log "  6. 取消勾选手机访问，确认手机立即无法访问"
Write-Log ''
Write-Log "日志已保存：$LogFile" 'DarkGray'

if ($OpenOutput) {
    Start-Process explorer.exe $releaseDir
}

Write-Log '按任意键退出...' 'DarkGray'
try { [void]$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
exit 0
