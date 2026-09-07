# DSH 插件本地开发

需求：将本地 `dsh-issue2pr` 接入 DSH，修改插件代码后无需重新安装。

方法：使用 `link:` 将 DSH `web` profile 直接链接到本地插件目录。

第一步：删除旧依赖。

```powershell
cd C:\Users\ZHUANG\Desktop\Project\Research_agent\deepseek-harness
pnpm run dsh -- plugin --profile web remove dsh-issue2pr
```

第二步：链接本地插件。

```powershell
$Plugin = "C:\Users\ZHUANG\Desktop\Project\Research_agent\dsh-issue2pr"
pnpm run dsh -- plugin --profile web add "link:$Plugin"
```

第三步：检查 DSH 是否已指向当前本地插件目录。

```powershell
Get-Item "$HOME\.dsh\profiles\web\node_modules\dsh-issue2pr" |
    Format-List FullName,LinkType,Target
Get-Content "$HOME\.dsh\profiles\web\package.json"
```

正确结果：`LinkType` 应为 `Junction`，`Target` 应指向当前本地插件目录。

```text
LinkType : Junction
Target   : C:\Users\ZHUANG\Desktop\Project\Research_agent\dsh-issue2pr
```

`package.json` 中应包含本地 `link:` 依赖。

```json
"dsh-issue2pr": "link:C:\\Users\\ZHUANG\\Desktop\\Project\\Research_agent\\dsh-issue2pr"
```

